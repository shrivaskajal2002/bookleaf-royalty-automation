//@include bubble
// Shared failure handler. Every step after the idempotency gate sends its error output here.
// It works out which step failed, releases the per-author lock so the admin can retry right away,
// and answers Bubble with status "Failed" and a readable reason. The run then ends with
// Stop and Error, so the execution also shows as failed in n8n (and the error workflow alerts ops).
const v = $('Validate Payload').first().json;
const input = $input.first().json;

// The flow is linear, so the last step that ran is the one that failed.
const STEPS = ['Build Royalty Context', 'AI: Generate Email', 'Parse & Validate Email', 'Send Email (SMTP)'];
const ran = (name) => { try { return $(name).isExecuted; } catch (e) { return false; } };
const failedStep = [...STEPS].reverse().find(ran) || 'Unknown step';

const FRIENDLY = {
  'Build Royalty Context': 'Could not prepare the royalty data',
  'AI: Generate Email': 'The AI service did not respond successfully',
  'Parse & Validate Email': 'The AI-generated email did not pass the checks',
  'Send Email (SMTP)': 'The email was generated but could not be delivered over SMTP',
};

const err = input.error;
let reason = input.reason
  || (err && (err.description || err.message))
  || (typeof err === 'string' ? err : null)
  || 'Unknown error';
if (err && err.httpCode) reason = `HTTP ${err.httpCode}: ${reason}`;
const errorMessage = `${FRIENDLY[failedStep] || 'Step failed'}. ${reason}`.slice(0, 1000);

// A failed run should not block an immediate retry (a retry click creates a new log_id).
const store = $getWorkflowStaticData('global');
if (store.locks && v.author) delete store.locks[v.author.bubble_id];

// If the email was generated before the failure (for example SMTP failed), keep it in the log.
let email = null;
if (ran('Parse & Validate Email')) {
  const parsed = $('Parse & Validate Email').last().json;
  if (parsed && parsed.ok) email = parsed;
}

return [{
  json: {
    failed_step: failedStep,
    error_message: errorMessage,
    response: summaryResponse({
      status: 'Failed',
      log_id: v.log_id,
      failed_step: failedStep,
      error_message: errorMessage,
      email_subject: email ? email.subject : '',
      email_body: email ? email.body : '',
      email_sent: false,
      recipient: email ? email.intended_recipient : '',
      n8n_execution_id: v.execution_id,
      completed_at: new Date().toISOString(),
    }),
  },
}];
