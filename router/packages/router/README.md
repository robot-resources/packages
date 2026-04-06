# @robot-resources/router

> Intelligent LLM cost optimization via local proxy.

Automatically route each LLM request to the cheapest model that can handle it. **60-90% cost savings** with no quality loss.

## Quick Start

```bash
# Run directly (no install needed)
npx @robot-resources/router start

# Or install globally
npm install -g @robot-resources/router
rr-router start
```

Set your API keys and point your agent to `http://localhost:3838` with `model: "auto"`.

## Requirements

- **Node.js** >= 18.0.0
- **Python** >= 3.10 (auto-detected; used for the routing engine)

On first run, the package automatically creates an isolated Python environment in `~/.robot-resources/.venv/` and installs the Router engine. Subsequent runs start instantly.

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
