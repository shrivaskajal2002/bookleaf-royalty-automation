# Screen recording script (about 4 minutes)

**Tool:** Loom (free, up to 5 min, gives a share link) or Windows Snipping Tool (Win + Shift + R, then upload the MP4 to Google Drive as "Anyone with the link").

**Before recording:** close the Claude side panel, Notepad and anything showing passwords or keys. Zoom the browser to 90%. Open three tabs:
1. Incognito: `https://shrivaskajal2002.bubbleapps.io/version-test/index` (logged out)
2. n8n: the workflow, **Editor** tab
3. n8n: the same workflow, **Executions** tab

---

## 0:00 Intro (15 s)
> "Hi, I'm Kajal. This is my BookLeaf Royalty Dashboard, built in Bubble with n8n and an AI model. I'll show the author portal, the admin portal, a royalty summary being generated, and the n8n workflow."

## 0:15 Author portal (45 s)
- Log in as `kavita.deshmukh@email.com`.
> "Authors log in with email and password. Kavita sees only her own two books. That's enforced by Bubble privacy rules on the server, not just a page filter."
- Point at the cards and the badges.
> "The summary shows total earned, paid and pending. Each book has a status badge. This one is Pending, because ₹850 is under the ₹1,000 payout minimum, so it rolls over and isn't overdue. This one is In production."
- Log out.

## 1:00 Admin portal (45 s)
- Log in as `admin@bookleaf.test`.
> "The admin sees every author with total books, earnings and pending payouts."
- Status filter → Overdue, then a city, then type a name in search, then clear.
> "I can filter by payout status and city, and search by name."
- Click **Sneha Kulkarni**.
> "The detail page shows the same data the author sees: books, royalties and payout history."

## 1:45 Generate & Send (60 s)
- Click **Generate & Send Royalty Summary**.
> "This creates a notification log entry and calls my n8n webhook, protected with a secret header. While it runs, the button shows Sending… and can't be clicked twice."
- Switch to the n8n **Executions** tab and refresh.
> "In n8n the workflow validates the data, calculates every figure in code, asks the AI to write the email, then checks that every amount in the email matches the data."
- Back to the admin page → **Notification log**.
> "It came back as Success, with the email. This Skipped row is the duplicate protection from when I clicked twice."

## 2:45 Bulk (25 s)
- Click **Send summaries to all pending**.
> "The bulk button sends a summary to every author with pending royalties. It calls the same webhook once per author, one at a time."
- Show one or two new rows appearing (no need to wait for all of them).

## 3:10 n8n workflow tour (50 s)
- n8n **Editor** tab; move across the canvas left to right.
> "Section 1 is security and intake: header auth, payload validation, and an idempotency gate that skips duplicates. Section 2 builds the royalty facts in code, including the quarterly cycle and 45-day window. The AI only writes the wording as JSON; a validator checks it and retries once if needed. Section 3 is failure handling: any error returns Failed with the step name, and the run is marked failed in n8n, so nothing fails silently."

## 4:00 Wrap-up (15 s)
> "One note: Bubble's free plan blocks inbound API calls, so instead of a callback, n8n replies in the same request and Bubble writes the result to the log. The README on GitHub explains the design. Thank you!"

---

**Tips**
- The AI takes about 30–40 seconds. Fill that time with the n8n Executions tab.
- If a run shows Failed (503 overloaded), keep going: "Here the free AI tier was overloaded, and the error is logged clearly." That shows the error handling working.
