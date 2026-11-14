/*
 * BookLeaf royalty rules: shared by the n8n Code nodes, the seed script and the tests.
 *
 * Written as plain script code (no import/export) because n8n Code nodes run a
 * function body, not a module. build-workflow.mjs inlines this file into the Code
 * nodes that need it and removes the export block at the bottom.
 *
 * All dates are handled as UTC calendar dates, so the result does not change with
 * the time zone of the n8n host.
 */

const POLICY = {
  PAYOUT_WINDOW_DAYS: 45,   // KB: "paid within 45 days of the quarter ending"
  OVERDUE_AFTER_DAYS: 90,   // Assignment: red badge if no payout for > 90 days
  MIN_PAYOUT_INR: 1000,     // KB: below ₹1,000 royalties roll over to the next quarter
  ESCALATION_HOURS: 48,     // KB playbook: genuinely overdue → escalate, 48h resolution
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' | ISO string | Date | null → Date at UTC midnight, or null. */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function isoDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** 14 November 2026: written out so the AI copies it and no one misreads 11/14 vs 14/11. */
function fmtDate(date) {
  if (!date) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** ₹11,970 / ₹1,23,456 in Indian digit grouping. Hand-rolled so it does not depend on ICU data on the n8n host. */
function fmtINR(amount) {
  const n = Math.round(Number(amount) || 0);
  const sign = n < 0 ? '-' : '';
  const s = String(Math.abs(n));
  if (s.length <= 3) return `${sign}₹${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}₹${rest},${last3}`;
}

/** Last day of the calendar quarter that contains `date`. */
function quarterEnd(date) {
  const qEndMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 3; // 3, 6, 9, 12
  return new Date(Date.UTC(date.getUTCFullYear(), qEndMonth, 0)); // day 0 = last day of previous month
}

function previousQuarterEnd(date) {
  const qStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), qStartMonth, 0));
}

function quarterLabel(qEnd) {
  return `Q${Math.floor(qEnd.getUTCMonth() / 3) + 1} ${qEnd.getUTCFullYear()}`;
}

/**
 * Quarterly cycle: royalties for a quarter are paid within 45 days of the quarter ending.
 * If the deadline for the last completed quarter has not passed yet, that deadline is next.
 * Otherwise the next payout is for the current quarter.
 */
function payoutSchedule(today) {
  const t = toDate(today);
  const lastQEnd = previousQuarterEnd(t);
  const lastQDeadline = addDays(lastQEnd, POLICY.PAYOUT_WINDOW_DAYS);
  const curQEnd = quarterEnd(t);
  const curQDeadline = addDays(curQEnd, POLICY.PAYOUT_WINDOW_DAYS);
  const useLast = t.getTime() <= lastQDeadline.getTime();
  const nextQEnd = useLast ? lastQEnd : curQEnd;
  const nextDeadline = useLast ? lastQDeadline : curQDeadline;
  return {
    today: isoDate(t),
    next_payout_quarter: quarterLabel(nextQEnd),
    next_payout_quarter_end: isoDate(nextQEnd),
    next_payout_deadline: isoDate(nextDeadline),
    next_payout_deadline_text: fmtDate(nextDeadline),
    next_payout_quarter_end_text: fmtDate(nextQEnd),
  };
}

function isPublished(book) {
  return /published/i.test(String(book.status || ''));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function authorTotals(books) {
  return books.reduce((acc, b) => {
    acc.total_copies_sold += num(b.total_copies_sold);
    acc.total_earned += num(b.total_royalty_earned);
    acc.total_paid += num(b.royalty_paid);
    acc.total_pending += num(b.royalty_pending);
    return acc;
  }, { total_books: books.length, total_copies_sold: 0, total_earned: 0, total_paid: 0, total_pending: 0 });
}

/**
 * The date from which a book's pending royalty counts as overdue, or null if it never will
 * with the current figures.
 *
 * Storing this one date (instead of a status) keeps the status correct over time: the
 * dashboard compares it with "Current date/time" when the page is viewed.
 *
 * - No pending amount → null (paid up).
 * - Author's total pending below the ₹1,000 threshold → null. Policy says it rolls over, so it
 *   is not overdue (shown as yellow, "below payout threshold").
 * - Paid before → last payout + 90 days.
 * - Never paid and published → publication date + 90 days.
 */
function bookOverdueOn(book, authorTotalPending) {
  if (num(book.royalty_pending) <= 0) return null;
  if (num(authorTotalPending) < POLICY.MIN_PAYOUT_INR) return null;
  const base = toDate(book.last_royalty_payout_date) || (isPublished(book) ? toDate(book.publication_date) : null);
  return base ? addDays(base, POLICY.OVERDUE_AFTER_DAYS) : null;
}

/** GREEN | YELLOW | RED | GREY. Same rule as the Bubble badge conditionals. */
function bookBadge(book, authorTotalPending, today) {
  const t = toDate(today);
  if (!isPublished(book) && num(book.total_royalty_earned) === 0) return 'GREY';
  if (num(book.royalty_pending) <= 0) return 'GREEN';
  const overdueOn = bookOverdueOn(book, authorTotalPending);
  if (overdueOn && overdueOn.getTime() < t.getTime()) return 'RED';
  return 'YELLOW';
}

/** FULLY_PAID | PENDING | OVERDUE (used by the admin filter). */
function authorPayoutStatus(books, today) {
  const totals = authorTotals(books);
  if (totals.total_pending <= 0) return 'FULLY_PAID';
  return books.some((b) => bookBadge(b, totals.total_pending, today) === 'RED') ? 'OVERDUE' : 'PENDING';
}

/** Earliest overdue_on across the author's books, cached on Author so Bubble can filter on it. */
function authorEarliestOverdueOn(books) {
  const totals = authorTotals(books);
  const dates = books.map((b) => bookOverdueOn(b, totals.total_pending)).filter(Boolean);
  if (!dates.length) return null;
  return new Date(Math.min(...dates.map((d) => d.getTime())));
}

/**
 * Turns raw author/book/payout data into the facts sent to the AI.
 *
 * Every number, date and decision is worked out here, in code. The model only writes the
 * wording around these facts, so it cannot get the money or the policy wrong.
 */
function buildAuthorContext(author, books, payouts, today) {
  const t = toDate(today);
  const totals = authorTotals(books);
  const schedule = payoutSchedule(t);
  const published = books.filter(isPublished);
  const inProduction = books.filter((b) => !isPublished(b));

  const bookFacts = published.map((b) => {
    const badge = bookBadge(b, totals.total_pending, t);
    const lastPayout = toDate(b.last_royalty_payout_date);
    return {
      title: b.title,
      publication_date: fmtDate(toDate(b.publication_date)),
      copies_sold: num(b.total_copies_sold),
      royalty_per_copy: fmtINR(b.author_royalty_per_copy),
      royalty_earned: fmtINR(b.total_royalty_earned),
      royalty_paid: fmtINR(b.royalty_paid),
      royalty_pending: fmtINR(b.royalty_pending),
      last_payout_date: lastPayout ? fmtDate(lastPayout) : 'No payout yet',
      available_on: (b.available_on || []).join(', '),
      status: { GREEN: 'Paid up', YELLOW: 'Pending, within normal cycle', RED: 'Overdue' }[badge],
    };
  });

  const overdueTitles = published
    .filter((b) => bookBadge(b, totals.total_pending, t) === 'RED')
    .map((b) => b.title);

  let situation;
  if (!published.length) situation = 'NO_PUBLISHED_BOOKS';
  else if (totals.total_pending <= 0) situation = 'ALL_PAID';
  else if (totals.total_pending < POLICY.MIN_PAYOUT_INR) situation = 'BELOW_THRESHOLD';
  else if (overdueTitles.length) situation = 'OVERDUE';
  else situation = 'PENDING_ON_SCHEDULE';

  const firstName = String(author.name || '').trim().split(/\s+/)[0] || 'there';

  const history = (payouts || [])
    .map((p) => ({ date: toDate(p.payout_date), amount: num(p.amount), book: p.book_title || null }))
    .filter((p) => p.date)
    .sort((a, b) => b.date - a.date)
    .slice(0, 5)
    .map((p) => ({ date: fmtDate(p.date), amount: fmtINR(p.amount), book: p.book }));

  const facts = {
    today: fmtDate(t),
    author: { full_name: author.name, first_name: firstName, city: author.city || null },
    totals: {
      published_books: published.length,
      total_copies_sold: totals.total_copies_sold,
      total_earned: fmtINR(totals.total_earned),
      total_paid: fmtINR(totals.total_paid),
      total_pending: fmtINR(totals.total_pending),
    },
    published_books: bookFacts,
    books_in_production: inProduction.map((b) => ({ title: b.title, current_stage: String(b.status || '').replace(/^In Production\s*-\s*/i, '') })),
    recent_payouts: history,
    payout: {
      situation,
      overdue_books: overdueTitles,
      next_payout_quarter: schedule.next_payout_quarter,
      next_payout_quarter_end: schedule.next_payout_quarter_end_text,
      next_payout_deadline: schedule.next_payout_deadline_text,
      minimum_payout_threshold: fmtINR(POLICY.MIN_PAYOUT_INR),
      amount_short_of_threshold: totals.total_pending > 0 && totals.total_pending < POLICY.MIN_PAYOUT_INR
        ? fmtINR(POLICY.MIN_PAYOUT_INR - totals.total_pending) : null,
      escalation_hours: POLICY.ESCALATION_HOURS,
    },
  };

  // Every rupee amount the email is allowed to contain. Parse & Validate rejects any other amount.
  const allowed = new Set([fmtINR(POLICY.MIN_PAYOUT_INR)]);
  [facts.totals.total_earned, facts.totals.total_paid, facts.totals.total_pending, facts.payout.amount_short_of_threshold]
    .filter(Boolean).forEach((a) => allowed.add(a));
  published.forEach((b) => {
    ['total_royalty_earned', 'royalty_paid', 'royalty_pending', 'author_royalty_per_copy', 'mrp']
      .forEach((k) => { if (b[k] !== null && b[k] !== undefined) allowed.add(fmtINR(b[k])); });
  });
  history.forEach((p) => allowed.add(p.amount));

  return { facts, allowed_amounts: [...allowed], totals_raw: totals };
}

/**
 * Checks the AI's email before it goes anywhere. Returns a list of problems (empty = OK).
 * This is a deterministic guard against made-up numbers and missing content.
 */
function validateEmail(email, context) {
  const problems = [];
  const subject = String(email && email.subject || '').trim();
  const body = String(email && email.body || '').trim();
  const f = context.facts;
  if (!subject) problems.push('subject is empty');
  if (subject.length > 150) problems.push('subject longer than 150 characters');
  if (body.length < 300) problems.push('body is too short');
  if (body.length > 6000) problems.push('body is too long');
  if (!body.includes(f.author.first_name)) problems.push(`greeting does not use the author's name (${f.author.first_name})`);
  if (f.published_books.length) {
    [f.totals.total_earned, f.totals.total_paid, f.totals.total_pending].forEach((amt) => {
      if (!body.includes(amt)) problems.push(`required total ${amt} missing from body`);
    });
  }
  f.published_books.forEach((b) => { if (!body.includes(b.title)) problems.push(`published book "${b.title}" not mentioned`); });
  f.books_in_production.forEach((b) => { if (!body.includes(b.title)) problems.push(`in-production book "${b.title}" not mentioned`); });
  if (f.payout.situation === 'PENDING_ON_SCHEDULE' && !body.includes(f.payout.next_payout_deadline)) {
    problems.push(`next payout date ${f.payout.next_payout_deadline} missing`);
  }
  const allowed = new Set(context.allowed_amounts);
  const found = body.match(/₹\s?[\d,]+(?:\.\d+)?/g) || [];
  found.map((a) => a.replace(/\s/g, '').replace(/\.0+$/, '')).forEach((a) => {
    if (!allowed.has(a)) problems.push(`amount ${a} is not in the source data`);
  });
  if (/\[[^\]]*\]|\{\{|lorem ipsum/i.test(body)) problems.push('body contains a placeholder');
  return problems;
}

// --- exports (stripped in build) ---
if (typeof module !== 'undefined') {
  module.exports = {
    POLICY, toDate, addDays, isoDate, fmtDate, fmtINR, quarterEnd, previousQuarterEnd, payoutSchedule,
    isPublished, authorTotals, bookOverdueOn, bookBadge, authorPayoutStatus, authorEarliestOverdueOn,
    buildAuthorContext, validateEmail,
  };
}
