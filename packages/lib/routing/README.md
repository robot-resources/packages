# lib/routing

JS port of the Python routing modules in `router/src/robot_resources/routing/`.

`models_db.json` here is a **verbatim copy** of `router/src/robot_resources/routing/models_db.json`. Until PR 3 of the in-process refactor lands, the Python copy is the source of truth — re-copy this file whenever the Python copy changes (the Python `pricing_updater.py` cron updates that file). PR 3 will either delete the Python copy or relocate the updater to write directly here.

The rest of the modules (`task_detection.js`, `selector.js`, `router.js`, etc.) are added in PR 1 of the in-process refactor and are **not yet wired up** — the plugin still calls the Python daemon over HTTP via `plugin-core.js:askRouter()`. PR 2 flips the call site.
