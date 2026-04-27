# lib/routing

In-process routing logic. Live source of truth — there is no longer a Python daemon to mirror.

`models_db.json` is the model catalog (id, provider, cost, context window, capabilities). Updated by the cron in `.github/workflows/update-pricing.yml` which runs `scripts/update-pricing.mjs` against the litellm public pricing JSON.

Wired into `lib/local-server.js` (the in-process HTTP server registered by the plugin) via `router.js`'s `asyncRoutePrompt`. See `../local-server.js` for the request flow.
