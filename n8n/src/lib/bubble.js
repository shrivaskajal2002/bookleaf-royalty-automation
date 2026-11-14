/*
 * Helpers for the Bubble <-> n8n contract.
 *
 * Bubble's free plan blocks every inbound API call (Data API, Workflow API, CSV import), so n8n can't
 * read from or call back into Bubble. Instead:
 *   - Bubble sends the author's full data in the webhook body (normalizePayload reads it), and
 *   - n8n answers the same HTTP request with the result (summaryResponse builds it), and Bubble
 *     writes that result into the Notification Log itself.
 * Inlined into Code nodes by build-workflow.mjs, same as royalty.js.
 */

/**
 * A date from Bubble → 'YYYY-MM-DD' as a calendar date in `timeZone`.
 * Bubble stores a moment in time; a date picked in India as 20 Jun is 19 Jun 18:30 UTC, so reading
 * it in UTC would shift it by a day. Accepts Unix milliseconds (Bubble's `:extract UNIX`), ISO strings
 * and plain 'YYYY-MM-DD'.
 */
function localDate(value, timeZone) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = /^-?\d{9,}$/.test(s) ? new Date(Number(s)) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** '' / null → null; '1,234' / '₹1234' / 1234 → 1234. */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Bubble builds lists with :format as text, so a list may arrive as an array or as a JSON string. */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    try {
      const parsed = JSON.parse(s.startsWith('[') ? s : `[${s}]`);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      return null;
    }
  }
  if (v === null || v === undefined || v === '') return [];
  return null;
}

const isBubbleId = (v) => typeof v === 'string' && /^\d+x\d+$/.test(v);

/**
 * Reads and checks the webhook body sent by Bubble. Returns the author, books and payouts in the
 * same shape as bookleaf_sample_data.json, so lib/royalty.js works on them unchanged.
 *
 * Expected body (every value may be a string; Bubble's API Connector sends text):
 * {
 *   "log_id": "<NotificationLog unique id>", "source": "single" | "bulk",
 *   "author": { "id", "author_code", "name", "email", "city" },
 *   "books":   [ { "book_code", "title", "isbn", "genre", "stage", "publication_date", "mrp",
 *                  "royalty_per_copy", "copies_sold", "royalty_earned", "royalty_paid",
 *                  "royalty_pending", "last_payout_date", "print_partner", "available_on" } ],
 *   "payouts": [ { "book_title", "amount", "payout_date" } ]
 * }
 */
function normalizePayload(body, timeZone) {
  const errors = [];
  body = body || {};
  const a = body.author || {};

  if (!isBubbleId(body.log_id)) errors.push('log_id must be a Bubble unique id');
  if (!isBubbleId(a.id)) errors.push('author.id must be a Bubble unique id');
  if (!txt(a.name)) errors.push('author.name is missing');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(txt(a.email))) errors.push('author.email is missing or invalid');

  const rawBooks = asArray(body.books);
  const rawPayouts = asArray(body.payouts);
  if (rawBooks === null) errors.push('books must be a list (JSON array)');
  if (rawPayouts === null) errors.push('payouts must be a list (JSON array)');

  const books = (rawBooks || []).map((b, i) => {
    const book = {
      book_id: txt(b.book_code) || null,
      title: txt(b.title),
      isbn: txt(b.isbn) || null,
      genre: txt(b.genre) || null,
      status: txt(b.stage),
      publication_date: localDate(b.publication_date, timeZone),
      mrp: toNum(b.mrp),
      author_royalty_per_copy: toNum(b.royalty_per_copy),
      total_copies_sold: toNum(b.copies_sold) ?? 0,
      total_royalty_earned: toNum(b.royalty_earned) ?? 0,
      royalty_paid: toNum(b.royalty_paid) ?? 0,
      royalty_pending: toNum(b.royalty_pending) ?? 0,
      last_royalty_payout_date: localDate(b.last_payout_date, timeZone),
      print_partner: txt(b.print_partner) || null,
      available_on: Array.isArray(b.available_on)
        ? b.available_on.map(txt).filter(Boolean)
        : txt(b.available_on).split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (!book.title) errors.push(`books[${i}].title is missing`);
    if (!book.status) errors.push(`books[${i}].stage is missing`);
    // Guard against a broken Bubble expression sending mismatched money fields.
    if (Math.abs(book.total_royalty_earned - book.royalty_paid - book.royalty_pending) > 1) {
      errors.push(`books[${i}] (${book.title}): earned ≠ paid + pending`);
    }
    return book;
  });

  const payouts = (rawPayouts || []).map((p) => ({
    amount: toNum(p.amount) ?? 0,
    payout_date: localDate(p.payout_date, timeZone),
    book_title: txt(p.book_title) || null,
  }));

  return {
    errors,
    log_id: body.log_id || null,
    source: body.source === 'bulk' ? 'bulk' : 'single',
    author: { bubble_id: a.id || null, author_id: txt(a.author_code) || null, name: txt(a.name), email: txt(a.email).toLowerCase(), city: txt(a.city) || null },
    books,
    payouts,
  };
}

/**
 * The one response shape n8n returns to Bubble, for every outcome. Every key is always present
 * (empty string / false when unused) so Bubble's API Connector detects all fields when the call is
 * initialised, and the Bubble workflow can copy them into the Notification Log one to one.
 */
function summaryResponse(fields) {
  const base = {
    ok: false,
    status: 'Failed',            // Success | Failed | Skipped
    log_id: '',
    email_subject: '',
    email_body: '',
    email_sent: false,
    recipient: '',
    error_message: '',
    failed_step: '',
    ai_model: '',
    n8n_execution_id: '',
    completed_at: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== undefined && v !== null && k in base) base[k] = typeof base[k] === 'string' ? String(v) : v;
  }
  return base;
}

// --- exports (stripped in build) ---
if (typeof module !== 'undefined') {
  module.exports = { localDate, toNum, asArray, normalizePayload, summaryResponse, isBubbleId };
}
