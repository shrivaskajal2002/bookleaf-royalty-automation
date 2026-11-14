//@include bubble
// Step 1b: only one run per request, and only one run per author at a time.
//
// Layer 1 (Bubble): the button is disabled while a request is in flight, and the workflow won't
//   start if this author already has a "Processing" log from the last 2 minutes.
// Layer 2 (here, same log_id): a replayed request for a log already seen is Skipped.
// Layer 3 (here, per-author lock): two clicks can create two different logs. A short lock skips a
//   second request for the same author within DEDUPE_WINDOW_SECONDS.
// State lives in workflow static data. n8n only saves it for active (production) executions,
// not manual test runs, which is fine: real duplicates come from the live webhook.
const cfg = $('Config').first().json;
const v = $('Validate Payload').first().json;

const store = $getWorkflowStaticData('global');
store.locks = store.locks || {};
store.seen = store.seen || {};
const now = Date.now();
const lockTtl = Number(cfg.DEDUPE_WINDOW_SECONDS || 120) * 1000;
const seenTtl = Number(cfg.SEEN_LOG_TTL_SECONDS || 3600) * 1000;
for (const [k, t] of Object.entries(store.locks)) if (now - t > lockTtl) delete store.locks[k];
for (const [k, t] of Object.entries(store.seen)) if (now - t > seenTtl) delete store.seen[k];

const skip = (reason) => [{
  json: {
    proceed: false,
    response: summaryResponse({ status: 'Skipped', log_id: v.log_id, failed_step: 'Idempotency Gate', error_message: reason, n8n_execution_id: v.execution_id }),
  },
}];

if (store.seen[v.log_id]) return skip('Duplicate request: this notification log was already processed');
const authorKey = v.author.bubble_id;
if (store.locks[authorKey]) {
  const ago = Math.round((now - store.locks[authorKey]) / 1000);
  return skip(`Duplicate request: a summary for ${v.author.name} started ${ago}s ago`);
}
store.seen[v.log_id] = now;
store.locks[authorKey] = now;

return [{ json: { proceed: true } }];
