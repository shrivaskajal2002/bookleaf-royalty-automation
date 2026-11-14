// Builds the importable n8n workflow JSON from the sources in n8n/src.
//
// Why a build step: the Code node logic lives in normal .js files so it can be unit-tested
// (see tests/) and reviewed with syntax highlighting. This script inlines the shared libs and
// the system prompt into each Code node and writes the export that n8n imports.
//
//   node n8n/build-workflow.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, 'src', p), 'utf8');

const LIBS = {
  royalty: src('lib/royalty.js'),
  bubble: src('lib/bubble.js'),
  ai: src('lib/ai.js'),
};
const stripExports = (code) => code.split('// --- exports (stripped in build) ---')[0].trimEnd();
const SYSTEM_PROMPT = src('prompt-system.md').trim();

function code(file) {
  let body = src(`nodes/${file}`);
  body = body.replace(/^\/\/@include (\w+)\s*$/gm, (_, name) => {
    if (!LIBS[name]) throw new Error(`Unknown include ${name} in ${file}`);
    return `// ---- inlined from n8n/src/lib/${name}.js ----\n${stripExports(LIBS[name])}\n// ---- end ${name}.js ----`;
  });
  body = body.replace('__SYSTEM_PROMPT__', JSON.stringify(SYSTEM_PROMPT));
  // Fail the build on syntax errors instead of finding out after importing into n8n.
  new Function('$', '$input', '$execution', '$getWorkflowStaticData', body); // eslint-disable-line no-new-func
  return body;
}

// Stable ids so rebuilding does not produce a noisy diff.
const stableId = (name) => {
  const h = createHash('sha1').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const nodes = [];
const connections = {};
const node = (name, type, typeVersion, position, parameters, extra = {}) => {
  nodes.push({ parameters, id: stableId(name), name, type, typeVersion, position, ...extra });
  return name;
};
// connect(from, to, outputIndex)
const connect = (from, to, output = 0) => {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
};

const CRED = {
  webhook: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'BookLeaf Webhook Key' } },
  ai: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'AI API Key' } },
  smtp: { smtp: { id: 'REPLACE_ME', name: 'SMTP account' } },
};

const codeNode = (name, file, pos, extra = {}) =>
  node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: code(file) }, extra);

const ifNode = (name, pos, leftValue) => node(name, 'n8n-nodes-base.if', 2, pos, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: stableId(`${name}-cond`), leftValue, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});

const respond = (name, pos, code, bodyExpr) => node(name, 'n8n-nodes-base.respondToWebhook', 1.1, pos, {
  respondWith: 'json',
  responseBody: bodyExpr,
  options: { responseCode: code },
});

const stop = (name, pos, message) => node(name, 'n8n-nodes-base.stopAndError', 1, pos, { errorMessage: message });

const cfg = (key) => `$('Config').first().json.${key}`;

const sticky = (name, pos, width, height, content, color = 7) =>
  node(name, 'n8n-nodes-base.stickyNote', 1, pos, { content, width, height, color });

// Every handled outcome answers Bubble with HTTP 200 and the same JSON shape (lib/bubble.js →
// summaryResponse), so Bubble's API Connector maps one schema and the Bubble workflow copies
// `status` (Success / Failed / Skipped) and the other fields straight into the Notification Log.
// Only problems n8n can't answer (wrong key → 403, n8n down, timeout) reach Bubble as HTTP errors,
// and Bubble marks the log Failed for those itself.
const reply = (name, pos) => respond(name, pos, 200, '={{ JSON.stringify($json.response) }}');

// ---------------------------------------------------------------- layout
const Y = 300;        // happy path
const Y_TOP = 40;     // early answers (bad payload, duplicate)
const Y_FAIL = 760;   // failure handling

sticky('Note: Intake', [-60, -200], 1340, 1080,
  '## 1. Intake and security\nThe webhook only accepts calls with the **X-BookLeaf-Key** header (Header Auth credential); anything else is rejected by n8n (403).\n\nBubble\'s free plan blocks inbound API calls, so **Bubble sends the author\'s full data** (author, books, payouts) in the body and **n8n replies in the same request**. Validate Payload checks every field before any AI spend.\n\n**Idempotency:** a log_id already processed, or a second request for the same author within 2 minutes, is answered **Skipped**.', 7);
sticky('Note: Generate', [1300, -200], 1980, 820,
  '## 2. Generate and deliver\nTotals, payout dates and the payout situation are calculated in **Build Royalty Context** (code, not AI). The AI (Gemini free tier by default, or Claude) only writes the wording, as JSON (subject + body). **Parse & Validate** rejects any email that drops a book or total, or quotes an amount that is not in the data, then retries once with the validator\'s notes. Optional SMTP sends the real email (bonus). The result goes back to Bubble as **Success** with the email text.', 4);
sticky('Note: Failure', [1300, 640], 1980, 400,
  '## 3. Failure handling\nEvery step after the gate sends its **error output** here. The handler names the failing step, releases the per-author lock, and answers Bubble with **Failed** + a readable reason (and the email text if it was already generated). The run then ends with **Stop and Error**, so the execution shows as failed in n8n and the error workflow alerts ops. Nothing fails silently.', 3);

const webhook = node('Webhook', 'n8n-nodes-base.webhook', 2, [0, Y], {
  httpMethod: 'POST',
  path: 'bookleaf-royalty-summary',
  authentication: 'headerAuth',
  responseMode: 'responseNode',
  options: {},
}, { webhookId: stableId('bookleaf-royalty-summary-webhook'), credentials: CRED.webhook });

const config = codeNode('Config', 'config.js', [220, Y]);
const validate = codeNode('Validate Payload', 'validate-payload.js', [440, Y]);
const valid = ifNode('Payload Valid?', [660, Y], '={{ $json.ok }}');
const rBad = reply('Respond: Bad Payload (Failed)', [880, Y_TOP]);

const gate = codeNode('Idempotency Gate', 'idempotency-gate.js', [880, Y]);
const proceed = ifNode('Proceed?', [1100, Y], '={{ $json.proceed }}');
const rSkip = reply('Respond: Duplicate (Skipped)', [1320, Y_TOP]);

const buildCtx = codeNode('Build Royalty Context', 'build-context.js', [1400, Y], { onError: 'continueErrorOutput' });

const claude = node('AI: Generate Email', 'n8n-nodes-base.httpRequest', 4.2, [1620, Y], {
  method: 'POST',
  // URL and body come from lib/ai.js (Gemini or Anthropic, set in Config). The Anthropic headers
  // below are ignored by Gemini.
  url: '={{ $json.url }}',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'anthropic-version', value: '2026-10-21' },
      // Server-side fallback: if the model declines on a policy check, the API retries on a fallback model.
      { name: 'anthropic-beta', value: 'server-side-fallback-2026-07-01' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.request) }}',
  // Bubble is waiting on the open request, so keep the worst case well inside its timeout.
  options: { timeout: 60000 },
}, {
  credentials: CRED.ai,
  retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
  onError: 'continueErrorOutput',
});

const parse = codeNode('Parse & Validate Email', 'parse-email.js', [1840, Y], { onError: 'continueErrorOutput' });
const emailOk = ifNode('Email Valid?', [2060, Y], '={{ $json.ok }}');
const retry = ifNode('Retry AI?', [2060, 520], '={{ $json.retryable && $json.attempt < $json.max_attempts }}');
const buildRetry = codeNode('Build Retry Request', 'build-retry.js', [1620, 520]);

const sendEmail = ifNode('Send Real Email?', [2280, Y], `={{ ${cfg('SEND_EMAIL')} }}`);
const smtp = node('Send Email (SMTP)', 'n8n-nodes-base.emailSend', 2.1, [2500, 140], {
  fromEmail: `={{ ${cfg('EMAIL_FROM')} }}`,
  toEmail: '={{ $json.recipient }}',
  subject: '={{ $json.subject }}',
  emailFormat: 'text',
  text: '={{ $json.body }}',
  options: { appendAttribution: false },
}, { credentials: CRED.smtp, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueErrorOutput' });

const prepSuccess = codeNode('Prepare Success Response', 'prepare-success.js', [2720, Y]);
const rSuccess = reply('Respond: Success', [2940, Y]);

const buildFailure = codeNode('Build Failure Response', 'build-failure.js', [1840, Y_FAIL]);
const rFailed = reply('Respond: Failed', [2060, Y_FAIL]);
const stopFailed = stop('Stop: Mark Execution Failed', [2280, Y_FAIL],
  '={{ "Royalty summary failed at \\"" + $("Build Failure Response").first().json.failed_step + "\\": " + $("Build Failure Response").first().json.error_message }}');

// ---------------------------------------------------------------- wiring
connect(webhook, config);
connect(config, validate);
connect(validate, valid);
connect(valid, gate, 0);
connect(valid, rBad, 1);
connect(gate, proceed);
connect(proceed, buildCtx, 0);
connect(proceed, rSkip, 1);
connect(buildCtx, claude, 0);
connect(buildCtx, buildFailure, 1);
connect(claude, parse, 0);
connect(claude, buildFailure, 1);
connect(parse, emailOk, 0);
connect(parse, buildFailure, 1);
connect(emailOk, sendEmail, 0);
connect(emailOk, retry, 1);
connect(retry, buildRetry, 0);
connect(retry, buildFailure, 1);
connect(buildRetry, claude);
connect(sendEmail, smtp, 0);
connect(sendEmail, prepSuccess, 1);
connect(smtp, prepSuccess, 0);
connect(smtp, buildFailure, 1);
connect(prepSuccess, rSuccess);
connect(buildFailure, rFailed);
connect(rFailed, stopFailed);

const workflow = {
  name: 'BookLeaf: Royalty Summary (AI)',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};
writeFileSync(join(here, 'bookleaf_royalty_summary.workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);

// ---------------------------------------------------------------- error workflow
// Catches anything that ends an execution with an error (including the Stop and Error nodes above)
// and emails the ops team with a link to the failed execution.
const errorWorkflow = {
  name: 'BookLeaf: Workflow Error Alerts',
  nodes: [
    { parameters: {}, id: stableId('err-trigger'), name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 300] },
    {
      parameters: {
        jsCode: [
          '// Build a short alert from the failed execution.',
          'const e = $input.first().json;',
          'const ex = e.execution || {};',
          'return [{ json: {',
          '  subject: `[n8n] ${e.workflow?.name || "Workflow"} failed`,',
          '  text: [',
          '    `Workflow: ${e.workflow?.name}`,',
          '    `Execution: ${ex.id} (${ex.mode})`,',
          '    `Last node: ${ex.lastNodeExecuted}`,',
          '    `Error: ${ex.error?.message}`,',
          '    `Open: ${ex.url || "n/a"}`,',
          '  ].join("\\n"),',
          '} }];',
        ].join('\n'),
      },
      id: stableId('err-format'), name: 'Format Alert', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 300],
    },
    {
      parameters: {
        fromEmail: 'n8n alerts <alerts@example.com>',
        toEmail: 'ops@example.com',
        subject: '={{ $json.subject }}',
        emailFormat: 'text',
        text: '={{ $json.text }}',
        options: { appendAttribution: false },
      },
      id: stableId('err-email'), name: 'Email Ops Team', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [440, 300],
      credentials: CRED.smtp, disabled: true,
      notes: 'Enable after adding SMTP credentials. Until then the alert is visible in this workflow\'s executions.',
    },
  ],
  connections: {
    'Error Trigger': { main: [[{ node: 'Format Alert', type: 'main', index: 0 }]] },
    'Format Alert': { main: [[{ node: 'Email Ops Team', type: 'main', index: 0 }]] },
  },
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
  tags: [],
};
writeFileSync(join(here, 'bookleaf_error_alerts.workflow.json'), `${JSON.stringify(errorWorkflow, null, 2)}\n`);

console.log(`Built ${nodes.length} nodes -> n8n/bookleaf_royalty_summary.workflow.json`);
console.log('Built error workflow -> n8n/bookleaf_error_alerts.workflow.json');
