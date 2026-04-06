# Robot Resources

> Tools for AI agents. Humans have HR. Agents have RR.

Two products for any software that makes LLM API calls — chatbots, RAG pipelines, AI-powered apps, agent runtimes. Both run locally, both free.

**Router** — Intelligent LLM routing proxy. Classifies each prompt by task type, routes to the cheapest model that qualifies. 60-90% cost savings with zero quality loss.

**Scraper** — Token compression for web content. Fetches any URL, strips noise, returns clean markdown. Median 91% token reduction.

## Install

```bash
npx robot-resources
```

One command: installs Router as an always-on system service, registers Scraper as an MCP tool, configures your agent automatically. Works with OpenClaw, Claude Code, and any OpenAI-compatible client.

## How It Works

### Router (localhost:3838)

Your LLM calls go through a local proxy that selects the cheapest capable model per request:

- Hybrid classification: keyword detection (~5ms) + LLM fallback for ambiguous prompts (~200ms)
- Dynamic thresholds: simple tasks open cheap models (0.60), complex tasks require top models (0.85)
- Models across OpenAI, Anthropic, and Google — routes within your available providers
- Transparent proxy: your API keys pass through via headers, never stored
- OpenAI-compatible API — change your `base_url` to `http://localhost:3838`

### Scraper (MCP tool)

Available as `scraper_compress_url(url)` in your agent after install:

- Mozilla Readability extraction (0.97 F1 accuracy)
- Content-aware token estimation
- 3-tier fetch: fast, stealth (TLS fingerprint), render (headless browser)
- Multi-page BFS crawl with robots.txt compliance

### Dashboard

Usage dashboard at https://robotresources.ai/dashboard — real-time telemetry, cost savings tracking, routing stats. Auth via GitHub OAuth.

## Agent Compatibility

| Agent | Integration | Status | Setup |
|-------|-------------|--------|-------|
| **OpenClaw** | Plugin (auto-install) | Verified | `npx robot-resources` |
| **Claude Code** | MCP server | Verified | `npx robot-resources` |
| **Any OpenAI client** | HTTP proxy | Compatible | Set `base_url` to `http://localhost:3838` |
| **Cursor** | MCP server | Compatible | Add scraper-mcp to MCP settings |
| **Windsurf** | MCP server | Compatible | Add scraper-mcp to MCP settings |

**Verified** = tested end-to-end by the team. **Compatible** = standard protocol, should work.

## MCP Servers

Both products include MCP servers for AI agent integration:

```bash
npx -y @robot-resources/router-mcp    # Router stats + config
npx -y @robot-resources/scraper-mcp   # Scraper compression
```

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| `robot-resources` | Unified installer (this package) | https://www.npmjs.com/package/robot-resources |
| `@robot-resources/router` | Router npm wrapper | https://www.npmjs.com/package/@robot-resources/router |
| `@robot-resources/router-mcp` | Router MCP server | https://www.npmjs.com/package/@robot-resources/router-mcp |
| `@robot-resources/scraper` | Scraper core | https://www.npmjs.com/package/@robot-resources/scraper |
| `@robot-resources/scraper-mcp` | Scraper MCP server | https://www.npmjs.com/package/@robot-resources/scraper-mcp |
| `@robot-resources/openclaw-plugin` | OpenClaw integration | https://www.npmjs.com/package/@robot-resources/openclaw-plugin |
| `@robot-resources/cli-core` | Shared auth/config | https://www.npmjs.com/package/@robot-resources/cli-core |

## Pricing

Free. Unlimited. No tiers. Both tools run locally — you pay your AI providers directly. No markup, no rate limits, no quotas. Your API keys never leave your machine.

## Telemetry

Robot Resources collects anonymous usage telemetry (model selection, cost savings, error rates) to improve the product. No personal data, no request/response content, no API keys.

Opt out: `export RR_TELEMETRY=off` or set `"telemetry": false` in `~/.robot-resources/config.json`.

## Links

- **Website**: https://robotresources.ai
- **Dashboard**: https://robotresources.ai/dashboard
- **Agent docs**: https://robotresources.ai/llms.txt
- **npm**: https://www.npmjs.com/package/robot-resources
- **GitHub**: https://github.com/robot-resources
- **Discord**: https://robotresources.ai/discord
- **Contact**: agent@robotresources.ai

## Contributing

This repository is auto-synced from our development monorepo. To report issues or contribute:

- Open an issue on this repo
- Email agent@robotresources.ai

## License

MIT
