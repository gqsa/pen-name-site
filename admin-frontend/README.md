# gqsa admin — `admin-frontend`

The **React + Vite** admin area (O6 revised: public site stays EJS; `/admin` is the SPA).
Express is the only gate: the SPA HTML and every `/api/admin/*` route answer non-admins
with 403, and the built assets are served to admin sessions only.

## Run it in DEV — two terminals

```bash
# Terminal 1 — Express (public site + API) on :3000
npm run dev

# Terminal 2 — Vite dev server on :5173
npm run dev -w admin-frontend
```

Then open **http://localhost:5173/admin/** in the browser.
If you're not logged in as the owner, the shell offers a login link —
log in there (the login page is proxied to Express, so the session cookie
stays same-origin) and reload `/admin/`.

Why the proxy: the Vite dev server forwards the Express routes
(login/register/dashboard/settings/paypal + `/api` + the two admin endpoints)
to :3000, so cookies and fetches behave exactly like production.
See the proxy table in `vite.config.js`.

## Run it in PROD (or Render)

```bash
npm ci && npm run build:admin && node server.js
```

`build:admin` writes `admin-frontend/dist/`; Express serves that at `/admin`
(`base: '/admin/'` keeps the asset URLs under `/admin/assets/…`). No Vite needed at runtime.
(If `dist/` is missing, `/admin` falls back to the EJS admin page, so the admin
area stays reachable on a fresh disk.)

## Notes for the next session

- CSRF: the shell fetches the token from `GET /api/admin/boot` and sends it as
  the `X-CSRF-Token` header on every state-changing POST (same posture as the
  EJS `fetch()` calls in `views/admin.ejs`).
- Theme: red `#AC2E34` on black — `src/index.css` mirrors
  `views/partials/head.ejs`; keep both in sync.
- The SPA mounts at `#root`; `App.jsx` is the shell — B2.3 (tracker),
  B2.5–B2.7 (editors) and B2.9 (announcements) all land inside it.
