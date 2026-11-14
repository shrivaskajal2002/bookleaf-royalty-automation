//@include ai
// One retry: send the same facts again, with the validator's notes and the rejected draft.
// This is a new single-turn request (not a follow-up turn), so the model gets a clean prompt.
const cfg = $('Config').first().json;
const ctxNode = $('Build Royalty Context').first().json;
const failed = $input.first().json;
const draft = typeof failed.draft === 'string' ? failed.draft : JSON.stringify(failed.draft || {}, null, 2);
const notes = (failed.problems || [failed.reason]).map((p) => `- ${p}`).join('\n');

const userText = `${ctxNode.user_text}

A previous draft of this email was rejected by our automated checks for these reasons:
${notes}

<rejected_draft>
${draft}
</rejected_draft>

Write a corrected email. Copy amounts, titles and dates exactly from the facts.`;

const call = buildAiCall(cfg, ctxNode.system, userText);
return [{ json: { url: call.url, request: call.body, user_text: userText } }];
