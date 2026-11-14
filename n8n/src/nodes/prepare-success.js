//@include bubble
// Steps 4 + 5: the result Bubble writes into the Notification Log (status, timestamp, the email).
const v = $('Validate Payload').first().json;
const email = $('Parse & Validate Email').last().json;
const sent = $('Send Email (SMTP)').isExecuted;

return [{
  json: {
    response: summaryResponse({
      ok: true,
      status: 'Success',
      log_id: v.log_id,
      email_subject: email.subject,
      email_body: email.body,
      email_sent: sent,
      recipient: sent ? email.recipient : email.intended_recipient,
      ai_model: email.model,
      n8n_execution_id: v.execution_id,
      completed_at: new Date().toISOString(),
    }),
  },
}];
