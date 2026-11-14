# BookLeaf: Author Royalty Dashboard & Automated Notification System

Assignment 2 of 2 · Bubble.io (free plan) + n8n Cloud + Google Gemini (free tier; Claude supported)

Authors log in to a Bubble app to see their books and royalties. The BookLeaf operations team uses the admin side to monitor payouts and to send each author an AI-written royalty summary email. A button in Bubble calls an n8n webhook with the author's data. n8n works out every figure in code, has the AI write the email, checks the email against the data, and answers Bubble with **Success / Failed / Skipped** plus the email text. Bubble stores that in the Notification Log.

| Deliverable | Where |
|---|---|
| Bubble app | Live URL and test logins: see *Submission details* at the end |
| n8n workflow export | [n8n/bookleaf_royalty_summary.workflow.json](n8n/bookleaf_royalty_summary.workflow.json) (+ [error alerts workflow](n8n/bookleaf_error_alerts.workflow.json)) |
| Documentation | This README + [docs/BUBBLE_BUILD_GUIDE.md](docs/BUBBLE_BUILD_GUIDE.md) |
| Screen recording | See *Submission details*. Script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) |

---

## 1. Architecture

```
 ┌──────────────────────────── Bubble.io (free plan) ─────────────────────────────┐
 │  Author portal (own data only,        Admin portal: author list + filters,     │
 │  enforced by privacy rules)           author detail, notification log          │
 │                                       [Generate & Send]   [Send to all pending] │
 │                                              │ 1. create NotificationLog        │
 │                                              │    (status = Processing)         │
 │                                              │ 2. API Connector POST            │
 │                                              │    header X-BookLeaf-Key (private)│
 │                                              │    body: log_id + author + books │
 │                                              │          + payouts               │
 │                                              │ 4. write the response into the   │
 │                                              │    log: Success/Failed/Skipped,  │
 │                                              │    email, timestamp              │
 └──────────────────────────────────────────────┼──────────────▲───────────────────┘
                                                ▼              │ 3. HTTP 200 + JSON result
 ┌──────────────────────────────────── n8n ──────────────────────────────────────────┐
 │ Webhook (Header Auth) → Config → Validate Payload ─invalid→ Respond Failed         │
 │   → Idempotency Gate ─duplicate→ Respond Skipped                                   │
 │   → Build Royalty Context (all maths + policy in code)                             │
 │   → AI: Generate Email (JSON schema) → Parse & Validate ─fail→ retry once          │
 │   → [optional SMTP] → Respond Success                                              │
 │ any error output → Build Failure Response → Respond Failed → Stop and Error        │
 │                                              → error workflow alerts ops            │
 └───────────────────────────────────────┬────────────────────────────────────────────┘
                                         ▼
                      Google Gemini API (free tier) — or Claude, one setting
```

### Why request/response instead of a callback
The brief describes n8n calling back into Bubble. **Bubble's free plan blocks every inbound API call.** I confirmed it with a real request: the Data API answered *"This application does not expose an API. Please upgrade your Bubble subscription"*. The Workflow API and CSV import are paid-only too. HR confirmed a paid plan isn't required, so I redesigned the integration to work within the free plan:

- **Bubble → n8n** still uses the API Connector (outbound calls work on the free plan).
- **n8n → Bubble**: instead of a second HTTP call, n8n answers the *same* request with the result, using *Respond to Webhook* nodes. Bubble's workflow waits for that answer (about 20 s with the AI call) and writes **Success / Failed / Skipped**, the email, the failed step and the timestamp into the Notification Log. Functionally this is step 5 of the brief: the status update reaches the log when n8n finishes.
- The button shows **"Sending…"** and is disabled while the request is open, and a final step always resets it (see §5). So the admin never sees an endless spinner, and a timeout or HTTP error still ends as a **Failed** row with the reason.

On a paid plan I'd switch to the asynchronous design (respond 202 immediately, then call a backend workflow with the result). The earlier version of this repo had exactly that. Section 7 explains the trade-off.

### Repository layout
```
data/bookleaf_sample_data.json        dataset from Assignment 1 (unchanged)
data/manual_entry.txt                 every record with computed fields, for entry in Bubble's App data
docs/BUBBLE_BUILD_GUIDE.md            Bubble build: schema, privacy, pages, workflows
docs/DEMO_SCRIPT.md                   shot list for the 3–5 minute recording
n8n/bookleaf_royalty_summary.workflow.json   ← import this into n8n (generated)
n8n/bookleaf_error_alerts.workflow.json      ← optional error workflow (generated)
n8n/build-workflow.mjs                builds both JSON files from n8n/src
n8n/src/lib/royalty.js                royalty rules: payout dates, badges, facts for the AI, email validator
n8n/src/lib/bubble.js                 reads Bubble's payload; builds the one response shape
n8n/src/lib/ai.js                     Gemini / Claude request + response adapter
n8n/src/nodes/*.js                    source of each Code node
n8n/src/prompt-system.md              the system prompt (Knowledge Base + tone + output rules)
seed/records.mjs                      builds all records (incl. cached totals, overdue_on) from the dataset
seed/seed-bubble.mjs                  loader via the Data API (paid Bubble plans)
tools/make-csv.mjs                    CSV files for App data → Upload (paid Bubble plans)
tools/make-entry-sheet.mjs            writes data/manual_entry.txt (what I used on the free plan)
tools/test-webhook.mjs                calls the live webhook like Bubble does: auth, validation, real run, double click
tools/preview-email.mjs               run the prompt locally against Claude for any author
tests/                                22 tests: royalty rules + the built workflow's Code nodes
```

```bash
npm install
npm test                                  # 22 tests
npm run build                             # rebuild the n8n JSON after editing n8n/src
node seed/seed-bubble.mjs --dry-run       # every computed status and overdue date for the dataset
node tools/test-webhook.mjs AUTH007       # live end-to-end check against n8n (needs env vars, see file)
```

---

## 2. Bubble database schema

```
User ──1:1── Author ──1:n── Book
 role         author_code    book_code, title, isbn, genre
 author       name, email,   stage (ProductionStage)
              phone, city    publication_date, mrp, royalty_per_copy
              user           copies_sold, royalty_earned/paid/pending
              total_* (cache) last_payout_date, print_partner, available_on
              earliest_overdue_on  overdue_on, owner_user
              last_summary_*
                │
                ├──1:n── RoyaltyPayout   (book, amount, payout_date, reference, note, owner_user)
                └──1:n── NotificationLog (status, source, triggered_by, requested_at, completed_at,
                                          email_subject, email_body, email_sent, recipient,
                                          error_message, failed_step, http_status, ai_model,
                                          n8n_execution_id)
Option sets: Role · ProductionStage (is_published, short_label, sort_order) · PrintPartner ·
             Platform · NotificationStatus (color, is_final) · PayoutFilter
```

Why this design:

- **User and Author are separate.** A login is not an author: admins are users without an author record, and an author record exists before its login does. All business data hangs off Author, and Author points to its User for access checks.
- **Books hold the royalty totals; RoyaltyPayout holds the history.** The dataset gives cumulative per-book figures (earned/paid/pending, last payout), so those live on Book, where the dashboard reads them. Payouts are events, so they get their own table. The dataset only has one "paid to date" figure per book, so each paid book gets one history row (12 rows), labelled as such. New payouts add rows to the same table.
- **Option sets for every fixed list** (role, stage, partner, platform, status). There are no free-text statuses to mistype, and attributes like `is_published` and the status colour are defined in one place. The ProductionStage display texts match the dataset exactly.
- **`overdue_on` (a date) instead of a stored "overdue" flag.** Whether a royalty is overdue depends on today's date, so a stored flag goes stale overnight. Storing *the date it becomes overdue* keeps the badge correct with one comparison (`overdue_on < Current date/time`), and Bubble can filter on it in the database. The Knowledge Base's ₹1,000 minimum payout is applied here: a balance below the threshold rolls over by policy, so it stays yellow, not red.
- **Cached totals on Author** (`total_*`, `earliest_overdue_on`) for the admin list, so filtering by status, city and name is one search instead of one search per row. The author's own dashboard sums the Book rows live.
- **`owner_user` copied onto Book and RoyaltyPayout**, so each privacy rule is a one-step check on the record itself.
- **Field names in `snake_case`**: they map one to one onto the JSON the API Connector sends to n8n.

Full field lists and types: [docs/BUBBLE_BUILD_GUIDE.md §2–3](docs/BUBBLE_BUILD_GUIDE.md).

### Loading the data on the free plan
The free plan blocks the Data API (my seed script got HTTP 401 *"does not expose an API"*) and CSV upload (*"Upgrade to a paid plan to upload CSV files"*). So `seed/records.mjs` computes every record, including the cached totals and `overdue_on`, and `tools/make-entry-sheet.mjs` writes them to [data/manual_entry.txt](data/manual_entry.txt). The 10 authors, 18 books and 12 payouts were entered in App data from that sheet. The same builder powers the Data API loader and the CSV generator, for when the app moves to a paid plan.

### Privacy rules
For Author, Book and RoyaltyPayout there are two rules: `Admins` (`Current User's role is Admin`) and `Owner` (`…'s user / owner_user is Current User`). Each grants *View all fields* and *Find this in searches*. NotificationLog is admin-only. User records are visible to the user themselves and to admins. **Everyone else gets nothing**, auto-binding is off, and the API create/modify/delete boxes are off. The author pages never filter by "my user ID": isolation comes from the rules on Bubble's server, so it can't be bypassed from the browser.

### Logins
Bubble no longer lets a workflow set another user's password. An admin screen creates each author's login with *Create an account for someone else* → links `Author.user` and the `owner_user` of their books and payouts → *Assign a temp password* → shows it once. On first login Bubble redirects the author to `set_password` (*Settings → General → redirect users who haven't changed their password*).

### The royalty status badge
| Badge | Rule (in Bubble, the last matching conditional wins, so they're added in this order) |
|---|---|
| 🟡 Pending | default: pending > 0 and not overdue (or below the ₹1,000 minimum, which rolls over) |
| 🟢 Paid up | `royalty_pending = 0` |
| 🔴 Overdue | `overdue_on` is set and `overdue_on < Current date/time` (90 days after the last payout, or after publication if never paid) |
| ⚪ In production | `stage's is_published = no` |

As of November 2026 every pending balance in the dataset is overdue (the latest payouts were in 2025), apart from Kavita's ₹850, which is below the payout minimum. `node seed/seed-bubble.mjs --dry-run --today=2026-01-10` shows how the same data looks earlier in the cycle.

---

## 3. How Bubble and n8n work together

### Bubble → n8n
- **API Connector** API `n8n BookLeaf`. The shared header `X-BookLeaf-Key` is marked **Private**, so Bubble adds it on its server and it never reaches the browser.
- Call `send_royalty_summary`: POST, used as an **Action**, *Include errors in response and allow workflow actions to continue* ticked.
- Body: `log_id`, `source` (`single` / `bulk`), `author` {id, author_code, name, email, city}, `books` [all fields of the author's books], `payouts` [book_title, amount, payout_date]. Bubble builds the lists with `:format as text`, with `:formatted as JSON-safe` on every text, and dates as `:extract UNIX`.
- A **custom event** `send_summary(author, source)` holds the whole sequence, so the single button and the bulk loop run exactly the same steps:
  1. guard: skip if this author has a Processing log from the last 2 minutes;
  2. create the NotificationLog (**Processing**, requested_at, triggered_by, source);
  3. call n8n;
  4. copy the response fields into the log (status is looked up as the NotificationStatus option with that display text); if the call itself errored (n8n down, timeout, 4xx/5xx), set **Failed** with `HTTP <code>: <message>`;
  5. update `Author.last_summary_at / last_summary_status`.
- **Bulk**: "Send summaries to all pending" puts `Search for Authors (total_pending > 0)` into a page state, and a self-scheduling custom event processes **one author per run, through the same webhook**, with a progress counter. It works on the free plan without backend workflows.

### n8n: where the data comes from (step 2)
**Choice: Bubble sends the full author payload in the webhook.** The brief allows either option.

- **The only option on the free plan.** n8n can't query Bubble's Data API, because it's blocked.
- **It's exactly what the admin sees.** The payload is built from the same records and fields as the author/admin pages, at the moment of the click.
- **n8n doesn't trust it blindly.** *Validate Payload* checks ids, the email format, required fields, list structure, and that every book's `earned = paid + pending`, before spending anything on AI. Bad data → **Failed** with the list of problems.
- Trade-off: a caller with the webhook key could send made-up figures. That's mitigated by the private key, and by the email only ever going back to Bubble (SMTP is off). With a paid plan I'd send ids only and have n8n read from the Data API, as in my first version.

### n8n → Bubble (steps 4–5)
Every handled outcome answers **HTTP 200 with the same JSON shape**, so Bubble maps one schema:

```json
{ "ok": true, "status": "Success | Failed | Skipped", "log_id": "...", "email_subject": "...",
  "email_body": "...", "email_sent": false, "recipient": "...", "error_message": "", "failed_step": "",
  "ai_model": "gemini-4-hydrogen", "n8n_execution_id": "42", "completed_at": "2026-11-14T08:30:00Z" }
```

Only problems n8n can't answer itself (wrong key → 403, n8n down, timeout) reach Bubble as HTTP errors, and Bubble marks the log **Failed** for those.

### n8n workflow, node by node
| # | Node | What it does |
|---|---|---|
| 1 | **Webhook** | POST `/webhook/bookleaf-royalty-summary`, Header Auth credential (`X-BookLeaf-Key`). Wrong or missing key → 403 from n8n before any node runs. Response mode: *Respond to Webhook node*. |
| 2 | **Config** | Non-secret settings: AI provider + model, timezone, SMTP on/off, test recipient, dedupe windows, optional "today" override for demos. Secrets live in Credentials only. |
| 3 | **Validate Payload** → IF | Normalises Bubble's text values (numbers, IST dates → calendar dates, comma lists) and checks them. Invalid → **Respond: Bad Payload (Failed)**. |
| 4 | **Idempotency Gate** → IF | Same `log_id` seen before, or a second request for the same author within 120 s → **Respond: Duplicate (Skipped)**. |
| 5 | **Build Royalty Context** | Code: totals, per-book status, payout situation, next payout date, allowed amounts, AI request. |
| 6 | **AI: Generate Email** | Gemini `generateContent` with a JSON response schema (or the Claude Messages API with `output_config.format`); 2 tries, 60 s timeout. |
| 7 | **Parse & Validate Email** → IF | Code checks (see §4). Fails → **Retry AI?** → **Build Retry Request** (one retry with the validator's notes) → back to 6. |
| 8 | **Send Real Email?** → **Send Email (SMTP)** | Bonus path, off by default (node deactivated). `EMAIL_TEST_RECIPIENT` redirects mail while testing, because the dataset's addresses are fake. |
| 9 | **Prepare Success Response** → **Respond: Success** | Status + email + timestamp back to Bubble. |
| F | **Build Failure Response** → **Respond: Failed** → **Stop and Error** | Shared failure path, see §5. |

Every Code and HTTP node after the gate has its **error output** wired to the failure path. There are no dead ends.

---

## 4. Prompt strategy

**Principle: code decides, the model writes.** Every number, date and policy decision is calculated in `Build Royalty Context` ([n8n/src/lib/royalty.js](n8n/src/lib/royalty.js), unit-tested). The AI gets a facts object and turns it into a good email. It is never asked to do arithmetic or to apply policy on its own.

What the code calculates:
- Totals across books, and per-book figures formatted as Indian rupees (`₹1,23,456`), with dates written out (`14 November 2026`) so there is nothing to convert.
- **Payout situation**, one of five: `PENDING_ON_SCHEDULE`, `OVERDUE`, `BELOW_THRESHOLD`, `ALL_PAID`, `NO_PUBLISHED_BOOKS`.
- **Next payout date** from the Knowledge Base cycle: quarterly calculation, paid within 45 days of quarter end. If the deadline for the last completed quarter hasn't passed, that is the next date; otherwise it is the current quarter's end + 45 days.
- The ₹1,000 minimum, including how much is still needed to reach it ("₹150 short").
- Books in production, with their current stage.
- "Today" in India's time zone (n8n Cloud runs on UTC).

The **system prompt** ([n8n/src/prompt-system.md](n8n/src/prompt-system.md)) contains:
- the relevant Knowledge Base policy (royalty split, quarterly cycle, 45-day window, ₹1,000 threshold, bank transfer, production stages, 48-hour escalation) and the tone guidelines from Assignment 1;
- the required contents of the email (greeting by first name, a paragraph per published book, totals on separate lines, next steps, production updates, closing);
- **one instruction per payout situation**. For example, OVERDUE means: say so plainly, own it on BookLeaf's behalf with no deflection, say it has been escalated with a 48-hour follow-up, and ask the author to check their bank details as a helpful check, not as the cause. ALL_PAID means a warm acknowledgement. BELOW_THRESHOLD is framed positively: "nothing is lost";
- facts rules: copy figures exactly, don't calculate, don't invent contacts or ticket numbers.

**Structured output**: a JSON schema `{subject, body}` (Gemini `responseSchema` / Claude `output_config.format`), so the response is always parseable.

**Checks after generation** (`validateEmail`):
- greeting uses the author's first name;
- every published and every in-production book is named;
- the three totals appear exactly;
- the payout date appears when the situation is on-schedule;
- **every ₹ amount in the email exists in the source data**, which catches invented numbers;
- no placeholders; length limits.

On failure, the workflow retries **once** with the problems listed and the rejected draft attached. If the retry also fails, the log is marked **Failed** with the reasons. A badly worded email never reaches an author silently.

**A real output** (Sneha Kulkarni: two published books with overdue balances, one book in Cover Design; generated by the live n8n workflow with `gemini-4-hydrogen` in 22.6 s):

> **Your BookLeaf royalty summary: ₹7,865 pending**
>
> Dear Sneha, … *The Algorithm of Love* has sold 1567 copies, with ₹39,175 in royalties earned. You have been paid ₹35,000 so far, leaving ₹4,175 pending… Across both published books: Total royalty earned: ₹60,865 · Total paid: ₹53,000 · Total pending: ₹7,865. We want to be straightforward about your pending balance. The payout for both books is overdue, and that is on us at BookLeaf. We have escalated your case to our finance team, and you will hear back from us within 48 hours… On the production front, *Midnight in Mysore* is currently in the Cover Design stage…

**Edge cases in the dataset and how they come out**
| Author | Case | Email |
|---|---|---|
| Farhan Sheikh | all paid | positive acknowledgement, no payout section |
| Ananya Reddy, Arjun Malhotra | published, never paid | owns the delay, escalated, 48-hour follow-up |
| Kavita Deshmukh | ₹850 pending (below minimum) + a book in Typesetting | rolls over, ₹150 to go, production update |
| Sneha Kulkarni | 2 books with pending + 1 in Cover Design | per-book figures + production update (above) |

**Model choice**: Google Gemini on the free tier (`AI_PROVIDER: 'gemini'`, `AI_MODEL: 'gemini-4-hydrogen'`), so the assignment costs nothing to run. The same prompt, schema and validator work with Claude: set `AI_PROVIDER: 'anthropic'` and `AI_MODEL: 'claude-opus-5-5'` (or `claude-haiku-5-5`), and use an `x-api-key` credential. `tools/preview-email.mjs` runs the prompt locally against Claude for any author.

---

## 5. Error handling

### In n8n
| Failure | Handling |
|---|---|
| Wrong/missing webhook key | n8n's Header Auth rejects with **403** before any node runs (verified: `tools/test-webhook.mjs`) |
| Invalid payload from Bubble | **Failed** with every problem listed, before any AI spend |
| Duplicate request | **Skipped** with the reason (see idempotency below) |
| AI API error / timeout / overload | 2 tries → failure path → **Failed**, step "AI: Generate Email", with the HTTP code. This happened for real during testing: Gemini returned *503 model overloaded*, the log showed Failed with that reason, and the next click succeeded. |
| AI safety block / refusal | not retried → **Failed** |
| Output not JSON / cut off / fails the checks | one retry with feedback → **Failed** with the specific problems |
| SMTP fails | **Failed**, but the generated email is kept in the log so it can be sent by hand |
| Anything that ends an execution in error | **Stop and Error** marks the n8n execution as failed; the optional **error workflow** ([bookleaf_error_alerts](n8n/bookleaf_error_alerts.workflow.json)) formats an alert with a link to the execution |

The failure handler works out *which step* failed (the flow is linear, so it's the last step that ran), maps it to a readable message, releases the per-author lock so the admin can retry immediately, answers Bubble, and still ends the run as failed in n8n. Nothing fails silently: there is always a red execution in n8n and a **Failed** row in Bubble.

*Bubble's Data API unreachable* (named in the brief) can't happen in this design, because n8n never calls Bubble. The equivalent risk is n8n being unreachable from Bubble, which is handled on the Bubble side.

### In Bubble
- *Include errors in response* + `Result of step X's returned an error` → the log row becomes **Failed** with `HTTP <code>: <message>` (n8n down, wrong key, timeout).
- The **Generate & Send** button turns into "Sending…" and is disabled while the request is open. A final step always clears the `sending` state, so it can't stay stuck.
- The log rows update live (Bubble searches are reactive), and the admin can open **View email** to read exactly what was generated.

### Idempotency: three layers
1. **Browser**: the button is disabled the moment it's clicked.
2. **Bubble**: the custom event won't start if this author already has a **Processing** log from the last 2 minutes (covers a second tab or a second admin).
3. **n8n**: a `log_id` that was already processed is **Skipped** (1 hour memory), and a second request for the same author within 120 s is **Skipped** (per-author lock in workflow static data). A failed run releases the lock, so a genuine retry isn't blocked.

### Webhook security
- Shared secret header, checked by n8n's built-in Header Auth before the workflow starts.
- The secret is a *Private* API Connector header in Bubble (server-side only) and an n8n credential (encrypted, not in the export).
- The AI API key is an n8n credential only. Nothing secret is in the workflow JSON.

---

## 6. Setup

### n8n
1. **Import** `n8n/bookleaf_royalty_summary.workflow.json` (and optionally `bookleaf_error_alerts.workflow.json`).
2. **Credentials** (type *Header Auth*):
   - on the **Webhook** node: Name `X-BookLeaf-Key`, Value = a long random string (the same value goes in the Bubble API Connector);
   - on **AI: Generate Email**: Name `x-goog-api-key`, Value = a Gemini API key from aistudio.google.com (free, no card). For Claude: Name `x-api-key` + set `AI_PROVIDER` / `AI_MODEL` in Config.
3. **Send Email (SMTP)**: leave it deactivated, or add SMTP credentials and set `SEND_EMAIL: true` + `EMAIL_TEST_RECIPIENT`.
4. **Publish / activate**, then copy the *Production* webhook URL into the Bubble API Connector. (The per-author lock only persists in production executions.)
5. Check it: `node tools/test-webhook.mjs AUTH007` (set `N8N_WEBHOOK_URL` and `WEBHOOK_KEY` first).

### Bubble
Follow [docs/BUBBLE_BUILD_GUIDE.md](docs/BUBBLE_BUILD_GUIDE.md): settings, option sets, data types, privacy rules, data entry, logins, styles, reusable elements, pages, the API Connector and the workflows.

### Editing the workflow
Code-node logic lives in `n8n/src`. Edit it there, run `npm test && npm run build`, and re-import. (If you tweak the workflow in the n8n editor, re-export it over the JSON file.)

---

## 7. Challenges and decisions

- **Bubble's free plan blocks every inbound API.** I designed the integration first (n8n reading the Data API, then calling a backend workflow with the result), built it, and only found the limit when the seed script got a 401 *"does not expose an API"*. CSV upload turned out to be paid-only too. I redesigned around what the free plan *does* allow: outbound API Connector calls. n8n now gets the data in the request and answers in the same request. The cost is a ~20 s open request instead of a 2 s one, which the "Sending…" state handles. The benefit is fewer moving parts. On a paid plan I'd go back to asynchronous (202 + callback), mainly so a bulk run of hundreds of authors doesn't depend on the admin's tab staying open.
- **Free AI.** I didn't want the assignment to need a paid key, so the workflow talks to Gemini's free tier through a small adapter (`lib/ai.js`). The prompt, schema and validator are provider-neutral, and switching to Claude is two Config values and one credential. The free tier does return *503 overloaded* sometimes, which turned out to be a good live test of the failure path.
- **Creating author logins.** Bubble has deprecated setting another user's password in *Create an account for someone else*. Logins are created from an admin screen (Create account → *Assign a temp password* → forced *set_password* page on first login). The same step fills `owner_user` on the author's books and payouts, which the privacy rules depend on.
- **"Overdue" changes with time.** My first idea was a stored status field, but it would be wrong the day after it was written. Storing the date a book *becomes* overdue made the badge always correct and filterable in the database.
- **Policy conflicts in the dataset.** Kavita's ₹850 has never been paid, which the 90-day rule alone would mark red. The Knowledge Base says balances under ₹1,000 roll over, so I treated it as yellow and told the AI to explain it positively. I'd confirm this interpretation with the team.
- **Dates and time zones.** Bubble stores a date picked as "20 Jun 2023" in India as 19 Jun 18:30 UTC, and n8n Cloud runs on UTC. Reading either naively shifts dates by a day. n8n converts every incoming date (and "today") to the Asia/Kolkata calendar date, and a test pins this down.
- **Testing n8n Code nodes.** Debugging JavaScript inside the n8n editor is slow, so the Code-node logic lives in normal files with unit tests, and a build script inlines it into the workflow JSON. A second test suite runs the *built* nodes with a mocked n8n runtime: happy path, both providers, duplicates, AI retry, safety blocks and failure responses.

### Learning log
> *(Add your own notes here: which Bubble concepts took longest (privacy rules, "Current cell", the conditional order, the API Connector's initialize step, custom states), what surprised you about the free plan, which manual pages or videos helped, and how you used AI tools while building. The founders said they want to see this.)*

---

## Submission details
- Live app: `https://shrivaskajal2002.bubbleapps.io/version-test`
- Author login: `kavita.deshmukh@email.com` / `<password>`
- Admin login: `admin@bookleaf.test` / `<password>`
- Bubble editor: free plan, so no collaborator invite; live URL and test logins as agreed by email
- n8n: workflow JSON in `n8n/`; production webhook `https://kajalshrivas.app.n8n.cloud/webhook/bookleaf-royalty-summary` (key-protected)
- Screen recording: `<Loom link>`
