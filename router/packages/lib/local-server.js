/**
 * In-process Anthropic-compatible HTTP server.
 *
 * OC's agent runtime dispatches via standard provider catalog (baseUrl + api).
 * Our plugin's catalog publishes baseUrl=http://127.0.0.1:<port> for the
 * 'robot-resources' provider, so OC POSTs LLM calls to this server.
 *
 * Per request:
 *   1. Parse the Anthropic-shaped body OC sends.
 *   2. Extract the latest user-message text → run PR 1's classifier on it
 *      → pick a real Anthropic model (claude-haiku/sonnet/opus...).
 *   3. Substitute body.model with the chosen model.
 *   4. Resolve the user's real Anthropic key from OC's auth-profile store.
 *   5. Forward to api.anthropic.com/v1/messages and pipe the SSE stream
 *      straight back unchanged. OC parses native Anthropic SSE — zero
 *      re-shaping on our end.
 *
 * Failure modes (per Manuel 2026-04-26):
 *   - empty/non-text user message OR classifier throws → leave body.model
 *     unchanged, forward as-is. (anthropic.com will reject 'robot-resources/
 *     auto'; that's acceptable visible failure for now, telemetry captures
 *     the rate, smarter fallback later if data shows it matters.)
 *   - no anthropic key found → 500 to OC with explanatory body.
 *   - upstream fetch error → 502 to OC.
 *
 * The server lives and dies with the OC gateway process. No cleanup needed
 * across restarts.
 */

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { asyncRoutePrompt } from './routing/router.js';
import { MODELS_DB } from './routing/selector.js';
import { classifyWithLlmDetailed } from './routing/classify.js';
import { resolveAnthropicKey } from './anthropic-key.js';

export async function startLocalServer({ api, telemetry, providers, detectedProviders }) {
  const server = createServer((req, res) => {
    handleRequest(req, res, { api, telemetry, providers, detectedProviders }).catch((err) => {
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
  // OC validates models.providers.<id>.baseUrl strictly — a dynamic OS-chosen
  // port would force a placeholder in openclaw.json that catalog.run would
  // need to override at request time. Static port = simpler config + matches
  // every other OC bundled provider's pattern. If 18790 is in use (rare on
  // user machines), fall back to OS-chosen and accept that catalog.run is
  // load-bearing for that install.
  const PRIMARY_PORT = 18790;
  return new Promise((resolve) => {
    const tryBind = (port, isFallback) => new Promise((res, rej) => {
      const onError = (err) => { server.off('listening', onListen); rej(err); };
      const onListen = () => {
        server.off('error', onError);
        const { port: bound } = server.address();
        api?.logger?.info?.(
          `[robot-resources] Local Anthropic-messages server bound on 127.0.0.1:${bound}` +
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

async function handleRequest(req, res, { api, telemetry, providers, detectedProviders }) {
  const startedAt = Date.now();

  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  // Accept both /v1/messages and /messages — OC's resolveAnthropicMessagesUrl
  // appends /v1 if our baseUrl doesn't already end in it.
  if (!req.url || !req.url.endsWith('/messages')) { res.writeHead(404).end(); return; }

  let body;
  try {
    body = JSON.parse(await readAll(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'bad JSON body' } }));
    return;
  }

  const prompt = extractLatestUserText(body) || '';
  let chosenModel = body.model;
  let routingResult = null;

  api?.logger?.info?.(
    `[robot-resources] handler hit — model=${body.model} promptLen=${prompt.length} msgCount=${body?.messages?.length || 0}`,
  );

  if (prompt) {
    try {
      // detectedProviders is the snapshot taken at register time — OC's
      // api.config goes empty after register so we can't re-detect here.
      const detected = detectedProviders instanceof Set ? detectedProviders : new Set();
      const effective = providers && providers.length
        ? new Set([...detected].filter((p) => providers.includes(p)))
        : detected;
      const filteredDb = MODELS_DB.filter((m) => effective.has(m.provider));

      api?.logger?.info?.(
        `[robot-resources] detection: detected=[${[...detected].join(',')}] effective=[${[...effective].join(',')}] filteredDbSize=${filteredDb.length}`,
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
        api?.logger?.warn?.('[robot-resources] no providers detected at request time — forwarding with original model');
        telemetry?.emit?.('no_providers_detected', {
          has_oc_config: !!api?.config?.models?.providers,
        });
      }
    } catch (err) {
      api?.logger?.warn?.(`[robot-resources] router threw: ${err?.message}`);
      telemetry?.emit?.('route_failed', {
        mode: 'in-process',
        error_type: err?.constructor?.name ?? 'Error',
        error_message: String(err?.message ?? err).slice(0, 200),
        latency_ms: Date.now() - startedAt,
      });
      // fall through with original body.model — visible failure upstream
    }
  } else {
    api?.logger?.warn?.('[robot-resources] no user-text in body.messages — forwarding with original model');
  }

  body.model = chosenModel;

  const realKey = resolveAnthropicKey({ api });
  if (!realKey) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'auth',
        message: 'Robot Resources router: no Anthropic API key found in OC auth profiles or ANTHROPIC_API_KEY env',
      },
    }));
    telemetry?.emit?.('local_server_no_key', {});
    return;
  }

  const upstreamHeaders = {
    'content-type': 'application/json',
    'x-api-key': realKey,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  const beta = req.headers['anthropic-beta'];
  if (beta) upstreamHeaders['anthropic-beta'] = Array.isArray(beta) ? beta.join(',') : beta;

  api?.logger?.info?.(`[robot-resources] forwarding to api.anthropic.com — model=${body.model}`);
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
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
  for (const h of ['content-type', 'cache-control', 'anthropic-request-id']) {
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

function extractLatestUserText(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const textBlock = m.content.find((b) => b?.type === 'text' && typeof b.text === 'string');
      if (textBlock) return textBlock.text;
    }
  }
  return null;
}
