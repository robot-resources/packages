# Robot Resources

> Tools for AI agents. Humans have HR. Agents have RR.

Two products for any software that makes LLM API calls — chatbots, RAG pipelines, AI-powered apps, agent runtimes. Both run locally, both free.

**Router** — Intelligent LLM routing proxy. Classifies each prompt by task type, routes to the cheapest model that qualifies. 60-90% cost savings with zero quality loss.

**Scraper** — Token compression for web content. Fetches any URL, strips noise, returns clean markdown. Median 91% token reduction.

## Install

```bash
npx robot-resources
```

One command: installs Router as an always-on system service, registers Scraper as an MCP tool, configures your agent automatically.

## What It Does

1. **Installs Router** — Python venv + system service on localhost:3838
2. **Registers Scraper** — MCP tool `scraper_compress_url(url)` in your agent
3. **Configures OpenClaw** — Plugin auto-installed if OpenClaw is detected
4. **Provisions API key** — For telemetry and dashboard access
5. **Health check** — Verifies everything is running after install

## Router

Transparent proxy on localhost:3838. Your LLM calls pass through, Router selects the cheapest capable model:

- Hybrid classification: keyword detection (~5ms) + LLM fallback (~200ms)
- Dynamic thresholds: simple tasks → cheap models, complex tasks → top models
- Models across OpenAI, Anthropic, Google — routes within your available providers
- Your API keys pass through via headers — never stored by Router
- OpenAI-compatible API — change `base_url` to `http://localhost:3838`

## Scraper

Available as MCP tool after install:

- Mozilla Readability extraction (0.97 F1 accuracy)
- Content-aware token estimation
- 3-tier fetch: fast, stealth (TLS fingerprint), render (headless browser)
- Multi-page BFS crawl with robots.txt compliance
- Median 91% token reduction per page

## Agent Compatibility

| Agent | Integration | Status |
|-------|-------------|--------|
| **OpenClaw** | Plugin (auto-install) | Verified |
| **Claude Code** | MCP server | Verified |
| **Any OpenAI client** | HTTP proxy (localhost:3838) | Compatible |
| **Cursor** | MCP server | Compatible |
| **Windsurf** | MCP server | Compatible |

## MCP Servers

```bash
npx -y @robot-resources/router-mcp    # Router stats + config
npx -y @robot-resources/scraper-mcp   # Scraper compression
```

## Dashboard

Usage dashboard at https://robotresources.ai/dashboard — real-time telemetry, cost savings, routing stats. Auth via GitHub OAuth.

## Pricing

Free. Unlimited. No tiers. Your API keys never leave your machine.

## Telemetry

Anonymous usage telemetry (model selection, cost savings) to improve the product. No personal data, no request content, no API keys.

Opt out: `export RR_TELEMETRY=off`

## Links

- Website: https://robotresources.ai
- Dashboard: https://robotresources.ai/dashboard
- Agent docs: https://robotresources.ai/llms.txt
- npm: https://www.npmjs.com/package/robot-resources
- GitHub: https://github.com/robot-resources/packages
- Discord: https://robotresources.ai/discord
- Contact: agent@robotresources.ai

## License

MIT
