# robot-resources

> One command to install Robot Resources tools for any agent stack.

```bash
npx robot-resources
```

The wizard detects what you're building and walks you through the right setup — OpenClaw plugin install, JS library path, Python SDK path, MCP config for Cursor / Claude Code, or just the docs URL.

## What the wizard does

1. **Provisions an anonymous API key** via `POST /v1/auth/signup` (saved to `~/.robot-resources/config.json`). Optional — routing works without it; the key just lights up the dashboard at robotresources.ai/dashboard.
2. **Detects your stack**:
   - OpenClaw installed (`~/.openclaw/`) → installs the router plugin (in-process HTTP server) + scraper OC plugin, patches `openclaw.json`, restarts the gateway. **No Python, no daemon, no system service.**
   - Non-OC + cwd has `package.json` with LangChain/LangGraph/Mastra → preselects "JS/TS agent."
   - Non-OC + cwd has `requirements.txt` / `pyproject.toml` → preselects "Python agent."
   - Non-OC + Cursor or Claude Code installed → preselects "MCP tool."
3. **Runs the chosen path**:
   - **JS/TS agent** → prints `npm install @robot-resources/router` + `import { routePrompt }` example
   - **Python agent** → prints `pip install robot-resources` + `from robot_resources.router import route` example, plus an httpx fallback if you'd rather skip the SDK
   - **Cursor / Claude Code** → writes the scraper MCP config into `~/.cursor/mcp.json` / `~/.claude/settings.json`
   - **Docs** → prints the URL + exits
   - **Install OpenClaw first** → redirect message + exits

## Flags

```
--for=<target>      langchain | python | cursor | claude-code | docs
                    Skip the prompt and run that path directly.
                    Required for non-TTY contexts (CI, piped, etc.)
--non-interactive   Treat as CI run regardless of TTY state
--yes / -y          Same as --non-interactive
```

Without flags in a non-TTY context, the wizard prints the `--for=` hint and exits cleanly — never blocks waiting for stdin.

## Pre-set the API key

For fleets or CI:

```bash
export RR_API_KEY=rr_live_...        # skip signup, use this key
npx robot-resources --for=cursor     # or whatever path applies
```

## Five paths, one wizard

| Path | What you get | Where |
|---|---|---|
| OpenClaw plugin | In-process router inside the OC gateway. Auto-routes Anthropic calls to the cheapest capable model. | `~/.openclaw/extensions/robot-resources-router/` |
| JS/TS agent | `@robot-resources/router/routing` — pure ESM, zero deps, offline keyword classifier. | npm |
| Python agent | `robot-resources` (singular) — thin httpx client over `/v1/route`. | PyPI |
| HTTP API | Any language with curl/fetch. Authed by API key. | `POST https://api.robotresources.ai/v1/route` |
| Cursor / Claude Code MCP | Scraper MCP wired into your tool's config (web fetches → 91% smaller markdown). | `~/.cursor/mcp.json` or `~/.claude/settings.json` |

Full integration docs: https://robotresources.ai/docs

## Architecture (post-PR-2.5)

The router used to be a Python daemon on `localhost:3838`. **Not anymore.** It now runs in-process inside whichever surface consumes it:

- **OpenClaw** — the plugin's `register()` starts an HTTP server on `127.0.0.1:18790` inside OC's node process. Lifetime tied to OC. Zero daemon to keep alive.
- **JS agents** — call `routePrompt()` directly. No HTTP at all. Pure function.
- **Python / curl** — call `POST /v1/route` on `api.robotresources.ai`. Server-side classifier on Cloudflare Workers.

User provider keys never leave the user's machine. The platform never receives, stores, or transmits them.

## Telemetry

Anonymous, fire-and-forget, opt-in via the wizard's API-key provisioning. Events: `wizard_started`, `wizard_path_chosen`, `install_complete`, `route_completed`, `route_via_api`, `route_via_lib`. No personal data, no request content, no provider keys.

## Pricing

Free. Unlimited. Your API keys never leave your machine.

## Links

- Website: https://robotresources.ai
- Docs: https://robotresources.ai/docs
- Dashboard: https://robotresources.ai/dashboard
- HTTP API: `POST https://api.robotresources.ai/v1/route`
- npm: https://www.npmjs.com/package/robot-resources
- GitHub: https://github.com/robot-resources/packages
- Discord: https://robotresources.ai/discord
- Contact: agent@robotresources.ai
- Agent docs: https://robotresources.ai/llms.txt

## License

MIT
