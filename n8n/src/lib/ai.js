/*
 * One small adapter so the workflow can use either AI provider with the same nodes.
 *   AI_PROVIDER 'gemini'    → Google Gemini API (free tier, no card needed; default)
 *   AI_PROVIDER 'anthropic' → Claude Messages API
 * The n8n HTTP node sends { url, body } from buildAiCall with the "AI API Key" Header Auth
 * credential (header x-goog-api-key for Gemini, x-api-key for Anthropic).
 * Inlined into Code nodes by build-workflow.mjs, same as royalty.js.
 */

const EMAIL_FIELDS = {
  subject: 'Email subject line, under 80 characters',
  body: 'Plain-text email body, greeting to sign-off',
};

function buildAiCall(cfg, system, userText) {
  const provider = String(cfg.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'anthropic') {
    return {
      provider,
      url: 'https://api.anthropic.com/v1/messages',
      body: {
        model: cfg.AI_MODEL || 'claude-opus-5-5',
        max_tokens: 16000,
        output_config: {
          effort: cfg.AI_EFFORT || 'medium',
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: Object.fromEntries(Object.entries(EMAIL_FIELDS).map(([k, d]) => [k, { type: 'string', description: d }])),
              required: Object.keys(EMAIL_FIELDS),
              additionalProperties: false,
            },
          },
        },
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: userText }],
      },
    };
  }
  const model = cfg.AI_MODEL || 'gemini-4-hydrogen';
  return {
    provider: 'gemini',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: Object.fromEntries(Object.entries(EMAIL_FIELDS).map(([k, d]) => [k, { type: 'STRING', description: d }])),
          required: Object.keys(EMAIL_FIELDS),
          propertyOrdering: Object.keys(EMAIL_FIELDS),
        },
      },
    },
  };
}

/**
 * Normalises either provider's response to { outcome, text, model, usage }.
 * outcome: 'ok' | 'refused' (policy/safety block: don't retry) | 'truncated' (hit the token limit) | 'empty'
 */
function parseAiResponse(res) {
  res = res || {};
  if (Array.isArray(res.candidates) || res.promptFeedback) {
    const c = (res.candidates || [])[0];
    const model = res.modelVersion || 'gemini';
    if (!c) {
      return { outcome: res.promptFeedback && res.promptFeedback.blockReason ? 'refused' : 'empty', text: '', model, usage: res.usageMetadata || null };
    }
    const text = ((c.content && c.content.parts) || []).map((p) => p.text || '').join('');
    const reason = c.finishReason || 'STOP';
    let outcome = 'ok';
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) outcome = 'refused';
    else if (reason === 'MAX_TOKENS') outcome = 'truncated';
    else if (!text) outcome = 'empty';
    return { outcome, text, model, usage: res.usageMetadata || null };
  }
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let outcome = 'ok';
  if (res.stop_reason === 'refusal') outcome = 'refused';
  else if (res.stop_reason === 'max_tokens') outcome = 'truncated';
  else if (!text) outcome = 'empty';
  return { outcome, text, model: res.model || 'claude', usage: res.usage || null };
}

// --- exports (stripped in build) ---
if (typeof module !== 'undefined') {
  module.exports = { buildAiCall, parseAiResponse };
}
