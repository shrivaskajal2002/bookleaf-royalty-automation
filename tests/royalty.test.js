const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../n8n/src/lib/royalty.js');
const data = require('../data/bookleaf_sample_data.json');

const author = (id) => data.authors.find((a) => a.author_id === id);

test('INR formatting uses Indian grouping', () => {
  assert.equal(R.fmtINR(850), '₹850');
  assert.equal(R.fmtINR(11970), '₹11,970');
  assert.equal(R.fmtINR(123456), '₹1,23,456');
  assert.equal(R.fmtINR(12345678), '₹1,23,45,678');
});

test('payout schedule: before last quarter deadline uses last quarter', () => {
  const s = R.payoutSchedule('2026-11-09');
  assert.equal(s.next_payout_quarter, 'Q3 2026');
  assert.equal(s.next_payout_deadline, '2026-11-14'); // 30 Sep + 45 days
});

test('payout schedule: after last quarter deadline rolls to current quarter', () => {
  const s = R.payoutSchedule('2026-11-20');
  assert.equal(s.next_payout_quarter, 'Q4 2026');
  assert.equal(s.next_payout_deadline, '2027-02-14'); // 31 Dec + 45 days
});

test('payout schedule: quarter boundaries', () => {
  assert.equal(R.payoutSchedule('2026-01-01').next_payout_deadline, '2026-02-14');
  assert.equal(R.payoutSchedule('2026-02-15').next_payout_deadline, '2026-05-15'); // 31 Mar + 45
  assert.equal(R.payoutSchedule('2026-03-31').next_payout_deadline, '2026-05-15');
});

test('badges: paid up, overdue, never-paid, in production', () => {
  const today = '2026-01-10';
  const priya = author('AUTH001');
  const pending = R.authorTotals(priya.books).total_pending;
  // BK001 last paid 2025-10-15 → overdue from 2026-01-13, so still yellow on 10 Jan
  assert.equal(R.bookBadge(priya.books[0], pending, today), 'YELLOW');
  assert.equal(R.bookBadge(priya.books[0], pending, '2026-01-14'), 'RED');
  assert.equal(R.bookBadge(priya.books[1], pending, today), 'GREEN');

  const ananya = author('AUTH003'); // never paid, published 2024-07-05
  assert.equal(R.bookBadge(ananya.books[0], 2546, today), 'RED');

  const sneha = author('AUTH007');
  assert.equal(R.bookBadge(sneha.books[2], 7865, today), 'GREY'); // in production
});

test('below ₹1,000 threshold is never overdue (rolls over)', () => {
  const kavita = author('AUTH009'); // only ₹850 pending, never paid
  assert.equal(R.authorTotals(kavita.books).total_pending, 850);
  assert.equal(R.bookBadge(kavita.books[1], 850, '2026-11-09'), 'YELLOW');
  assert.equal(R.authorPayoutStatus(kavita.books, '2026-11-09'), 'PENDING');
  assert.equal(R.authorEarliestOverdueOn(kavita.books), null);
});

test('author payout status across the dataset', () => {
  const today = '2026-11-09';
  const status = Object.fromEntries(data.authors.map((a) => [a.author_id, R.authorPayoutStatus(a.books, today)]));
  assert.equal(status.AUTH008, 'FULLY_PAID'); // Farhan: everything paid
  assert.equal(status.AUTH003, 'OVERDUE');
  assert.equal(status.AUTH009, 'PENDING');
});

test('context: totals and situation', () => {
  const ctx = R.buildAuthorContext(author('AUTH002'), author('AUTH002').books, [], '2026-11-09');
  assert.equal(ctx.facts.author.first_name, 'Rohit');
  assert.equal(ctx.facts.totals.total_earned, '₹84,024');
  assert.equal(ctx.facts.totals.total_pending, '₹13,024');
  assert.equal(ctx.facts.payout.situation, 'OVERDUE');

  const farhan = R.buildAuthorContext(author('AUTH008'), author('AUTH008').books, [], '2026-11-09');
  assert.equal(farhan.facts.payout.situation, 'ALL_PAID');

  const kavita = R.buildAuthorContext(author('AUTH009'), author('AUTH009').books, [], '2026-11-09');
  assert.equal(kavita.facts.payout.situation, 'BELOW_THRESHOLD');
  assert.equal(kavita.facts.payout.amount_short_of_threshold, '₹150');
  assert.equal(kavita.facts.books_in_production[0].current_stage, 'Typesetting');
});

test('validator: rejects made-up amounts and missing books, accepts a correct email', () => {
  const a = author('AUTH009');
  const ctx = R.buildAuthorContext(a, a.books, [], '2026-11-09');
  const good = {
    subject: 'Your BookLeaf royalty summary',
    body: `Dear Kavita,\n\nThank you for being part of BookLeaf. Here is an update on The Nagpur Notebooks, which has sold 34 copies and earned ₹850 in royalties so far. You have earned ₹850 in total, ₹0 has been paid, and ₹850 is pending.\n\nBecause the pending balance is below our ₹1,000 minimum payout, it rolls over to the next quarter. You are ₹150 away from the threshold.\n\nRaising Roots is currently in Typesetting, and we will email you as it moves to the next stage.\n\nWarm regards,\nThe BookLeaf Team`,
  };
  assert.deepEqual(R.validateEmail(good, ctx), []);

  const bad = { subject: good.subject, body: good.body.replace('₹150', '₹175').replace('Raising Roots', 'Your other book') };
  const problems = R.validateEmail(bad, ctx);
  assert.ok(problems.some((p) => p.includes('₹175')));
  assert.ok(problems.some((p) => p.includes('Raising Roots')));
});
