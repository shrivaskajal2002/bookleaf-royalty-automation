// Settings that are not secret. Secrets (Claude API key, SMTP login, webhook key) live in
// n8n Credentials, so they never show up in this node or in the exported JSON.
return [{
  json: {
    // Bubble's free plan blocks inbound API calls, so Bubble sends the author's data in the webhook
    // body and n8n replies to that same request with the result. No Bubble URL or token is needed.
    // DATA_TIMEZONE is the time zone the app's dates were entered in, used to read them as calendar dates.
    DATA_TIMEZONE: 'Asia/Kolkata',

    // 'gemini' = Google Gemini API, free tier (key from aistudio.google.com, no card needed).
    // 'anthropic' = Claude (set AI_MODEL to 'claude-opus-5-5' or 'claude-haiku-5-5').
    // The "AI API Key" credential must match: header x-goog-api-key (Gemini) or x-api-key (Anthropic).
    AI_PROVIDER: 'gemini',
    AI_MODEL: 'gemini-4-hydrogen',
    AI_EFFORT: 'medium',           // Anthropic only
    AI_MAX_ATTEMPTS: 2,            // one retry, with the validator's notes, if the first draft fails checks

    // Bonus: actually send the email over SMTP. The dataset's author emails are fake, so while
    // testing send everything to EMAIL_TEST_RECIPIENT instead (the log still records the real author).
    SEND_EMAIL: false,
    EMAIL_FROM: 'BookLeaf Royalties <royalties@example.com>',
    EMAIL_TEST_RECIPIENT: '',

    // Duplicate protection on the n8n side (Bubble also blocks double clicks, see README).
    DEDUPE_WINDOW_SECONDS: 120,    // a second request for the same author within this window is Skipped
    SEEN_LOG_TTL_SECONDS: 3600,    // the same log_id is never processed twice within this window

    // Leave empty to use today's date. Set e.g. '2026-01-10' to demo the "pending, on schedule" wording.
    TODAY_OVERRIDE: '',
  },
}];
