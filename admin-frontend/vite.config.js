import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// B2.2 — where this app lives, and how dev talks to Express.
//
// base: in production, Express serves the built app AT /admin (index.html at
// /admin, assets under /admin/assets/…). Vite bakes `base` into the built
// index.html, so asset URLs come out as /admin/assets/… and Express's
// express.static mount at /admin picks them up.
//
// server.proxy: in dev, Vite runs on :5173 and PROXIES the Express routes to
// :3000. Same origin, so the session cookie the Express login sets is usable
// by the SPA's fetch() calls (/api/admin/boot, later /api/admin/*). Log in on
// :5173 and it just works — no CORS, no cookie juggling.
//
// NOTE: /admin itself is NOT proxied — in dev the SPA lives at :5173/admin/
// (the base path). Only the Express sub-paths under /admin are proxied.
const EXPRESS = 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    port: 5173,
    proxy: {
      // auth + account (login flow must work from :5173)
      '/login': EXPRESS,
      '/register': EXPRESS,
      '/logout': EXPRESS,
      '/dashboard': EXPRESS,
      '/settings': EXPRESS,
      '/change-password': EXPRESS,
      '/forgot-password': EXPRESS,
      '/reset-password': EXPRESS,
      // membership / paypal (the SPA will surface these; keep same-origin)
      '/join-membership': EXPRESS,
      '/cancel-membership': EXPRESS,
      '/paypal-return': EXPRESS,
      '/paypal-cancel': EXPRESS,
      '/membership-status': EXPRESS,
      // admin API + the two EJS-era admin endpoints the React app calls
      '/admin/toggle-roadmap': EXPRESS,
      '/admin/notify': EXPRESS,
      '/api': EXPRESS,
      // B2.5 Step 2: uploaded content (comic pages / images / videos) is served
      // by Express from public/uploads — the SPA references those files as
      // /uploads/… in <img src>, so dev must proxy them or every thumbnail is
      // broken in :5173 (prod is fine: Express serves them same-origin).
      '/uploads': EXPRESS,
    },
  },
})
