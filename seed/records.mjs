// Builds the Bubble records (authors, books, payouts) from bookleaf_sample_data.json.
// Shared by seed-bubble.mjs (Data API loader, needs a paid Bubble plan) and tools/make-csv.mjs
// (CSV upload, works on the free plan), so both produce identical records, including the cached
// totals and overdue_on.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('../n8n/src/lib/royalty.js');

const here = dirname(fileURLToPath(import.meta.url));
export const dataset = JSON.parse(readFileSync(join(here, '..', 'data', 'bookleaf_sample_data.json'), 'utf8'));

// Dates are stored at 12:00 UTC so they show as the same calendar day in every time zone
// (midnight UTC would show as the previous day in the Americas).
export const bubbleDate = (d) => (d ? `${R.isoDate(R.toDate(d))}T12:00:00.000Z` : undefined);

/** Builds the Bubble records from the dataset, including the cached fields Bubble filters on. */
export function buildRecords() {
  const authors = [];
  const books = [];
  const payouts = [];
  for (const a of dataset.authors) {
    const totals = R.authorTotals(a.books);
    const earliest = R.authorEarliestOverdueOn(a.books);
    authors.push({
      author_code: a.author_id,
      name: a.name,
      email: a.email.toLowerCase(),
      phone: a.phone,
      city: a.city,
      joined_date: bubbleDate(a.joined_date),
      total_books: totals.total_books,
      total_copies_sold: totals.total_copies_sold,
      total_earned: totals.total_earned,
      total_paid: totals.total_paid,
      total_pending: totals.total_pending,
      earliest_overdue_on: earliest ? bubbleDate(earliest) : undefined,
    });
    for (const b of a.books) {
      const overdueOn = R.bookOverdueOn(b, totals.total_pending);
      books.push({
        _author_code: a.author_id, // replaced with the Bubble id of the author before upload
        book_code: b.book_id,
        title: b.title,
        isbn: b.isbn,
        genre: b.genre,
        stage: b.status, // option set ProductionStage, matched by display text
        publication_date: bubbleDate(b.publication_date),
        mrp: b.mrp ?? undefined,
        royalty_per_copy: b.author_royalty_per_copy ?? undefined,
        copies_sold: b.total_copies_sold,
        royalty_earned: b.total_royalty_earned,
        royalty_paid: b.royalty_paid,
        royalty_pending: b.royalty_pending,
        last_payout_date: bubbleDate(b.last_royalty_payout_date),
        print_partner: b.print_partner ?? undefined, // option set PrintPartner
        available_on: b.available_on, // list of option set Platform
        overdue_on: overdueOn ? bubbleDate(overdueOn) : undefined,
      });
      // The dataset only has the cumulative amount paid and the last payout date, so each book with
      // payments gets one history record. Real payouts recorded later add more rows to the same table.
      if (b.royalty_paid > 0 && b.last_royalty_payout_date) {
        payouts.push({
          _author_code: a.author_id,
          _book_code: b.book_id,
          reference: `SEED-${b.book_id}`,
          amount: b.royalty_paid,
          payout_date: bubbleDate(b.last_royalty_payout_date),
          note: 'Paid to date as of last payout (imported from dataset)',
        });
      }
    }
  }
  return { authors, books, payouts };
}

export const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([k, v]) => !k.startsWith('_') && v !== undefined));
