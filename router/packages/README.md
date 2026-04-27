# @robot-resources/router

> Smart model selection for AI agents — pick the cheapest LLM that can handle each prompt.

The router classifies a prompt by task type (coding / reasoning / analysis / simple_qa / creative / general), filters the model catalog by capability, and returns the cheapest qualifying model. Typically saves 60–90% on coding/QA mixes vs always picking the top model.

## Two ways to use it

### As an OpenClaw plugin (default `npx robot-resources` install)

The router IS the OC plugin. It registers an in-process HTTP server on `127.0.0.1:18790` inside OC's gateway process, dispatches LLM calls there, runs the keyword classifier, picks a model, and forwards the request to the user's configured provider (currently Anthropic) using the user's existing API key. **No daemon, no Python, no system service.** Lifetime is tied to the OC gateway — the server starts when OC loads the plugin and dies when OC exits.

```bash
npx robot-resources                # installs the plugin into ~/.openclaw/extensions/robot-resources-router/
```

The unified wizard handles plugin install, scraper MCP registration, and config patching. See [`robot-resources` on npm](https://www.npmjs.com/package/robot-resources) for the wizard.

### As a public JS library (any agent framework)

For agents that don't run inside OpenClaw — LangChain, LangGraph.js, Mastra, etc. — import the routing decision directly:

```bash
npm install @robot-resources/router
```

```js
import { routePrompt } from '@robot-resources/router/routing';

const decision = routePrompt('write a python function that reverses a string');
// {
//   selected_model: 'claude-haiku-4-5',
//   provider: 'anthropic',
//   savings_percent: 68.0,
//   task_type: 'coding',
//   capability_score: 0.86,
//   reasoning: '...',
// }
```

Pure ESM, zero dependencies. The classifier runs offline on the keyword fast-path (~5ms, covers ~70% of prompts); slow-path classifier needs a network call to Gemini (configurable via `asyncRoutePrompt`).

```js
import { asyncRoutePrompt } from '@robot-resources/router/routing';

// Async path — same shape, may call Gemini for ambiguous prompts.
const decision = await asyncRoutePrompt(prompt);
```

The routing module never reads user provider keys — `modelsDb` and `availableProviders` are caller parameters. Safe to use in non-OC contexts.

## Other consumption paths

| Path | Where | When |
|---|---|---|
| **HTTP API** | `POST https://api.robotresources.ai/v1/route` | Any language with `curl` / `fetch`. Authed by API key, 100 req/min per key. See [docs](https://robotresources.ai/docs/http-api). |
| **Python SDK** | `pip install robot-resources` → `from robot_resources.router import route` | Python agents (LangChain, LlamaIndex, CrewAI, etc.). Thin httpx client over `/v1/route`. |
| **OC plugin** | `npx robot-resources` | OpenClaw users — the in-process integration described above. |

## What it ships

- `index.js` — OC plugin entry (sync register shim)
- `lib/local-server.js` — in-process HTTP server (Anthropic-messages compatible)
- `lib/routing/` — classifier + selector + models catalog (importable as `@robot-resources/router/routing`)
- `lib/telemetry.js` — opt-in telemetry helper (importable as `@robot-resources/router/telemetry`)
- `lib/self-update.js` — daily npm version poll + atomic swap

## Public exports

```js
// from package.json `exports`
import x from '@robot-resources/router';            // OC plugin shim (default)
import x from '@robot-resources/router/routing';    // routing API (routePrompt, asyncRoutePrompt, MODELS_DB)
import x from '@robot-resources/router/telemetry';  // createTelemetry factory
```

## Provider support

Today: Anthropic (in-process server forwards to `api.anthropic.com`). The classifier catalog includes OpenAI + Google + Anthropic models, so the JS library can return decisions for any provider — but the in-process server's request forwarding is single-lab. Multi-lab dispatch is a future expansion that lands in a follow-up.

## Configuration (OC plugin path)

The plugin reads the user's Anthropic key from `~/.openclaw/agents/<id>/agent/auth-profiles.json` (the OC native auth store). The user never enters a key into Robot Resources directly. We never see, store, or transmit user provider keys.

`~/.robot-resources/config.json` stores the anonymous Robot Resources `api_key` used for telemetry — provisioned at install via `POST /v1/auth/signup`. Optional. Routing works without it.

## Telemetry

Fire-and-forget, opt-in. Events emitted from the in-process server: `local_server_started`, `route_completed`, `route_failed`, `local_server_no_key`, `local_server_upstream_failed`. Events from the JS library (when `telemetry` is wired by the consumer): `route_via_lib`. Disable: don't supply an `apiKey`.

## License

MIT
