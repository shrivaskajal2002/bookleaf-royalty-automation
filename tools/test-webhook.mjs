// Calls the live n8n webhook the same way Bubble does, so you can test n8n before Bubble is wired up.
//
//   PowerShell:
//     $env:N8N_WEBHOOK_URL="https://<you>.app.n8n.cloud/webhook/bookleaf-royalty-summary"
//     $env:WEBHOOK_KEY="<the shared secret>"
//     node tools/test-webhook.mjs            # security + validation checks only (no AI cost)
//     node tools/test-webhook.mjs AUTH007    # plus one real summary for that author (one AI call)
//
// The author payload is built from data/bookleaf_sample_data.json in the same text format the
// Bubble API Connector sends.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, '..', 'data', 'bookleaf_sample_data.json'), 'utf8'));
const URL = process.env.N8N_WEBHOOK_URL;
const KEY = process.env.WEBHOOK_KEY;
if (!URL || !KEY) {
  console.error('Set N8N_WEBHOOK_URL and WEBHOOK_KEY first (see the top of this file).');
  process.exit(1);
}

const s = (v) => (v === null || v === undefined ? '' : String(v));
const fakeId = () => `${Date.now()}x${Math.floor(Math.random() * 1e15)}`;

function payload(code) {
  const a = data.authors.find((x) => x.author_id === code);
  if (!a) throw new Error(`No author ${code} in the dataset`);
  return {
    log_id: fakeId(),
    source: 'single',
    author: { id: `1700000000000x${a.author_id.replace(/\D/g, '')}`, author_code: a.author_id, name: a.name, email: a.email, city: a.city },
    books: a.books.map((b) => ({
      book_code: b.book_id, title: b.title, isbn: s(b.isbn), genre: s(b.genre), stage: b.status,
      publication_date: s(b.publication_date), mrp: s(b.mrp), royalty_per_copy: s(b.author_royalty_per_copy),
      copies_sold: s(b.total_copies_sold), royalty_earned: s(b.total_royalty_earned), royalty_paid: s(b.royalty_paid),
      royalty_pending: s(b.royalty_pending), last_payout_date: s(b.last_royalty_payout_date),
      print_partner: s(b.print_partner), available_on: (b.available_on || []).join(', '),
    })),
    payouts: a.books.filter((b) => b.royalty_paid > 0 && b.last_royalty_payout_date)
      .map((b) => ({ book_title: b.title, amount: s(b.royalty_paid), payout_date: b.last_royalty_payout_date })),
  };
}

async function call(name, expect, { key = KEY, body }) {
  const t = Date.now();
  let status = 'ERR';
  let text = '';
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-BookLeaf-Key': key } : {}) },
      body: JSON.stringify(body),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    text = e.message;
  }
  let summary = text.slice(0, 140);
  try {
    const j = JSON.parse(text);
    summary = `status=${j.status} ${j.error_message || j.email_subject || ''}`.slice(0, 140);
  } catch (e) { /* not JSON */ }
  const pass = expect(status, text);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} HTTP ${status}  ${((Date.now() - t) / 1000).toFixed(1)}s  ${summary}`);
  return text;
}

const json = (t) => { try { return JSON.parse(t); } catch (e) { return {}; } };

await call('no key → rejected', (st) => st === 401 || st === 403, { key: '', body: payload('AUTH001') });
await call('wrong key → rejected', (st) => st === 401 || st === 403, { key: 'wrong', body: payload('AUTH001') });
await call('bad payload → Failed', (st, t) => st === 200 && json(t).status === 'Failed', { body: { log_id: 'x', author: {} } });

const code = process.argv[2];
if (code) {
  const body = payload(code);
  const first = call(`real summary for ${code}`, (st, t) => st === 200 && json(t).status === 'Success', { body });
  await new Promise((r) => setTimeout(r, 1500));
  // A double click: new log_id, same author, while the first is still running.
  await call('double click → Skipped', (st, t) => st === 200 && json(t).status === 'Skipped', { body: { ...body, log_id: fakeId() } });
  const text = await first;
  const j = json(text);
  if (j.email_body) console.log(`\n--- ${j.email_subject} ---\n${j.email_body}\n`);
}
