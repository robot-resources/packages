# @robot-resources/router-mcp

> MCP server for managing Robot Resources Router — stats, config, and model comparison.

## What is Robot Resources?

**Human Resources, but for your AI agents.**

Robot Resources cuts your LLM API costs by 60-90%. It runs a local proxy that classifies each prompt by task type (coding, reasoning, analysis, simple Q&A, creative, general) and routes it to the cheapest model that can handle it — across 11 models from OpenAI, Anthropic, and Google.

Your API keys never leave your machine. Free, unlimited, no tiers.

### Install the full suite

```bash
npx robot-resources
```

One command sets up the Router proxy, configures your agents, and gets you saving immediately.

Learn more at [robotresources.ai](https://robotresources.ai)

---

## About this MCP server

This package gives AI agents management tools for the Router proxy via the [Model Context Protocol](https://modelcontextprotocol.io). Use it to check cost savings, compare models, and adjust routing config — all from within Claude Desktop, Claude Code, or any MCP-compatible agent.

## Quick Start

```bash
npx @robot-resources/router-mcp
```

Requires the Router proxy running at `localhost:3838` (default). Override with `ROUTER_URL` env var.

## Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["-y", "@robot-resources/router-mcp"]
    }
  }
}
```

### Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["-y", "@robot-resources/router-mcp"]
    }
  }
}
```

### Custom Router URL

If the proxy runs on a non-default port:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["-y", "@robot-resources/router-mcp"],
      "env": {
        "ROUTER_URL": "http://localhost:4000"
      }
    }
  }
}
```

## Tools

### `router_get_stats`

Cost savings statistics for the Router proxy.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | `"daily" \| "weekly" \| "monthly"` | `"weekly"` | Time period |
| `task_type` | `string` | — | Filter by task type |
| `provider` | `string` | — | Filter by provider |

### `router_compare_models`

Compare models by capability and cost for a given task type.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_type` | `string` | **required** | Task type to compare |
| `threshold` | `number` | `0.7` | Minimum capability score |
| `provider` | `string` | — | Filter by provider |

### `router_get_config`

Read current routing configuration (provider scope, thresholds, overrides).

No parameters required.

### `router_set_config`

Update routing configuration at runtime. Changes are in-memory only (reset on restart).

| Parameter | Type | Description |
|-----------|------|-------------|
| `provider_scope` | `string` | Limit to specific provider(s) |
| `capability_threshold` | `number` | Minimum capability score |
| `baseline_model` | `string` | Model for cost comparisons |
| `log_level` | `string` | Logging level |

Pass `null` for any field to reset it to the env-var default.

## Requirements

- **Node.js** >= 18.0.0
- **Router proxy** running (see [@robot-resources/router](https://www.npmjs.com/package/@robot-resources/router))

## License

MIT
