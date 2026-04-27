# @robot-resources/router

> Intelligent LLM cost optimization via local proxy.

Automatically route each LLM request to the cheapest model that can handle it. **60-90% cost savings** with no quality loss.

## Quick Start

```bash
# Run directly (no install needed) — runs the setup wizard on first invocation
npx @robot-resources/router

# Or install globally
npm install -g @robot-resources/router
rr-router
```

On first run, the wizard:

1. Installs the Python router engine (venv + pip) in `~/.robot-resources/.venv/`
2. Registers the router as a background service (launchd on macOS, systemd on Linux)
3. Auto-configures detected AI tools (Claude Code, Cursor) as MCP clients
4. If no tools are detected, prints copy-pasteable SDK `base_url` instructions

After that, calls like `rr-router start`, `rr-router status`, or `rr-router report` skip the wizard. Use `--setup` to re-run it.

## Requirements

- **Node.js** >= 18.0.0
- **Python** >= 3.10 (auto-detected; used for the routing engine)

## Enterprise / Docker

Inside Docker, the wizard skips service registration and prints three ways to run the router: Dockerfile `CMD`, Compose sidecar, or background process. Set `RR_API_KEY` in advance to bypass the auto-signup step entirely.

## Enterprise setup (admin-provisioned keys)

For fleets where an admin distributes API keys to many agents, pre-set `RR_API_KEY` and the wizard skips signup:

```bash
# Admin: create N keys in the dashboard via POST /v1/keys, then on each agent:
RR_API_KEY=rr_live_... npx @robot-resources/router
```

This bypasses the per-IP signup rate limit and avoids one claim URL per agent. All telemetry lands under the admin's account.

## Pointing your SDK at the Router

Two SDKs are supported via the `base_url` override. Note the difference:

```bash
# OpenAI SDK / compatible clients — include /v1
export OPENAI_BASE_URL=http://localhost:3838/v1
#   OpenAI(base_url="http://localhost:3838/v1")

# Anthropic SDK — NO /v1 (the SDK appends /v1/messages itself)
export ANTHROPIC_BASE_URL=http://localhost:3838
#   Anthropic(base_url="http://localhost:3838")
```

For Gemini, route through the OpenAI-compatible client with a Gemini model name:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3838/v1", api_key="not-needed")
client.chat.completions.create(model="gemini-2.5-flash", ...)
```

The router has no native Google `v1beta` endpoint — `GOOGLE_API_BASE` is not a real env var.

## How It Works

```
Your Agent (Claude Code, Cursor, etc.)
    |
    | POST /v1/chat/completions  (OpenAI-compatible)
    | model: "auto"
    v
┌─────────────────────────────┐
│  Robot Resources Router     │
│  localhost:3838              │
│                             │
│  1. Detect task type        │
│  2. Find cheapest model     │
│  3. Forward to provider     │
│  4. Track cost savings      │
└─────────────────────────────┘
    |
    v
  Anthropic / OpenAI / Google
```

Each message is classified (coding, reasoning, simple_qa, etc.) and routed to the cheapest model with sufficient capability for that task.

## Example Savings

```
Turn 1: "hello"                    → gemini-2.0-flash-lite        $0.0000
Turn 2: "what's 2+2?"              → gemini-2.0-flash-lite        $0.0000
Turn 3: "refactor this React code" → gpt-4o-mini                  $0.0002
Turn 4: "thanks, looks good"       → gemini-2.0-flash-lite        $0.0000
─────────────────────────────────────────────────────────────────────────
Total with RR:       $0.0002
Without RR (gpt-4o): $0.0075
Savings:             97%
```

## Configuration

Set provider API keys as environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="..."
```

## CLI Commands

```bash
rr-router start              # Start proxy on localhost:3838
rr-router start --port 4000  # Custom port
rr-router status             # Show status
rr-router report weekly      # Cost savings report (7 days)
rr-router report monthly     # Cost savings report (30 days)
```

## Agent Integration

Point any OpenAI-compatible agent to the proxy:

```json
{
  "baseUrl": "http://localhost:3838",
  "model": "auto"
}
```

The proxy handles routing transparently. Your agent doesn't need to know about model selection.

## License

MIT
