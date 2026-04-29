/**
 * In-process multi-shape HTTP server for the Robot Resources router plugin.
 *
 * OC's agent runtime dispatches via standard provider catalog (per-model
 * baseUrl + api). The plugin registers three virtual models — one per lab
 * shape — each with a path-prefixed loopback baseUrl:
 *
 *   /anthropic   → api: 'anthropic-messages'    → upstream api.anthropic.com
 *   /openai/v1   → api: 'openai-responses'      → upstream api.openai.com
 *   /google/v1beta → api: 'google-generative-ai' → upstream generativelanguage.googleapis.com
 *
 * Per request:
 *   1. Detect the lab shape from the URL prefix.
 *   2. Parse the native-shape body OC sends.
 *   3. Extract the latest user text from the shape (anthropic body.messages,
 *      openai body.input, google body.contents).
 *   4. Run the classifier with MODELS_DB filtered to that shape's provider
 *      → pick a real model belonging to the same lab.
 *   5. Apply the chosen model — body.model swap for anthropic+openai;
 *      URL path rewrite for google (its model lives in `models/{id}:method`).
 *   6. Resolve the user's lab key via provider-keys.js.
 *   7. Forward native-shape upstream and pipe the SSE stream straight back
 *      unchanged. OC parses each lab's native SSE — zero re-shaping on our
 *      end.
 *
 * No cross-shape body translation. The plugin only routes within whichever
 * lab shape OC dispatches with.
 *
 * Failure modes:
 *   - unknown URL prefix → 404
 *   - empty/non-text user message OR classifier throws → leave model
 *     unchanged, forward as-is. (Upstream will reject the placeholder
 *     model id; that's acceptable visible failure for now, telemetry
 *     captures the rate.)
 *   - no key for the inbound shape → 500 with explanatory body
 *   - upstream fetch error → 502
 *
 * The server lives and dies with the OC gateway process. No cleanup needed
 * across restarts.
 */

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { asyncRoutePrompt } from './routing/router.js';
import { MODELS_DB } from './routing/selector.js';
import { classifyWithLlmDetailed } from './routing/classify.js';
import { resolveProviderKey } from './provider-keys.js';
import {
  detectProviderFromUrl,
  buildUpstreamUrl,
  buildUpstreamHeaders,
  extractUserText,
  applyChosenModelToBody,
} from './upstream.js';

export async function startLocalServer({ api, telemetry, detectedProviders }) {
  const server = createServer((req, res) => {
    handleRequest(req, res, { api, telemetry, detectedProviders }).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { type: 'internal', message: String(err?.message || err).slice(0, 200) } }));
      } catch { /* socket dead, give up */ }
    });
  });

  server.on('clientError', (_err, sock) => {
    try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* */ }
  });

  // Fixed loopback port so OC's static config can carry a stable baseUrl.
  // Dynamic OS-chosen port would force a placeholder in openclaw.json that
  // catalog.run would need to override at request time. Static port =
  // simpler config + matches every other OC bundled provider's pattern.
  // If 18790 is in use, fall back to OS-chosen and accept that catalog.run
  // is load-bearing for that install.
  const PRIMARY_PORT = 18790;
  return new Promise((resolve) => {
    const tryBind = (port, isFallback) => new Promise((res, rej) => {
      const onError = (err) => { server.off('listening', onListen); rej(err); };
      const onListen = () => {
        server.off('error', onError);
        const { port: bound } = server.address();
        api?.logger?.info?.(
          `[robot-resources] Local multi-shape server bound on 127.0.0.1:${bound}` +
          (isFallback ? ' (fallback — primary port in use)' : ''),
        );
        telemetry?.emit?.('local_server_started', { port: bound, fallback: !!isFallback });
        res({ port: bound, server });
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, '127.0.0.1');
    });

    tryBind(PRIMARY_PORT, false)
      .then(resolve)
      .catch(() => tryBind(0, true).then(resolve).catch((err) => {
        api?.logger?.warn?.(`[robot-resources] local server bind failed: ${err?.message}`);
        telemetry?.emit?.('local_server_bind_failed', { error: String(err?.message || err).slice(0, 200) });
        resolve({ port: null, server: null });
      }));
  });
}

async function handleRequest(req, res, { api, telemetry, detectedProviders }) {
  const startedAt = Date.now();

  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  const provider = detectProviderFromUrl(req.url);
  if (!provider) { res.writeHead(404).end(); return; }

  let body;
  try {
    body = JSON.parse(await readAll(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'bad JSON body' } }));
    return;
  }

  const inboundModel = body.model || extractGoogleInboundModel(req.url, provider);
  const prompt = extractUserText(provider, body) || '';
  let chosenModel = inboundModel;
  let routingResult = null;

  api?.logger?.info?.(
    `[robot-resources] handler hit — shape=${provider} model=${inboundModel} promptLen=${prompt.length}`,
  );

  if (prompt) {
    try {
      const detected = detectedProviders instanceof Set ? detectedProviders : new Set();
      // Within-shape routing: classifier only chooses among the inbound
      // shape's provider. Cross-shape requires body translation, which is
      // explicitly out of scope.
      const filteredDb = detected.has(provider)
        ? MODELS_DB.filter((m) => m.provider === provider)
        : [];

      api?.logger?.info?.(
        `[robot-resources] detection: shape=${provider} detected=[${[...detected].join(',')}] filteredDbSize=${filteredDb.length}`,
      );

      if (filteredDb.length > 0) {
        api?.logger?.info?.('[robot-resources] starting asyncRoutePrompt...');
        routingResult = await asyncRoutePrompt(prompt, {
          modelsDb: filteredDb,
          classifierImpl: async (p) => (await classifyWithLlmDetailed(p, { telemetry })).result,
        });
        chosenModel = routingResult.selected_model;
        api?.logger?.info?.(
          `[robot-resources] router picked: ${chosenModel} (${routingResult.savings_percent}% savings, source=${routingResult.classification_source})`,
        );
      } else {
        api?.logger?.warn?.(`[robot-resources] no ${provider} key detected at request time — forwarding with original model`);
        telemetry?.emit?.('no_providers_detected', {
          shape: provider,
          has_oc_config: !!api?.config?.models?.providers,
        });
      }
    } catch (err) {
      api?.logger?.warn?.(`[robot-resources] router threw: ${err?.message}`);
      telemetry?.emit?.('route_failed', {
        mode: 'in-process',
        shape: provider,
        error_type: err?.constructor?.name ?? 'Error',
        error_message: String(err?.message ?? err).slice(0, 200),
        latency_ms: Date.now() - startedAt,
      });
      // fall through with original model — visible failure upstream
    }
  } else {
    api?.logger?.warn?.(`[robot-resources] no user text in ${provider} body — forwarding with original model`);
  }

  applyChosenModelToBody(provider, body, chosenModel);

  const realKey = resolveProviderKey({ api, provider });
  if (!realKey) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'auth',
        message: `Robot Resources router: no ${provider} API key found in OC auth profiles or env`,
      },
    }));
    telemetry?.emit?.('local_server_no_key', { shape: provider });
    return;
  }

  const upstreamUrl = buildUpstreamUrl({ provider, inboundUrl: req.url, chosenModel });
  const upstreamHeaders = buildUpstreamHeaders({
    provider,
    apiKey: realKey,
    inboundHeaders: req.headers,
  });

  api?.logger?.info?.(`[robot-resources] forwarding to ${upstreamUrl} — model=${chosenModel}`);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
    api?.logger?.info?.(`[robot-resources] upstream responded HTTP ${upstream.status}`);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'upstream', message: String(err?.message || err).slice(0, 200) },
    }));
    telemetry?.emit?.('local_server_upstream_failed', {
      shape: provider,
      error: String(err?.message || err).slice(0, 200),
      latency_ms: Date.now() - startedAt,
    });
    return;
  }

  if (routingResult && upstream.ok) {
    api?.logger?.info?.(
      `[robot-resources] Routed → ${routingResult.selected_model} (${routingResult.savings_percent}% savings)`,
    );
    telemetry?.emit?.('route_completed', {
      mode: 'in-process',
      task_type: routingResult.task_type,
      provider: routingResult.provider,
      selected_model: routingResult.selected_model,
      savings_percent: routingResult.savings_percent,
      latency_ms: Date.now() - startedAt,
    });
  }

  const passHeaders = {};
  for (const h of ['content-type', 'cache-control', 'anthropic-request-id', 'openai-organization', 'x-request-id']) {
    const v = upstream.headers.get(h);
    if (v) passHeaders[h] = v;
  }
  res.writeHead(upstream.status, passHeaders);

  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).pipe(res);
}

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Google's generateContent puts the model in the URL path, not the body.
// Pull it out of `/google/.../models/<id>:method` so logs and telemetry
// have the inbound model name even before the classifier picks one.
function extractGoogleInboundModel(url, provider) {
  if (provider !== 'google' || !url) return undefined;
  const m = url.match(/\/models\/([^:?]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}
