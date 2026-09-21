# gqsa Site — new workspace

> The site is for the pen name **gqsa** (always lowercase). Read `progress.md` for the full context.

**Start here: read `progress.md` first.** It contains the full business context (why we're
building this), the decisions already made, the game plan with statuses, and the handoff
protocol. You do not need anyone to re-explain the background — it's all there.

- `skill-site-creation.md` — the step-by-step recipe this workspace builds from.
- `next_steps.txt` — the original learning-path + roadmap the plan in `progress.md` is derived from.
- `server.js` + `paypal-config.js` + `paypal-subscriptions.js` + `package.json` — the working
  practice site (auth, sessions, SQLite, PayPal sandbox **recurring membership**: Subscriptions +
  signed webhooks, A2). `test-a2-subscriptions.mjs` verifies the payment logic offline.
- `public/` — the practice site's HTML pages.
- `*.js` migration scripts (`create-db.js`, etc.) — history of how the practice DB was built; reference only.
- `render.yaml` — Render deploy config (we test on Render free tier).

**Not copied (intentionally):** `node_modules/` (run `npm install`), `database.db` (start fresh —
tables auto-create on boot), npm caches, `.git` (this will be its own repo), local session metadata.
