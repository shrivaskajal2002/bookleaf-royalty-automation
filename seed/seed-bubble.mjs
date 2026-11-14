// Loads bookleaf_sample_data.json into Bubble through the Data API.
//
//   node seed/seed-bubble.mjs --dry-run              # show what would be created, plus computed statuses
//   BUBBLE_APP_URL=https://<app>.bubbleapps.io/version-test \
//   BUBBLE_API_TOKEN=<admin token> node seed/seed-bubble.mjs
//
// Safe to run again: records are matched by author_code / book_code / reference, and only the
// missing ones are created. Nothing is deleted.
//
// Bubble prerequisites (see docs/BUBBLE_BUILD_GUIDE.md, section 1 and section 7):
//   Settings → API → "Enable Data API" with Author, Book and RoyaltyPayout ticked, and an API token generated.
//
// Not done here: login accounts. Bubble's Data API cannot set passwords, so author and admin users are
// created in the app (Admin → "Author accounts"), which also fills the owner_user fields that the
// privacy rules use.
import { createRequire } from 'node:module';
import { buildRecords, dataset, strip } from './records.mjs';

const require = createRequire(import.meta.url);
const R = require('../n8n/src/lib/royalty.js');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const todayArg = args.find((a) => a.startsWith('--today='));
const TODAY = todayArg ? todayArg.split('=')[1] : new Date().toISOString().slice(0, 10);

const APP = (process.env.BUBBLE_APP_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.BUBBLE_API_TOKEN || '';



async function api(method, path, { body, text } = {}) {
  const res = await fetch(`${APP}/api/1.1/obj/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(text !== undefined ? { 'Content-Type': 'text/plain' } : body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: text !== undefined ? text : body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${raw.slice(0, 500)}`);
  return raw;
}

/** All records of a type as a map keyFieldValue → Bubble id (follows pagination). */
async function existing(type, keyField) {
  const map = {};
  let cursor = 0;
  for (;;) {
    const page = JSON.parse(await api('GET', `${type}?limit=100&cursor=${cursor}`)).response;
    page.results.forEach((r) => { if (r[keyField]) map[r[keyField]] = r._id; });
    if (!page.remaining) break;
    cursor += page.results.length;
  }
  return map;
}

/** Bulk create (one JSON object per line). Returns ids in input order. */
async function bulkCreate(type, records) {
  if (!records.length) return [];
  const raw = await api('POST', `${type}/bulk`, { text: records.map((r) => JSON.stringify(r)).join('\n') });
  const results = raw.trim().split('\n').map((l) => JSON.parse(l));
  const failed = results.filter((r) => r.status !== 'success');
  if (failed.length) throw new Error(`${type}/bulk: ${failed.length} failed, first error: ${JSON.stringify(failed[0])}`);
  return results.map((r) => r.id);
}

async function main() {
  const { authors, books, payouts } = buildRecords();

  if (DRY) {
    console.log(`Dry run, statuses as of ${TODAY}. Nothing is sent to Bubble.\n`);
    console.table(dataset.authors.map((a) => ({
      author: `${a.author_id} ${a.name}`,
      city: a.city,
      books: a.books.length,
      earned: R.fmtINR(R.authorTotals(a.books).total_earned),
      pending: R.fmtINR(R.authorTotals(a.books).total_pending),
      status: R.authorPayoutStatus(a.books, TODAY),
    })));
    console.table(dataset.authors.flatMap((a) => {
      const pending = R.authorTotals(a.books).total_pending;
      return a.books.map((b) => ({
        book: `${b.book_id} ${b.title}`,
        badge: R.bookBadge(b, pending, TODAY),
        overdue_on: R.isoDate(R.bookOverdueOn(b, pending)) || '-',
      }));
    }));
    console.log(`Would create up to ${authors.length} authors, ${books.length} books, ${payouts.length} payout records.`);
    return;
  }

  if (!APP || !TOKEN) {
    console.error('Set BUBBLE_APP_URL (e.g. https://yourapp.bubbleapps.io/version-test) and BUBBLE_API_TOKEN.');
    process.exit(1);
  }

  const authorIds = await existing('author', 'author_code');
  const newAuthors = authors.filter((a) => !authorIds[a.author_code]);
  (await bulkCreate('author', newAuthors.map(strip))).forEach((id, i) => { authorIds[newAuthors[i].author_code] = id; });
  console.log(`Authors: ${newAuthors.length} created, ${authors.length - newAuthors.length} already there.`);

  const bookIds = await existing('book', 'book_code');
  const newBooks = books.filter((b) => !bookIds[b.book_code]);
  (await bulkCreate('book', newBooks.map((b) => ({ ...strip(b), author: authorIds[b._author_code] }))))
    .forEach((id, i) => { bookIds[newBooks[i].book_code] = id; });
  console.log(`Books: ${newBooks.length} created, ${books.length - newBooks.length} already there.`);

  const payoutIds = await existing('royaltypayout', 'reference');
  const newPayouts = payouts.filter((p) => !payoutIds[p.reference]);
  await bulkCreate('royaltypayout', newPayouts.map((p) => ({ ...strip(p), author: authorIds[p._author_code], book: bookIds[p._book_code] })));
  console.log(`Payouts: ${newPayouts.length} created, ${payouts.length - newPayouts.length} already there.`);

  console.log('\nNext: log in as admin, open "Author accounts" and click "Create all logins" (see the build guide, section 7).');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
