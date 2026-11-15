# Bubble Build Guide: BookLeaf Royalty Dashboard

> **Free-plan update (read first).** This guide was written for the original design. On Bubble's free plan the Data API, Workflow API and CSV upload are blocked, so the built app differs in three places: **§5–6** (n8n is called through the API Connector with the author's full data and replies in the same request; there is no backend callback workflow), **§7.1** (records were entered in App data from [data/manual_entry.txt](../data/manual_entry.txt) instead of the seed script), and **Settings → API** (no token needed). The current integration is described in the [README §3 and §5](../README.md). Sections 1–4 and 8–9 match the app.

A step-by-step guide to building the Bubble side of the system: database, privacy rules, API Connector, backend workflow, pages and workflows. Each step tells you what to click and what to type. Field and type names must match exactly, because the n8n workflow and the seed script use them.

Build in this order. Each step depends on the ones before it.

1. Settings
2. Option sets
3. Data types
4. Privacy rules
5. API Connector (Bubble → n8n)
6. Backend workflow (n8n → Bubble)
7. Load the data and create logins
8. Reusable elements
9. Pages and workflows
10. Test checklist

Conventions: `Current User's author` means the expression built in Bubble's expression editor. `→` means "then". In Bubble, when several conditionals match, the **last one wins**. The badge logic below relies on that.

---

## 1. Settings

**Settings → General**
- Leave "Allow users to sign up" behaviour to the pages: there is no public sign-up page.
- *Redirect users who haven't changed their password* → `set_password` (create this page in step 9).

**Settings → API**
- ✅ *This app exposes a Workflow API* (needed for the n8n callback in step 6)
- ✅ *Enable Data API*, then tick **Author**, **Book**, **RoyaltyPayout**, **NotificationLog**
- *API Tokens* → **Generate a new API token**, label it `n8n`. This is an **admin token**: it bypasses privacy rules. Store it only in n8n Credentials (`Bubble Admin API Token`) and in your shell when you run the seed script. Never put it in a page or workflow.

> **If your plan does not offer the Workflow API**, skip step 6 and set `BUBBLE_CALLBACK_MODE: 'data_api'` in the n8n *Config* node. n8n then updates the log with `PATCH /obj/notificationlog/<id>`. Everything else stays the same.

Endpoints while building (dev version): `https://<app>.bubbleapps.io/version-test/api/1.1/...`. Drop `/version-test` after deploying to live.

---

## 2. Option sets (Data → Option sets)

Option sets are fixed lists. Using them instead of free text means no typos in statuses, cheap comparisons, and colours stored in one place.

| Option set | Options (Display, exact text) | Attributes |
|---|---|---|
| **Role** | `Admin`, `Author` | – |
| **ProductionStage** | `In Production - Manuscript Received`, `In Production - Editing`, `In Production - Cover Design`, `In Production - Typesetting`, `In Production - Proofreading`, `In Production - ISBN Assignment`, `In Production - Printing`, `In Production - Distribution Setup`, `Published & Live` | `is_published` (yes/no: yes only for *Published & Live*), `short_label` (text, e.g. "Cover Design"), `sort_order` (number 1–9) |
| **PrintPartner** | `In-House`, `Repro India`, `Epitome Books` | – |
| **Platform** | `Amazon India`, `Flipkart`, `Amazon US`, `Amazon UK`, `BookLeaf Store` | – |
| **NotificationStatus** | `Queued`, `Processing`, `Success`, `Failed`, `Skipped` | `color` (text: `#9CA3AF`, `#3B82F6`, `#16A34A`, `#DC2626`, `#F59E0B`), `is_final` (yes/no: yes for Success/Failed/Skipped) |
| **PayoutFilter** | `Fully paid`, `Pending`, `Overdue` | – |

The ProductionStage display texts match the dataset's `status` values exactly. The seed script sends those strings, and Bubble maps them to options by display text.

---

## 3. Data types (Data → Data types)

Field names are lowercase `snake_case` on purpose: the Bubble Data API returns field names as keys, so n8n can read `royalty_pending` directly without any mapping.

### User (built in)
| Field | Type | Notes |
|---|---|---|
| `role` | Role | Admin or Author. Never editable by the user: no workflow changes it, and auto-binding is off. |
| `author` | Author | Links a login to its author profile (empty for admins). |

### Author
| Field | Type | Notes |
|---|---|---|
| `author_code` | text | AUTH001… (business key from the dataset) |
| `name`, `email`, `phone`, `city` | text | |
| `joined_date` | date | |
| `user` | User | The login that owns this record. Used by privacy rules. |
| `total_books` | number | **Cached** totals (see "Why cache totals" below) |
| `total_copies_sold` | number | cached |
| `total_earned` | number | cached |
| `total_paid` | number | cached |
| `total_pending` | number | cached |
| `earliest_overdue_on` | date | cached: earliest `overdue_on` of the author's books, empty if none |
| `last_summary_at` | date | set by the n8n callback |
| `last_summary_status` | NotificationStatus | set by the n8n callback |

### Book
| Field | Type | Notes |
|---|---|---|
| `author` | Author | the relationship: authors have many books |
| `owner_user` | User | copy of `author's user`, so privacy rules can check ownership in one step |
| `book_code` | text | BK001… |
| `title`, `isbn`, `genre` | text | |
| `stage` | ProductionStage | |
| `publication_date` | date | empty while in production |
| `mrp`, `royalty_per_copy` | number | empty while in production |
| `copies_sold`, `royalty_earned`, `royalty_paid`, `royalty_pending` | number | cumulative figures from the dataset |
| `last_payout_date` | date | empty = never paid |
| `print_partner` | PrintPartner | |
| `available_on` | list of Platform | |
| `overdue_on` | date | the date the pending royalty becomes overdue (empty = never). See below. |

### RoyaltyPayout (payout history)
| Field | Type |
|---|---|
| `author` | Author |
| `book` | Book |
| `owner_user` | User |
| `amount` | number |
| `payout_date` | date |
| `reference` | text (e.g. SEED-BK001, or a bank reference) |
| `note` | text |

### NotificationLog
| Field | Type | Notes |
|---|---|---|
| `author` | Author | |
| `status` | NotificationStatus | Queued → Processing → Success / Failed (or Skipped for duplicates) |
| `source` | text | `single` or `bulk` |
| `triggered_by` | User | the admin who clicked |
| `requested_at`, `completed_at` | date | |
| `http_status` | number | what n8n answered to the trigger call |
| `email_subject` | text | |
| `email_body` | text | the AI-generated email, shown in the log |
| `email_sent` | yes/no | true only if the SMTP node actually sent it |
| `recipient` | text | |
| `error_message`, `failed_step` | text | |
| `ai_model`, `n8n_execution_id` | text | for tracing a log row back to the n8n execution |

### Why `overdue_on` instead of a stored status
"Overdue" depends on today's date, so a stored status would go stale overnight. The seed script (and the recalculation workflow) stores **the date a book becomes overdue**:

- pending = 0 → empty (paid up)
- author's total pending < ₹1,000 → empty (KB: below the minimum payout, royalties roll over, so it is not overdue)
- otherwise → (last payout date, or publication date if never paid) + 90 days

The badge then only compares `overdue_on < Current date/time`. That is always correct, and it works as a **search constraint**, so the database does the filtering rather than the browser.

### Why cache totals on Author
The admin list must filter by payout status and show totals for every author. Computing `Search for Books:sum` inside every repeating-group cell means one search per cell, and Bubble can't filter on such an expression. Cached fields make the admin list a single indexed search. The author's own dashboard still sums the Book records live, so the figures an author sees always come straight from the source rows. The **Recalculate totals** button (step 9.4) refreshes the cache after a book is edited.

---

## 4. Privacy rules (Data → Privacy)

Rules are checked on Bubble's server, so a user can't get around them from the browser. For every type, **Everyone else** has every box *unchecked*, and *Allow auto-binding* is off.

| Type | Rule name | Condition | Permissions |
|---|---|---|---|
| User | `Admins` | `Current User's role is Admin` | View all fields, Find this in searches |
| User | `Self` | `This User is Current User` | View all fields, Find this in searches |
| Author | `Admins` | `Current User's role is Admin` | View all fields, Find this in searches |
| Author | `Owner` | `This Author's user is Current User` | View all fields, Find this in searches |
| Book | `Admins` | `Current User's role is Admin` | View all fields, Find this in searches |
| Book | `Owner` | `This Book's owner_user is Current User` | View all fields, Find this in searches |
| RoyaltyPayout | `Admins` | `Current User's role is Admin` | View all fields, Find this in searches |
| RoyaltyPayout | `Owner` | `This RoyaltyPayout's owner_user is Current User` | View all fields, Find this in searches |
| NotificationLog | `Admins` | `Current User's role is Admin` | View all fields, Find this in searches |

Notes
- `owner_user` is stored on Book and RoyaltyPayout so each rule checks a field on the record itself. That is faster, and it doesn't rely on following `This Book's author's user` inside a rule.
- Authors can't see NotificationLog at all. It is an internal operations view.
- Logged-out visitors match no rule, so they see nothing.
- The n8n token is an admin API token, so the Data API is not limited by these rules. That is why the token lives only in n8n Credentials.

How to check them: log in as Priya. Her dashboard's searches return only her 2 books, even though nothing in the page filters by user other than `Current User's author`. Open the browser console and try `fetch`-ing another book: nothing comes back.

---

## 5. API Connector: Bubble → n8n (Plugins → API Connector)

**Add another API** → name `n8n BookLeaf`
- Authentication: *None or self-handled*
- Shared headers:
  - `X-BookLeaf-Key` = *(the long random secret you also put in the n8n credential "BookLeaf Webhook Key")*, with **Private ✅** ticked. Private keys stay on Bubble's server and are never sent to the browser.
  - `Content-Type` = `application/json`

**Add call** → name `Trigger Royalty Summary`
- Use as: **Action**. Data type: JSON
- `POST` `https://<your-n8n>/webhook/bookleaf-royalty-summary`
- Body (JSON):
  ```json
  {
    "author_id": "<author_id>",
    "log_id": "<log_id>",
    "source": "<source>",
    "triggered_by": "<triggered_by>"
  }
  ```
  Untick *Private* on the four dynamic values so workflows can set them.
- ✅ **Include errors in response and allow workflow actions to continue.** Without this, an n8n error stops the Bubble workflow with a generic popup and the log is left Queued. With it, later steps can read `Result of step X's returned an error`, `error status code` and `error body`, and show a clear message.
- **Initialize**: use *Manually enter API response* and paste `{"accepted": true, "log_id": "x", "execution_id": "1"}`.
  (Or create a Queued NotificationLog in App Data and initialize with its real id while the n8n workflow is active.)

n8n answers within 1–3 seconds (202 accepted, or 400/404/409/502 with `{"accepted": false, "error": "..."}`), then keeps working in the background. That is why the admin never waits for the AI. The final result reaches Bubble through the callback in step 6.

---

## 6. Backend workflow: n8n → Bubble callback (Backend workflows)

**New API workflow** → `royalty_summary_callback`
- ✅ Expose as a public API workflow
- ❌ *This workflow can be run without authentication* (the caller must send the admin token as `Authorization: Bearer …`, which only n8n has)
- ✅ Ignore privacy rules when running the workflow
- Parameter definition: *Manual definition*

| Key | Type | Optional |
|---|---|---|
| `log_id` | NotificationLog | no |
| `status` | text | no |
| `email_subject`, `email_body`, `error_message`, `failed_step`, `recipient`, `ai_model`, `n8n_execution_id` | text | yes |
| `email_sent` | yes/no | yes |
| `completed_at` | date | yes |

Actions
1. **Make changes to a thing** → `log_id`
   - *Only when*: `log_id's status's is_final is no` (a final status is never overwritten, so a late or repeated callback can't flip Success back to Processing)
   - status = `All NotificationStatuses:filtered (Display = status):first item`
   - email_subject, email_body, error_message, failed_step, recipient, ai_model, n8n_execution_id, email_sent, completed_at = the matching parameters
2. **Make changes to a thing** → `log_id's author`
   - *Only when*: `status is "Success" or status is "Failed"`
   - last_summary_at = `completed_at`; last_summary_status = (same expression as above)
3. **Return data from API** → `ok` = `yes`

n8n calls this three times per run: `Processing` (accepted), then `Success` or `Failed` with a timestamp.

---

## 7. Load the data and create logins

### 7.1 Data (seed script)
```bash
node seed/seed-bubble.mjs --dry-run          # preview: badges, statuses, record counts
BUBBLE_APP_URL=https://<app>.bubbleapps.io/version-test BUBBLE_API_TOKEN=<token> node seed/seed-bubble.mjs
```
This creates 10 Authors, 18 Books and 12 RoyaltyPayouts through the Data API bulk endpoint. It links books to authors by Bubble id and fills the cached totals and `overdue_on`. You can run it again safely: it skips records that already exist (matched by `author_code` / `book_code` / `reference`).

*No-API fallback:* enter the records in App Data by hand. The `--dry-run` tables list every computed value you need.

### 7.2 The first admin
1. Make a temporary page `setup` with Email + Password inputs and a button: **Sign the user up**.
2. Sign up `admin@bookleaf.test`. In **App Data → All Users**, set its `role` = Admin.
3. Delete the `setup` page.

### 7.3 Author logins (Admin page → "Author accounts" section, step 9.3)
Bubble no longer lets an action set another user's password, so each login is created with a temporary password:

Repeating group: `Search for Authors (user is empty)`, with a button **Create login** in each cell:
1. **Create an account for someone else**: Email = `Current cell's Author's email`. ✅ Return the user if the account already exists. Changes: `role = Author`, `author = Current cell's Author`.
2. **Make changes to** `Current cell's Author`: `user = Result of step 1`
3. **Make changes to a list of things**: `Search for Books (author = Current cell's Author)` → `owner_user = Result of step 1`
4. **Make changes to a list of things**: `Search for RoyaltyPayouts (author = Current cell's Author)` → `owner_user = Result of step 1`
5. **Assign a temp password to a user**: `Result of step 1`
6. **Set state** `temp_password` of the popup = `Result of step 5` → **Show** popup *Temp password* ("Give this to the author: …")

On first login with the temporary password, Bubble redirects the author to `set_password` (Settings, step 1). For the reviewers' test account, log in once as `priya.sharma@email.com` and set the password you list in the submission.

---

## 8. Reusable elements (shared by the author and admin views)

Building these once means the author dashboard and the admin's author view are guaranteed to show the same figures. That matches the spec: "the same data the author sees".

### 8.1 `re_royalty_summary` (Type of content: **Author**)
Three stat cards. Live sums over the book rows:
- Total earned: `Search for Books (author = Parent group's Author):sum royalty_earned` → `:formatted as ₹#,##0`
- Total paid: `… :sum royalty_paid`
- Total pending: `… :sum royalty_pending`. Conditional: when > 0, text colour amber.
- Small caption: `Search for Books (author = …):count` books · `…:sum copies_sold` copies sold

### 8.2 `re_book_table` (Type of content: **Author**)
Repeating group, type **Book**, data source `Search for Books (author = Parent group's Author)`, sorted by `publication_date`, descending.

Each cell shows:
| Column | Expression |
|---|---|
| Title | `Current cell's Book's title` |
| ISBN · Genre | `isbn`, `genre` |
| Status | `stage's short_label` (or Display) |
| Published | `publication_date:formatted as 14 Nov 2026`; conditional when empty → "Not yet published" |
| MRP | `mrp:formatted as ₹#,##0`; empty → "–" |
| Available on | `available_on:each item's Display:join with ", "` |
| Print partner | `print_partner's Display` |
| Copies sold | `copies_sold` |
| Earned / Paid / Pending | `royalty_earned`, `royalty_paid`, `royalty_pending` (₹ formatted) |
| Last payout | `last_payout_date:formatted as …`; empty → "Never" |
| **Royalty badge** | Group `badge` with a Text inside, see below |

**Badge conditionals** (in this order, because the last match wins):

| # | When | Background | Text |
|---|---|---|---|
| default | – | `#E5E7EB` grey | "No royalties yet" |
| 1 | `Current cell's Book's stage's is_published is yes and royalty_pending = 0` | `#DCFCE7` green | "Paid up" |
| 2 | `Current cell's Book's royalty_pending > 0` | `#FEF3C7` yellow | "Pending: within payout cycle" |
| 3 | `…royalty_pending > 0 and Parent group's Author's total_pending < 1000` | `#FEF3C7` yellow | "Pending: below ₹1,000 minimum, rolls over" |
| 4 | `…overdue_on is not empty and …overdue_on < Current date/time` | `#FEE2E2` red | "Overdue" |

This is the same rule as `n8n/src/lib/royalty.js → bookBadge()`, which is unit-tested against the dataset (`npm test`).

### 8.3 `re_payout_history` (Type of content: **Author**)
Repeating group, type **RoyaltyPayout**: `Search for RoyaltyPayouts (author = Parent group's Author)` sorted by `payout_date`, descending. Columns: date, book's title, amount, reference/note. Empty state text: "No payouts yet."

---

## 9. Pages and workflows

### 9.1 `index`: login
- Inputs: Email, Password (type password). Button **Log in**. A text `error` (hidden by default).
- Workflow *Button Log in is clicked*:
  1. **Log the user in** (email, password)
  2. **Go to page** `admin`, *Only when* `Current User's role is Admin`
  3. **Go to page** `dashboard`, *Only when* `Current User's role is Author`
- Event *An unhandled error occurs* → show the `error` text ("Wrong email or password").
- *Page is loaded* + `Current User is logged in` → redirect by role (same as steps 2–3).

### 9.2 `dashboard`: author portal
- *Page is loaded*: **Go to page** `index` *only when* `Current User is logged out`. **Go to page** `admin` *only when* `Current User's role is Admin`.
- Header: "Welcome, `Current User's author's name`" · **Log out** button (Log the user out → index).
- `re_royalty_summary`, `re_book_table` and `re_payout_history`, each with data source `Current User's author`.

The page itself never filters by "my user". Data isolation comes from the privacy rules. If a rule were missing, the author would see an empty table (no rule = no access), never someone else's books.

### 9.3 `admin`: operations overview
*Page is loaded*: redirect to `index` unless `Current User's role is Admin`.

**Filters**
- Input `search_name` (placeholder "Search author name")
- Dropdown `city`: dynamic choices `Search for Authors:each item's city:unique`, sorted
- Dropdown `payout_status`: choices *All PayoutFilters*, placeholder "Any payout status"

**Authors repeating group** (type Author). ✅ *Ignore empty constraints* on every search below.
- Default data source: `Search for Authors (name contains search_name's value, city = city's value)` sorted by `total_pending` descending
- Conditionals on the repeating group (data source):
  - `payout_status's value is Fully paid` → same search + `total_pending = 0`
  - `payout_status's value is Pending` → same search + `total_pending > 0`, then `:filtered` (Advanced: `This Author's earliest_overdue_on is empty or This Author's earliest_overdue_on ≥ Current date/time`)
  - `payout_status's value is Overdue` → same search + `total_pending > 0` + `earliest_overdue_on < Current date/time`
- Cell: name · city · `total_books` · `total_earned` · `total_pending` · status badge (grey/green/yellow/red, same idea as 8.2 but using `total_pending` and `earliest_overdue_on`) · last summary (`last_summary_status's Display` + `last_summary_at`) · **View** button → *Go to page* `admin_author`, data to send `Current cell's Author`.

**Bulk trigger**: button **Send summaries to all authors with pending royalties**
Page custom states: `bulk_queue` (Author, list), `bulk_index` (number), `bulk_running` (yes/no), `bulk_busy` (yes/no), `bulk_ok` / `bulk_failed` (number).

Workflow *Bulk button is clicked* (*Only when* `bulk_running is no`):
1. **Set state**: `bulk_queue = Search for Authors (total_pending > 0)`, `bulk_index = 1`, `bulk_ok = 0`, `bulk_failed = 0`, `bulk_running = yes`

Workflow *Do every 2 seconds* (*Only when* `bulk_running is yes and bulk_busy is no`). This sends one author per tick, so the same webhook is called once per eligible author:
1. Set state `bulk_busy = yes`
2. **Create a new NotificationLog**: author = `bulk_queue:item #bulk_index`, status = Queued, source = `bulk`, triggered_by = Current User, requested_at = Current date/time.
   *Only when* `Search for NotificationLogs (author = bulk_queue:item #bulk_index, status's is_final = no, requested_at > Current date/time +(minutes) -10):count is 0` (skips authors who already have a run in progress)
3. **n8n BookLeaf – Trigger Royalty Summary**: author_id = `bulk_queue:item #bulk_index's unique id`, log_id = `Result of step 2's unique id`, source = `bulk`, triggered_by = `Current User's email`. *Only when* `Result of step 2 is not empty`
4. **Make changes to** `Result of step 2`: status = Failed (or Skipped when `error status code is 409`), `http_status`, `error_message = "n8n rejected the request (HTTP " & error status code & "): " & error body`, completed_at = now. *Only when* `Result of step 3's returned an error is yes`
5. Set state `bulk_failed + 1` *(only when error)* / `bulk_ok + 1` *(only when not error)*
6. Set state `bulk_index = bulk_index + 1`, `bulk_busy = no`
7. *Only when* `bulk_index > bulk_queue:count` → set `bulk_running = no` → **Show alert** "Queued `bulk_ok` summaries, `bulk_failed` could not be sent."

Progress text under the button (visible when `bulk_running`): "Sending `bulk_index`/`bulk_queue:count`…"

> Why a page loop: it works on every plan and shows live progress. On a paid plan the same thing can run in the background with **Schedule API workflow on a list** (`Search for Authors (total_pending > 0)`, interval 2 s) and a backend workflow that does steps 2–4. The n8n side is the same either way.

**Notification log** (repeating group, type NotificationLog): `Search for NotificationLogs` sorted by `requested_at` descending. Bubble searches update live, so a row changes from Queued → Processing → Success/Failed as n8n reports back, without a page refresh.
- Columns: author's name · source · requested_at · completed_at · status badge (background = `status's color`) · `email_sent` ("Emailed" / "Logged only") · error_message · **View email** (opens popup with subject + body)
- Conditional on the status text: `status's is_final is no and requested_at < Current date/time +(minutes) -10` → text "Stalled: check n8n execution `n8n_execution_id`", red. This catches the one case n8n can't report: n8n itself being down after accepting.

**Author accounts** (section from step 7.3), plus **Log out**.

### 9.4 `admin_author`: author detail (Type of content: **Author**)
*Page is loaded*: redirect unless admin.
- Author header: name, email, phone, city, joined date, last summary
- `re_royalty_summary`, `re_book_table`, `re_payout_history` with data source `Current page Author`. These are the same components the author sees.
- Button **Generate & Send Royalty Summary**
- Button **Recalculate totals** (refreshes the cached fields: `total_books = Search for Books(author = Current page Author):count`, `total_earned = …:sum royalty_earned`, and so on, plus `earliest_overdue_on = Search for Books(author = …, overdue_on is not empty):sorted by overdue_on:first item's overdue_on`)
- A small repeating group: `Search for NotificationLogs (author = Current page Author)`, sorted newest first

Page custom state `is_sending` (yes/no).

**Workflow *Generate & Send is clicked*** (*Only when* `is_sending is no`)
1. **Set state** `is_sending = yes`. Button conditional: when `is_sending` → text "Sending…", *This element isn't clickable*. This blocks a double click instantly in the browser.
2. **Show alert** "A summary for this author is already in progress." → **Set state** `is_sending = no` → **Terminate this workflow**. *Only when* `Search for NotificationLogs (author = Current page Author, status's is_final = no, requested_at > Current date/time +(minutes) -10):count > 0`. This blocks a second admin, or a second tab.
3. **Create a new NotificationLog**: author = Current page Author, status = Queued, source = `single`, triggered_by = Current User, requested_at = Current date/time
4. **n8n BookLeaf – Trigger Royalty Summary**: author_id = `Current page Author's unique id`, log_id = `Result of step 3's unique id`, source = `single`, triggered_by = `Current User's email`
5. **Make changes to** `Result of step 3`: status = `Skipped` if `Result of step 4's error status code is 409`, otherwise `Failed`; http_status = error status code; error_message = `"n8n rejected the request (HTTP " & Result of step 4's error status code & "): " & Result of step 4's error body`; completed_at = Current date/time. *Only when* `Result of step 4's returned an error is yes`
   *(Bubble can't put a conditional inside a field value, so use two "Make changes" actions, one with `error status code is 409` and one with `is not 409`.)*
6. **Show alert** "Could not start the summary: `error body`". *Only when* error.
7. **Show alert** "Summary queued. The log below updates when n8n finishes." *Only when* not error.
8. **Set state** `is_sending = no`. This always runs, so the button never stays stuck on "Sending…".

What the admin sees in each failure case:
| Situation | What happens | Admin sees |
|---|---|---|
| n8n down / URL wrong / wrong key | API call errors (connection error or 403) | Alert with the error. Log row **Failed** with reason. |
| Bad payload | n8n 400 | Alert. Log **Failed**. |
| Double click / second admin | Button disabled; step 2 search; n8n 409 if both get through | "Already in progress", or log **Skipped** |
| Bubble Data API down (seen by n8n) | n8n 502 before accepting | Alert. Log **Failed** "n8n could not reach the Bubble Data API". |
| AI fails / bad output / SMTP fails | n8n has accepted (202) and reports later | Log turns **Failed** with the failed step and reason |
| n8n dies mid-run | No callback | Log shows **Stalled** after 10 min, with the n8n execution id |

### 9.5 `set_password`
Inputs: new password + confirm. Button: **Update the user's credentials** (password) → go to `dashboard`.

---

## 10. Test checklist

- [ ] Log in as Priya → 2 books, totals ₹19,908 earned / ₹16,338 paid / ₹3,570 pending. *Whispers of the Ganges* shows red (as of Nov 2026), *The Saffron Diaries* green.
- [ ] Log in as Kavita → *Raising Roots* grey "No royalties yet". *The Nagpur Notebooks* yellow "below ₹1,000 minimum".
- [ ] As Priya, try to open `admin` or `admin_author` → redirected to `index`. Privacy rules return nothing for other authors.
- [ ] Admin: filter city = Nagpur → Kavita only. Status Overdue → 8 authors. Fully paid → Farhan.
- [ ] Admin → Rohit → Generate & Send → log Queued → Processing → Success within ~15 s; "View email" shows the AI email.
- [ ] Double-click Generate & Send → only one run (second is blocked or Skipped).
- [ ] Turn the n8n workflow off → click → alert + log **Failed** (HTTP 404 from n8n).
- [ ] Put a wrong Claude key in n8n → log **Failed**, step "Claude: Generate Email".
- [ ] Bulk → 9 authors queued (everyone except Farhan); log fills in.
