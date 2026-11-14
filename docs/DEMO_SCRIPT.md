# Screen recording script (target: 4 minutes)

Before recording: n8n workflow **active**, Bubble data seeded, logins created, one browser window for Bubble and one for n8n (*Executions* tab open). Use a normal window for admin and a private window for the author.

| Time | Screen | Show | Say (short) |
|---|---|---|---|
| 0:00 | README diagram | the architecture | "Bubble is the app, n8n does the automation, Claude writes the email. Bubble sends only ids, and n8n reads everything from Bubble." |
| 0:20 | Bubble editor → Data | data types and option sets, Book's `overdue_on` | "Authors have books, books have payouts. Statuses are option sets. 'Overdue' is stored as a date, so it never goes stale." |
| 0:45 | Data → Privacy | the Owner and Admins rules on Book | "Authors can only see records whose owner_user is them. Logs are admin-only." |
| 1:00 | Private window: log in as Priya | dashboard: summary cards, book table, badges, payout history | "Two books, one paid up (green), one overdue (red), totals at the top." |
| 1:30 | Same window: open `/admin` | redirected to the login page | "An author can't open admin pages, and the privacy rules return nothing else anyway." |
| 1:40 | Admin window | author list. Filter **Overdue**, then city **Nagpur**, then search "Rohit" | "Totals are cached on Author, so these filters are one database search." |
| 2:05 | Rohit's detail page | click **Generate & Send**. Double-click to show the second click is blocked. | "The log is created as Queued first. n8n answers in a second, so no spinner." |
| 2:20 | n8n Executions | the run going green node by node. Open *Build Royalty Context* output (the facts) and *Claude* output | "All maths is done here in code. Claude only writes the wording, and the validator checks every rupee amount against the data." |
| 2:55 | Bubble log | row goes Processing → Success. Click **View email** and read the overdue paragraph. | "Personal greeting, each book, totals, an apology for the overdue payout with a 48-hour follow-up." |
| 3:20 | Kavita (optional) | send, open the email | "Below the ₹1,000 minimum: it rolls over. Plus the update on the book in typesetting." |
| 3:35 | n8n: break the Claude credential, send again | log row → **Failed**: "Claude: Generate Email – HTTP 401" | "Every step after the 202 has an error branch that reports Failed to Bubble with the step name." |
| 3:50 | Admin: **Bulk** button | progress counter, log filling up | "Same webhook, once per author with pending royalties: nine authors." |
| 4:10 | end | – | – |

Restore the Claude credential after the failure demo.
