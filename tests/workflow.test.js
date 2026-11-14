// Runs the Code nodes from the BUILT workflow JSON (the exact code n8n will run) with a small
// mock of n8n's globals ($, $input, $execution, $getWorkflowStaticData). It covers the main paths:
// payload → generate → Success response, duplicates (Skipped), a bad AI draft → retry, and Failed responses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'n8n/build-workflow.mjs')]);
const wf = require('../n8n/bookleaf_royalty_summary.workflow.json');
const data = require('../data/bookleaf_sample_data.json');
const R = require('../n8n/src/lib/royalty.js');

const codeOf = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, `node ${name} exists`);
  return n.parameters.jsCode;
};

/** A tiny n8n runtime: `outputs` maps node name → json of its (single) output item. */
function makeRuntime(staticData = {}) {
  const outputs = {};
  const $ = (name) => {
    if (!wf.nodes.some((n) => n.name === name)) throw new Error(`Referenced node "${name}" does not exist`);
    return {
      first: () => ({ json: outputs[name] }),
      last: () => ({ json: outputs[name] }),
      get isExecuted() { return name in outputs; },
    };
  };
  const run = (name, inputJson) => {
    const fn = new Function('$', '$input', '$execution', '$getWorkflowStaticData', codeOf(name));
    const out = fn($, { first: () => ({ json: inputJson }), all: () => [{ json: inputJson }] }, { id: 'exec-1' }, () => staticData);
    outputs[name] = out[0].json;
    return out[0].json;
  };
  return { outputs, run, set: (name, json) => { outputs[name] = json; } };
}

const AUTHOR_ID = '1700000000000x100000000000000001';
const LOG_ID = '1700000000000x900000000000000001';

/** A date picked in Bubble in India (midnight IST) as Bubble's `:extract UNIX` sends it. */
const istMidnightUnix = (ymd) => (ymd ? String(Date.parse(`${ymd}T00:00:00+05:30`)) : '');

/** The webhook body exactly as the Bubble API Connector sends it: every value is text. */
function bubblePayload(authorCode, { booksAsString = false, logId = LOG_ID } = {}) {
  const a = data.authors.find((x) => x.author_id === authorCode);
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  const books = a.books.map((b) => ({
    book_code: b.book_id, title: b.title, isbn: s(b.isbn), genre: s(b.genre), stage: b.status,
    publication_date: istMidnightUnix(b.publication_date), mrp: s(b.mrp), royalty_per_copy: s(b.author_royalty_per_copy),
    copies_sold: s(b.total_copies_sold), royalty_earned: s(b.total_royalty_earned), royalty_paid: s(b.royalty_paid),
    royalty_pending: s(b.royalty_pending), last_payout_date: istMidnightUnix(b.last_royalty_payout_date),
    print_partner: s(b.print_partner), available_on: (b.available_on || []).join(', '),
  }));
  const payouts = a.books.filter((b) => b.royalty_paid > 0 && b.last_royalty_payout_date)
    .map((b) => ({ book_title: b.title, amount: s(b.royalty_paid), payout_date: istMidnightUnix(b.last_royalty_payout_date) }));
  return {
    log_id: logId, source: 'single',
    author: { id: AUTHOR_ID, author_code: a.author_id, name: a.name, email: a.email, city: a.city },
    books: booksAsString ? books.map((b) => JSON.stringify(b)).join(',') : books,
    payouts,
  };
}

/** Writes a correct email from the facts, the way a well-behaved model would. */
function goodEmailFrom(facts) {
  const lines = [`Dear ${facts.author.first_name},`, '', 'Here is your royalty summary from BookLeaf.', ''];
  facts.published_books.forEach((b) => lines.push(`${b.title}: ${b.copies_sold} copies sold, ${b.royalty_earned} earned, ${b.royalty_paid} paid, ${b.royalty_pending} pending. Last payout: ${b.last_payout_date}.`));
  lines.push('', `Total earned: ${facts.totals.total_earned}`, `Total paid: ${facts.totals.total_paid}`, `Total pending: ${facts.totals.total_pending}`, '');
  if (facts.payout.situation === 'PENDING_ON_SCHEDULE') lines.push(`Expected by ${facts.payout.next_payout_deadline}.`);
  facts.books_in_production.forEach((b) => lines.push(`${b.title} is in ${b.current_stage}.`));
  lines.push('', 'Warm regards,', 'The BookLeaf Team');
  return { subject: 'Your BookLeaf royalty summary', body: lines.join('\n') };
}

// Gemini is the default provider (free tier). Responses in its REST shape:
const geminiResponse = (email, finishReason = 'STOP') => ({
  modelVersion: 'gemini-4-hydrogen',
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(email) }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
});
const claudeResponse = (email) => ({
  model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(email) }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

function acceptRequest(rt, body = bubblePayload('AUTH001')) {
  rt.set('Webhook', { body });
  rt.run('Config', {});
  return rt.run('Validate Payload', {});
}

const RESPONSE_KEYS = ['ok', 'status', 'log_id', 'email_subject', 'email_body', 'email_sent', 'recipient',
  'error_message', 'failed_step', 'ai_model', 'n8n_execution_id', 'completed_at'];

test('every $("...") reference in Code nodes points at a real node', () => {
  const names = new Set(wf.nodes.map((n) => n.name));
  wf.nodes.filter((n) => n.parameters.jsCode).forEach((n) => {
    for (const m of n.parameters.jsCode.matchAll(/\$\('([^']+)'\)/g)) {
      assert.ok(names.has(m[1]), `${n.name} references missing node "${m[1]}"`);
    }
  });
});

test('every connection points at a real node, and no node calls Bubble', () => {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, { main }] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), from);
    main.flat().forEach((c) => assert.ok(names.has(c.node), `${from} -> ${c.node}`));
  }
  // Bubble's free plan blocks inbound API calls, so the workflow must not depend on them.
  assert.ok(!JSON.stringify(wf).includes('bubbleapps.io'));
});

test('every respond node returns the shared response shape', () => {
  const responders = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  assert.equal(responders.length, 4);
  responders.forEach((n) => assert.equal(n.parameters.responseBody, '={{ JSON.stringify($json.response) }}'));
});

test('payload validation rejects junk and answers Failed with the reason', () => {
  const rt = makeRuntime();
  const v = acceptRequest(rt, { log_id: '', author: { id: 'AUTH001', name: '', email: 'nope' }, books: 'not json' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 4, v.errors.join('; '));
  assert.equal(v.response.status, 'Failed');
  assert.equal(v.response.failed_step, 'Validate Payload');
  assert.deepEqual(Object.keys(v.response), RESPONSE_KEYS);
});

test('payload: Bubble text values become numbers, IST dates stay on the same calendar day', () => {
  const rt = makeRuntime();
  const v = acceptRequest(rt, bubblePayload('AUTH001', { booksAsString: true }));
  assert.equal(v.ok, true, v.errors.join('; '));
  const bk = v.books.find((b) => b.book_id === 'BK001');
  assert.equal(bk.publication_date, '2023-06-20');
  assert.equal(bk.last_royalty_payout_date, '2025-10-15');
  assert.equal(bk.total_royalty_earned, 11970);
  assert.deepEqual(bk.available_on, ['Amazon India', 'Flipkart', 'BookLeaf Store']);
  assert.equal(v.payouts[0].payout_date, '2025-10-15');
});

test('payload: a book whose money fields do not add up is rejected before any AI spend', () => {
  const rt = makeRuntime();
  const body = bubblePayload('AUTH001');
  body.books[0].royalty_pending = '9999';
  const v = acceptRequest(rt, body);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /earned ≠ paid \+ pending/);
});

test('happy path: context built from the payload, email validated, Success response', () => {
  const rt = makeRuntime();
  assert.equal(acceptRequest(rt, bubblePayload('AUTH007')).ok, true); // Sneha: 2 published (pending) + 1 in production
  assert.equal(rt.run('Idempotency Gate', {}).proceed, true);

  const ctx = rt.run('Build Royalty Context', {});
  assert.equal(ctx.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent');
  assert.equal(ctx.request.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(ctx.request.generationConfig.responseSchema.required, ['subject', 'body']);
  assert.equal(ctx.context.facts.books_in_production[0].title, 'Midnight in Mysore');
  assert.equal(ctx.context.facts.totals.total_pending, R.fmtINR(4175 + 3690));
  assert.equal(ctx.context.facts.recent_payouts.length, 2);

  const parsed = rt.run('Parse & Validate Email', geminiResponse(goodEmailFrom(ctx.context.facts)));
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.attempt, 1);
  assert.equal(parsed.model, 'gemini-4-hydrogen');

  const { response } = rt.run('Prepare Success Response', {});
  assert.deepEqual(Object.keys(response), RESPONSE_KEYS);
  assert.equal(response.status, 'Success');
  assert.equal(response.ok, true);
  assert.equal(response.log_id, LOG_ID);
  assert.equal(response.email_sent, false);
  assert.equal(response.recipient, 'sneha.kulkarni@email.com');
  assert.ok(response.email_body.includes('Midnight in Mysore'));
});

test('idempotency: a replayed log_id and a second request for the same author are Skipped', () => {
  const store = {};
  const rt = makeRuntime(store);
  acceptRequest(rt);
  assert.equal(rt.run('Idempotency Gate', {}).proceed, true);

  const replay = rt.run('Idempotency Gate', {}); // same log_id again
  assert.equal(replay.proceed, false);
  assert.equal(replay.response.status, 'Skipped');
  assert.match(replay.response.error_message, /already processed/);

  acceptRequest(rt, bubblePayload('AUTH001', { logId: '1700000000000x900000000000000002' })); // double click → new log
  const second = rt.run('Idempotency Gate', {});
  assert.equal(second.proceed, false);
  assert.match(second.response.error_message, /started \d+s ago/);

  store.locks = {}; // lock expired, a genuinely new request goes through
  assert.equal(rt.run('Idempotency Gate', {}).proceed, true);
});

test('bad AI draft is rejected, retried with notes, and the retry is counted', () => {
  const rt = makeRuntime();
  acceptRequest(rt, bubblePayload('AUTH002'));
  const ctx = rt.run('Build Royalty Context', {});

  const bad = goodEmailFrom(ctx.context.facts);
  bad.body = bad.body.replace(ctx.context.facts.totals.total_pending, '₹13,000');
  const first = rt.run('Parse & Validate Email', geminiResponse(bad));
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.equal(first.attempt, 1);
  assert.ok(first.problems.some((p) => p.includes('₹13,000')));

  const retryReq = rt.run('Build Retry Request', first);
  assert.match(retryReq.request.contents[0].parts[0].text, /rejected by our automated checks/);
  assert.deepEqual(retryReq.request.systemInstruction, ctx.request.systemInstruction);
  assert.equal(retryReq.url, ctx.url);

  const second = rt.run('Parse & Validate Email', geminiResponse(goodEmailFrom(ctx.context.facts)));
  assert.equal(second.ok, true);
  assert.equal(second.attempt, 2);
});

test('safety blocks are not retried; truncated output is (both providers)', () => {
  const rt = makeRuntime();
  acceptRequest(rt);
  rt.run('Build Royalty Context', {});
  const g = rt.run('Parse & Validate Email', geminiResponse({}, 'SAFETY'));
  assert.deepEqual([g.ok, g.retryable], [false, false]);
  const blocked = rt.run('Parse & Validate Email', { promptFeedback: { blockReason: 'SAFETY' } });
  assert.deepEqual([blocked.ok, blocked.retryable], [false, false]);
  const cut = rt.run('Parse & Validate Email', geminiResponse({}, 'MAX_TOKENS'));
  assert.deepEqual([cut.ok, cut.retryable], [false, true]);
  const c = rt.run('Parse & Validate Email', { stop_reason: 'refusal', content: [] });
  assert.deepEqual([c.ok, c.retryable], [false, false]);
});

test('AI_PROVIDER anthropic builds a Claude request and parses Claude responses', () => {
  const rt = makeRuntime();
  rt.set('Webhook', { body: bubblePayload('AUTH007') });
  const cfg = rt.run('Config', {});
  rt.set('Config', { ...cfg, AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5' });
  rt.run('Validate Payload', {});
  const ctx = rt.run('Build Royalty Context', {});
  assert.equal(ctx.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ctx.request.model, 'claude-opus-5-5');
  assert.equal(ctx.request.output_config.format.type, 'json_schema');
  const parsed = rt.run('Parse & Validate Email', claudeResponse(goodEmailFrom(ctx.context.facts)));
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.model, 'claude-opus-5-5');
});

test('AI outage: failure handler names the step, releases the lock and answers Failed', () => {
  const store = { locks: { [AUTHOR_ID]: Date.now() } };
  const rt = makeRuntime(store);
  acceptRequest(rt);
  rt.set('Build Royalty Context', {});
  rt.set('AI: Generate Email', {});
  const fail = rt.run('Build Failure Response', { error: { message: 'Overloaded', httpCode: '529' } });
  assert.equal(fail.failed_step, 'AI: Generate Email');
  assert.match(fail.error_message, /AI service.*HTTP 529: Overloaded/);
  assert.deepEqual(Object.keys(fail.response), RESPONSE_KEYS);
  assert.equal(fail.response.status, 'Failed');
  assert.equal(fail.response.log_id, LOG_ID);
  assert.equal(store.locks[AUTHOR_ID], undefined);
});

test('SMTP failure keeps the generated email in the Failed response', () => {
  const rt = makeRuntime();
  acceptRequest(rt, bubblePayload('AUTH007'));
  const ctx = rt.run('Build Royalty Context', {});
  rt.set('AI: Generate Email', {});
  assert.equal(rt.run('Parse & Validate Email', geminiResponse(goodEmailFrom(ctx.context.facts))).ok, true);
  rt.set('Send Email (SMTP)', {});
  const fail = rt.run('Build Failure Response', { error: { message: 'Connection refused' } });
  assert.equal(fail.failed_step, 'Send Email (SMTP)');
  assert.ok(fail.response.email_body.length > 0);
  assert.equal(fail.response.email_sent, false);
});
