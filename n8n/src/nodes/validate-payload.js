//@include bubble
// Steps 1 + 2: check the webhook body and read the author's data from it.
// The Webhook node has already checked the X-BookLeaf-Key header (Header Auth credential),
// so anything that reaches this node came from Bubble.
//
// Why the full payload instead of querying Bubble's Data API: the Data API is blocked on Bubble's
// free plan. Bubble already holds exactly the data the author sees, so it sends that.
const cfg = $('Config').first().json;
const body = $('Webhook').first().json.body || {};
const p = normalizePayload(body, cfg.DATA_TIMEZONE);

return [{
  json: {
    ok: p.errors.length === 0,
    errors: p.errors,
    log_id: p.log_id,
    source: p.source,
    author: p.author,
    books: p.books,
    payouts: p.payouts,
    received_at: new Date().toISOString(),
    execution_id: String($execution.id),
    response: p.errors.length
      ? summaryResponse({ status: 'Failed', log_id: p.log_id, failed_step: 'Validate Payload', error_message: `Bad request from Bubble: ${p.errors.join('; ')}`, n8n_execution_id: String($execution.id) })
      : null,
  },
}];
