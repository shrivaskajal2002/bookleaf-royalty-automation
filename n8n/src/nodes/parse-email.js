//@include royalty
//@include ai
// Step 3b: read the AI's answer and check it before it is sent or saved.
// The validator rejects emails that drop a book, miss a required total, or contain an amount
// that is not in the source data.
const cfg = $('Config').first().json;
const ctxNode = $('Build Royalty Context').first().json;
const ai = parseAiResponse($input.first().json);
const attempt = $('Build Retry Request').isExecuted ? 2 : 1;

const result = (fields) => [{ json: { attempt, max_attempts: Number(cfg.AI_MAX_ATTEMPTS || 2), ...fields } }];

if (ai.outcome === 'refused') {
  return result({ ok: false, retryable: false, reason: 'The AI declined the request (safety/policy block)' });
}
if (ai.outcome === 'truncated') {
  return result({ ok: false, retryable: true, reason: 'The AI output was cut off (token limit)' });
}
if (ai.outcome === 'empty') {
  return result({ ok: false, retryable: true, reason: 'The AI returned an empty answer' });
}

let email;
try {
  email = JSON.parse(ai.text);
} catch (e) {
  return result({ ok: false, retryable: true, reason: 'The AI output was not valid JSON', draft: ai.text });
}

const problems = validateEmail(email, ctxNode.context);
if (problems.length) {
  return result({ ok: false, retryable: true, reason: `The AI email failed validation: ${problems.join('; ')}`, problems, draft: email });
}

return result({
  ok: true,
  subject: email.subject.trim(),
  body: email.body.trim(),
  recipient: cfg.EMAIL_TEST_RECIPIENT || ctxNode.author_email,
  intended_recipient: ctxNode.author_email,
  model: ai.model,
  usage: ai.usage,
});
