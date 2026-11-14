// Generates the royalty email for one author straight from the dataset, using the same facts,
// system prompt, schema and validator as the n8n workflow. Use it to iterate on the prompt
// without going through Bubble and n8n.
//
//   ANTHROPIC_API_KEY=... node tools/preview-email.mjs AUTH009 [--today=2026-01-10] [--model=claude-haiku-5-5]
//   node tools/preview-email.mjs all            # every author, writes samples/*.txt
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('../n8n/src/lib/royalty.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(readFileSync(join(root, 'data', 'bookleaf_sample_data.json'), 'utf8'));
const SYSTEM_PROMPT = readFileSync(join(root, 'n8n', 'src', 'prompt-system.md'), 'utf8').trim();

const args = process.argv.slice(2);
const opt = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) || `=${def}`).split('=')[1];
const TODAY = opt('today', new Date().toISOString().slice(0, 10));
const MODEL = opt('model', 'claude-opus-5-5');
const target = args.find((a) => !a.startsWith('--')) || 'AUTH001';

const EMAIL_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

const client = new Anthropic();

async function generate(userText) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: EMAIL_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Model declined the request');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

async function preview(author) {
  const context = R.buildAuthorContext(author, author.books, [], TODAY);
  const userText = `Write the royalty summary email for this author.\n\n<facts>\n${JSON.stringify(context.facts, null, 2)}\n</facts>`;
  let email = await generate(userText);
  let problems = R.validateEmail(email, context);
  let attempts = 1;
  if (problems.length) {
    attempts = 2;
    email = await generate(`${userText}\n\nA previous draft was rejected by our automated checks:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n<rejected_draft>\n${JSON.stringify(email, null, 2)}\n</rejected_draft>\n\nWrite a corrected email. Copy amounts, titles and dates exactly from the facts.`);
    problems = R.validateEmail(email, context);
  }
  return { situation: context.facts.payout.situation, email, problems, attempts };
}

const authors = target === 'all' ? dataset.authors : dataset.authors.filter((a) => a.author_id === target);
if (!authors.length) { console.error(`No author ${target}`); process.exit(1); }
if (target === 'all') mkdirSync(join(root, 'samples'), { recursive: true });

for (const author of authors) {
  const { situation, email, problems, attempts } = await preview(author);
  const out = [
    `Author: ${author.author_id} ${author.name} | situation: ${situation} | as of ${TODAY} | model: ${MODEL} | attempts: ${attempts}`,
    `Validator: ${problems.length ? `FAILED: ${problems.join('; ')}` : 'passed'}`,
    '',
    `Subject: ${email.subject}`,
    '',
    email.body,
    '',
  ].join('\n');
  console.log(`${out}\n${'-'.repeat(80)}`);
  if (target === 'all') writeFileSync(join(root, 'samples', `${author.author_id}.txt`), out);
}
