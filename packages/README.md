# @robot-resources/openclaw-plugin

Cost-optimized model routing and token-compressed web fetching for OpenClaw.

Routes LLM calls through the [Robot Resources Router](https://github.com/robot-resources/packages) to select the cheapest capable model for each prompt, and redirects `web_fetch` calls through a scraper MCP for compressed output.

## Installation

```bash
openclaw plugins install @robot-resources/openclaw-plugin
```

Or via the unified installer (recommended):

```bash
npx robot-resources
```

The unified installer handles Router setup, service registration, plugin installation, and scraper MCP configuration.

## Requirements

- [OpenClaw](https://openclaw.com) gateway
- Robot Resources Router running locally (default: `http://localhost:3838`)

## Configuration

The plugin reads its configuration from `openclaw.plugin.json`:

```json
{
  "routerUrl": "http://localhost:3838"
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `routerUrl` | `string` | `http://localhost:3838` | URL of the Robot Resources Router proxy |

## How It Works

### Model Routing (`before_model_resolve`)

Before each model selection, the plugin queries the Router at `/v1/route` with the current prompt. The Router evaluates prompt complexity and returns the cheapest model that can handle it.

```
User prompt → Plugin → Router /v1/route → { model, provider, savings }
                                         ↓
                              modelOverride applied
```

The routing decision is appended to outgoing messages showing the selected model and savings percentage.

### Web Fetch Override (`before_tool_call`)

When the agent calls `web_fetch`, the plugin redirects it to `scraper_compress_url` via the scraper MCP. This returns token-compressed output, reducing context window usage.

Falls through silently if the scraper MCP is not registered.

### Provider Registration

In API-key mode, the plugin registers a `robot-resources` provider with OpenClaw. This enables routing through the local proxy with these models:

- `claude-sonnet-4-20250514`
- `claude-haiku-4-5-20251001`
- `claude-opus-4-20250514`

## Auth Modes

### API-key Mode (default)

Full routing to any provider. The Router proxies requests through the local gateway.

### Subscription Mode

Detected when OpenClaw is configured with OAuth/subscription authentication. Routing is restricted to Anthropic-only models (OAuth tokens are rejected by other providers when proxied).

Detection checks:
- `auth.profiles[*].mode === 'token'`
- `gateway.auth.mode === 'token'`

## Hooks

| Hook | Priority | Description |
|------|----------|-------------|
| `before_model_resolve` | 10 | Routes to cheapest capable model via Router |
| `before_tool_call` | 10 | Redirects `web_fetch` to scraper MCP |
| `message_sending` | -10 | Appends routing decision tag to messages |

## Exported API

```javascript
import plugin from '@robot-resources/openclaw-plugin';
import { DEFAULT_ROUTER_URL, ROUTER_MODELS, askRouter, detectSubscriptionMode } from '@robot-resources/openclaw-plugin';
```

| Export | Type | Description |
|--------|------|-------------|
| `default` | `object` | Plugin object `{ id, name, register }` |
| `DEFAULT_ROUTER_URL` | `string` | `http://localhost:3838` |
| `ROUTER_MODELS` | `string[]` | Supported router model IDs |
| `askRouter(url, prompt, providers?)` | `async function` | Query the Router directly |
| `detectSubscriptionMode(config)` | `function` | Check if OpenClaw uses subscription auth |

## Testing

```bash
npm test         # watch mode
npm run test:run # single run
```

44 tests across 2 suites: plugin contract tests and OpenClaw harness simulation.

## License

[MIT](LICENSE)
