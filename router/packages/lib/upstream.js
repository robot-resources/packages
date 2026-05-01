/**
 * Per-provider upstream configuration for the in-process router's HTTP server.
 *
 * The plugin registers one OC catalog provider with three virtual models, each
 * declaring its lab-native API shape (`anthropic-messages`, `openai-responses`,
 * `google-generative-ai`). OC dispatches with the matching shape to a path on
 * our loopback baseUrl; this module maps (provider, inbound path) → upstream
 * URL + auth headers.
 *
 * No cross-shape body translation. Each shape stays native end to end:
 *   - anthropic: body.model carries the chosen model; URL fixed to /v1/messages
 *   - openai:    body.model carries the chosen model; URL fixed to /v1/responses
 *   - google:    URL path carries the chosen model (`models/{id}:streamGenerateContent`);
 *                body has no `model` field, so dispatch rewrites the path.
 *
 * Path-prefix convention: each provider gets a top-level prefix on the local
 * server (`/anthropic`, `/openai`, `/google`) so OC's transport-built URLs
 * land on the correct shape handler. The catalog's per-model `baseUrl`
 * carries that prefix.
 */

export const PROVIDERS = ['anthropic', 'openai', 'google'];

const LOCAL_PREFIX = {
  anthropic: '/anthropic',
  openai: '/openai',
  google: '/google',
};

const UPSTREAM_ORIGIN = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
};

const OC_API_STRING = {
  anthropic: 'anthropic-messages',
  openai: 'openai-responses',
  google: 'google-generative-ai',
};

export function localBaseUrlPath(provider) {
  // Returned as the trailing portion of the catalog-published baseUrl.
  // OC appends its own per-shape suffix:
  //   anthropic-messages: <baseUrl>/v1/messages  (resolveAnthropicMessagesUrl)
  //   openai-responses:   <baseUrl>/responses    (OpenAI SDK on baseUrl=`.../v1`)
  //   google-generative-ai: <baseUrl>/models/{id}:streamGenerateContent
  switch (provider) {
    case 'anthropic': return LOCAL_PREFIX.anthropic;
    case 'openai':    return `${LOCAL_PREFIX.openai}/v1`;
    case 'google':    return `${LOCAL_PREFIX.google}/v1beta`;
    default: throw new Error(`unknown provider: ${provider}`);
  }
}

export function ocApiString(provider) {
  return OC_API_STRING[provider];
}

/**
 * Match an inbound request URL to a provider. Recognizes both the multi-shape
 * prefix (`/anthropic/...`) and bare lab-native URLs (`/v1/messages`,
 * `/v1/responses`, `:generateContent`). The bare-URL fallback is what the
 * v2.x python daemon used — it's resilient when OC dispatches via
 * provider.baseUrl (no prefix) instead of model.baseUrl (prefixed).
 */
export function detectProviderFromUrl(url) {
  if (!url) return null;
  // Multi-shape prefix path.
  if (url.startsWith(LOCAL_PREFIX.anthropic + '/')) return 'anthropic';
  if (url.startsWith(LOCAL_PREFIX.openai + '/')) return 'openai';
  if (url.startsWith(LOCAL_PREFIX.google + '/')) return 'google';
  // Bare lab-native path. Each lab's API path is already unique, so the URL
  // semantics alone identify the shape.
  const path = url.split('?')[0];
  if (path.endsWith('/messages') || path.endsWith('/v1/messages')) return 'anthropic';
  if (path.endsWith('/responses') || path.endsWith('/chat/completions')) return 'openai';
  if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) return 'google';
  return null;
}

/**
 * Build the upstream URL for a request that landed on this server.
 *
 * For anthropic + openai: strip the local prefix; the upstream path
 * (`/v1/messages`, `/v1/responses`) is preserved as-sent.
 *
 * For google: strip the local prefix AND swap the model id in the
 * `models/{id}:method` segment to chosenModel. The body has no `model`
 * field for the google generateContent API; rewriting the path is how the
 * router exercises model selection within the google shape.
 */
export function buildUpstreamUrl({ provider, inboundUrl, chosenModel }) {
  const prefix = LOCAL_PREFIX[provider];
  if (!prefix) throw new Error(`unknown provider: ${provider}`);

  // Strip the multi-shape prefix only if it's present. Bare lab-native URLs
  // (e.g. `/v1/messages` from OC's provider.baseUrl path) pass through as-is.
  let suffix = inboundUrl.startsWith(prefix + '/') ? inboundUrl.slice(prefix.length) : inboundUrl;

  if (provider === 'google' && chosenModel) {
    // Replace 'models/<old>:method' → 'models/<new>:method'. Keep query string intact.
    suffix = suffix.replace(/\/models\/[^:?]+(?=[:?])/, `/models/${encodeURIComponent(chosenModel)}`);
  }

  return UPSTREAM_ORIGIN[provider] + suffix;
}

/**
 * Build the outgoing request headers for a provider, given the user's API
 * key and the inbound request headers (used for pass-through hints like
 * `anthropic-version` / `anthropic-beta`).
 */
export function buildUpstreamHeaders({ provider, apiKey, inboundHeaders = {} }) {
  switch (provider) {
    case 'anthropic': {
      const headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': inboundHeaders['anthropic-version'] || '2023-06-01',
      };
      const beta = inboundHeaders['anthropic-beta'];
      if (beta) headers['anthropic-beta'] = Array.isArray(beta) ? beta.join(',') : beta;
      return headers;
    }
    case 'openai': {
      const headers = {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      };
      const orgHeader = inboundHeaders['openai-organization'];
      if (orgHeader) headers['openai-organization'] = orgHeader;
      const projectHeader = inboundHeaders['openai-project'];
      if (projectHeader) headers['openai-project'] = projectHeader;
      return headers;
    }
    case 'google': {
      return {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      };
    }
    default:
      throw new Error(`unknown provider: ${provider}`);
  }
}

/**
 * Extract the latest user-text prompt from a per-shape request body. Returns
 * null if no user text is present (e.g. tool-result-only continuation).
 *
 * Shapes:
 *   - anthropic Messages: body.messages[].role === 'user' / .content (string|blocks)
 *   - openai Responses:   body.input as string OR array of {role, content}
 *   - google generateContent: body.contents[].role === 'user' / .parts[].text
 */
export function extractUserText(provider, body) {
  if (!body || typeof body !== 'object') return null;
  switch (provider) {
    case 'anthropic': return extractAnthropicUserText(body);
    case 'openai':    return extractOpenAIUserText(body);
    case 'google':    return extractGoogleUserText(body);
    default: return null;
  }
}

function extractAnthropicUserText(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const txt = m.content.find((b) => b?.type === 'text' && typeof b.text === 'string');
      if (txt) return txt.text;
    }
  }
  return null;
}

function extractOpenAIUserText(body) {
  const input = body.input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const m = input[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const txt = m.content.find((b) => (b?.type === 'input_text' || b?.type === 'text') && typeof b.text === 'string');
      if (txt) return txt.text;
    }
  }
  return null;
}

function extractGoogleUserText(body) {
  const contents = body.contents;
  if (!Array.isArray(contents)) return null;
  for (let i = contents.length - 1; i >= 0; i--) {
    const m = contents[i];
    if (m?.role !== 'user') continue;
    const parts = m.parts;
    if (!Array.isArray(parts)) continue;
    const txt = parts.find((p) => typeof p?.text === 'string');
    if (txt) return txt.text;
  }
  return null;
}

/**
 * Apply the chosen model to the per-shape outbound body. For anthropic and
 * openai, the model lives in body.model. For google, it's in the URL path
 * (handled by buildUpstreamUrl), so this is a no-op.
 */
export function applyChosenModelToBody(provider, body, chosenModel) {
  if (!body || typeof body !== 'object' || !chosenModel) return body;
  switch (provider) {
    case 'anthropic':
    case 'openai':
      body.model = chosenModel;
      return body;
    case 'google':
      return body; // model goes in the URL
    default:
      return body;
  }
}
