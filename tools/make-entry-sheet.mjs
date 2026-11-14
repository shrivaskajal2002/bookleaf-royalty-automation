// Writes data/manual_entry.txt: every Author, Book and RoyaltyPayout record with its exact field values,
// for typing into Bubble's App data editor (the free plan blocks both the Data API and CSV upload).
// Values come from seed/records.mjs, the same builder the API loader uses.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecords } from '../seed/records.mjs';

const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const date = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${M[+m - 1]} ${+d}, ${y}`; };
const fmt = (v) => (Array.isArray(v) ? v.join(', ') : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? date(v) : String(v));
const block = (title, rec, skip = []) => [title, ...Object.entries(rec)
  .filter(([k, v]) => !k.startsWith('_') && !skip.includes(k) && v !== undefined && v !== null)
  .map(([k, v]) => `  ${k} = ${fmt(v)}`)].join('\n');

const { authors, books, payouts } = buildRecords();
const nameOf = Object.fromEntries(authors.map((a) => [a.author_code, a.name]));
const titleOf = Object.fromEntries(books.map((b) => [b.book_code, b.title]));

const out = [
  '=== AUTHORS (create these first) ===',
  ...authors.map((a, i) => block(`Author ${i + 1}`, a)),
  '',
  '=== BOOKS (author = pick the Author with this name) ===',
  ...books.map((b, i) => block(`Book ${i + 1}`, { author: `${nameOf[b._author_code]} (${b._author_code})`, ...b })),
  '',
  '=== ROYALTY PAYOUTS (author / book = pick the existing record) ===',
  ...payouts.map((p, i) => block(`Payout ${i + 1}`, {
    author: `${nameOf[p._author_code]} (${p._author_code})`, book: `${titleOf[p._book_code]} (${p._book_code})`, ...p,
  })),
  '',
  'Leave empty (filled later when logins are created): Author.user, Book.owner_user, RoyaltyPayout.owner_user,',
  'Author.last_summary_at, Author.last_summary_status. Fields not listed for a record stay empty.',
].join('\n\n');

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'manual_entry.txt');
writeFileSync(file, out + '\n', 'utf8');
console.log(`wrote data/manual_entry.txt: ${authors.length} authors, ${books.length} books, ${payouts.length} payouts`);
