// Writes CSV files for Bubble's App data → Upload (the free plan blocks the Data API, so the seed script
// can't run there). Same records as seed/seed-bubble.mjs, built by seed/records.mjs.
//
// Bubble links a field of type Author/Book to a record by its Bubble "unique id", which only exists after
// the record is uploaded. So the upload happens in three rounds:
//
//   1. node tools/make-csv.mjs           → data/csv/1_authors.csv        upload as Author
//      In App data → All Authors, Export → save as data/csv/export_authors.csv
//   2. node tools/make-csv.mjs           → data/csv/2_books.csv          upload as Book
//      In App data → All Books, Export   → save as data/csv/export_books.csv
//   3. node tools/make-csv.mjs           → data/csv/3_payouts.csv        upload as RoyaltyPayout
//
// Each run writes every file whose inputs are present, so it is safe to run again at any point.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecords } from '../seed/records.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'data', 'csv');
mkdirSync(OUT, { recursive: true });

const AUTHOR_COLS = ['author_code', 'name', 'email', 'phone', 'city', 'joined_date', 'total_books',
  'total_copies_sold', 'total_earned', 'total_paid', 'total_pending', 'earliest_overdue_on'];
const BOOK_COLS = ['author', 'book_code', 'title', 'isbn', 'genre', 'stage', 'publication_date', 'mrp',
  'royalty_per_copy', 'copies_sold', 'royalty_earned', 'royalty_paid', 'royalty_pending', 'last_payout_date',
  'print_partner', 'available_on', 'overdue_on'];
const PAYOUT_COLS = ['author', 'book', 'amount', 'payout_date', 'reference', 'note'];

function cell(v) {
  if (v === undefined || v === null) return '';
  const s = Array.isArray(v) ? v.join(', ') : String(v); // Bubble reads a list field as comma-separated values
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, cols, rows) {
  const text = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
  writeFileSync(join(OUT, file), text, 'utf8');
  console.log(`✔ wrote data/csv/${file} (${rows.length} rows)`);
}

/** Minimal RFC 4180 parser: enough for Bubble's export files. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Reads a Bubble export and returns a map keyField → unique id. */
function idMap(file, keyField) {
  const path = join(OUT, file);
  if (!existsSync(path)) return null;
  const [header, ...rows] = parseCsv(readFileSync(path, 'utf8'));
  const norm = header.map((h) => h.trim().toLowerCase());
  const keyIdx = norm.indexOf(keyField);
  const idIdx = norm.findIndex((h) => h === 'unique id' || h === '_id' || h === 'unique_id');
  if (keyIdx < 0 || idIdx < 0) {
    throw new Error(`${file}: expected columns "${keyField}" and "unique id", found: ${header.join(' | ')}`);
  }
  return Object.fromEntries(rows.map((r) => [r[keyIdx].trim(), r[idIdx].trim()]));
}

function requireIds(map, codes, what) {
  const missing = codes.filter((c) => !map[c]);
  if (missing.length) throw new Error(`No ${what} unique id for: ${missing.join(', ')}. Upload the earlier file first.`);
}

const { authors, books, payouts } = buildRecords();

writeCsv('1_authors.csv', AUTHOR_COLS, authors);

const authorIds = idMap('export_authors.csv', 'author_code');
if (!authorIds) {
  console.log('\nNext: upload 1_authors.csv as Author, then export All Authors to data/csv/export_authors.csv and run this again.');
  process.exit(0);
}
requireIds(authorIds, books.map((b) => b._author_code), 'Author');
writeCsv('2_books.csv', BOOK_COLS, books.map((b) => ({ ...b, author: authorIds[b._author_code] })));

const bookIds = idMap('export_books.csv', 'book_code');
if (!bookIds) {
  console.log('\nNext: upload 2_books.csv as Book, then export All Books to data/csv/export_books.csv and run this again.');
  process.exit(0);
}
requireIds(bookIds, payouts.map((p) => p._book_code), 'Book');
writeCsv('3_payouts.csv', PAYOUT_COLS, payouts.map((p) => ({
  ...p, author: authorIds[p._author_code], book: bookIds[p._book_code],
})));
console.log('\nNext: upload 3_payouts.csv as RoyaltyPayout. Then all data is in.');
