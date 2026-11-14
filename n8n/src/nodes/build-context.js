//@include royalty
//@include bubble
//@include ai
// Step 2b: turn the author's records (sent by Bubble) into facts and build the AI request.
// All numbers, dates and the payout situation are worked out here, in code (see lib/royalty.js).
// The model only writes the wording.
const cfg = $('Config').first().json;
const v = $('Validate Payload').first().json;
const { author, books, payouts } = v;

// "Today" in BookLeaf's time zone: n8n Cloud runs on UTC, which is still yesterday until 05:30 IST.
const today = cfg.TODAY_OVERRIDE || localDate(new Date().toISOString(), cfg.DATA_TIMEZONE);
const context = buildAuthorContext(author, books, payouts, today);

const SYSTEM_PROMPT = __SYSTEM_PROMPT__;
const userText = `Write the royalty summary email for this author.\n\n<facts>\n${JSON.stringify(context.facts, null, 2)}\n</facts>`;
const call = buildAiCall(cfg, SYSTEM_PROMPT, userText);

return [{
  json: {
    url: call.url,
    request: call.body,
    provider: call.provider,
    system: SYSTEM_PROMPT,
    user_text: userText,
    context,
    author_email: author.email,
    author_name: author.name,
  },
}];
