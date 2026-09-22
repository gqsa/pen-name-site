# Progress — gqsa Site + Backend Learning

> **Living handoff document.** This file is the source of truth.
> Update the **Status** of a row the moment we finish it, and add a one‑line "done / what we learned" note.
> If a fresh session opens, it should read **this file first** — everything needed to continue (context,
> constraints, the plan, and what's done) is here. No need to re‑explain the background.

**Last updated:** 2026‑09‑21 (renamed to gqsa; O4 tiers decided; **O6 decided: EJS**; A3–A5 re‑positioned; `gqsa-Site` = source of truth; **§8 main‑Site handoff instruction recorded — do not execute yet**. **A1 DONE — security hardening complete (bcrypt, env secrets, CSRF, login rate-limit; verified by test-a1-security.mjs, 10/10 PASS)**. **A2 DONE — recurring payments complete (PayPal Subscriptions + signed webhooks; the one-time Step-9 flow is REPLACED; verified by test-a2-subscriptions.mjs, 19/19 PASS offline). Next: B0/EJS scaffold + A3 profile.**.)

---

## 1. What we're building (the "why" — read this first)

We are building the website for the pen name **gqsa** (always lowercase — it's the site's name too):
a site that hosts **comics (images) and stories (text)**, with **member‑only content** and
**payments**. It exists to replace a fragile manual workflow:

**Current funnel & the pain it replaces**
- **Comics** live on **Pixiv** → funnels readers to **Ko‑fi**: buy individual comics in the shop,
  *or* join the Ko‑fi **membership** for exclusive comics.
- **Stories** live on **AO3** + **Hentai Foundry** → funnel readers to **Patreon**.
- **Exclusive content delivery today:**
  - Comics: I paste comic pages into a **Google Doc**, share the link as the purchased/membership item.
  - Stories: Patreon members **DM me their Gmail**, and I share a **Google Doc archive** of exclusive
    story links scoped to their tier.
- **The problem:** this is manual, unscalable, and my offering has outgrown it.

**The one thing Google Docs gives us that we must NOT lose:**
> Google Docs lets me **turn off the viewer's ability to copy text / images**. That has been the
> **backbone of my content security**. Whatever we build must at least match that, ideally beat it.

---

## 2. Current state (what exists right now)

### 2a. The "practice" site (this workspace) — already built & deployed
A working Node.js + Express + SQLite (`node:sqlite`) app, live on Render free tier:
`https://my-website-backend-test.onrender.com`

It has (all working):
- [x] User registration + login, **session**‑based auth
- [x] SQLite DB storing users + per‑user progress
- [x] Protected dashboard + interactive checklist that saves per‑user data
- [x] **PayPal sandbox** **one‑time** membership upgrade (order → approve → capture)
- [x] Auto‑creates tables on startup (production‑safe first boot)
- [x] `render.yaml`, `.gitignore`, git init, GitHub push
- [x] `skill-site-creation.md` — the step‑by‑step recipe for this exact build

**Known gaps in the practice site** (these ARE the "learning next steps" we still owe):
- [x] ~~Password hashing is SHA‑256~~ → **bcrypt now** (A1 done 2026‑09‑21, incl. transparent upgrade path)
- [x] ~~Session secret hardcoded fallback~~ → **env‑only now, fail‑fast in prod** (A1 done 2026‑09‑21)
- [x] ~~No CSRF protection~~ → **session‑bound tokens on all forms + fetch() headers** (A1 done 2026‑09‑21)
- [x] ~~**One-time** payment only — no recurring billing yet~~ → **recurring now** (A2 done 2026‑09‑21: monthly subscription + signed webhooks; one-time flow replaced)
- [ ] No profile edit / password reset / email / admin panel (A3/A4 — ride along with Phase B)
- [ ] Frontend is **inline HTML strings** in `server.js` (EJS adoption happens during B0/B3, O6)

### 2b. The gqsa site (the real goal)
**Not started yet.** It will live in a **new workspace** (the `gqsa-Site` folder — already copied with
the starting files + this plan) and be built **from `skill-site-creation.md`**,
reusing the auth/payments patterns we already have, then adding content + membership features.

---

## 3. Key constraints & decisions (the rules of the game)

| # | Constraint / decision | Detail |
|---|-----------------------|--------|
| C1 | **Not deploying to Hostinger yet.** | We are **not ready** to move to Hostinger. Treat it as **deferred** (see Phase C). |
| C2 | **Test on Render free tier.** | Render free is our dev/test target for now. |
| C3 | **⚠️ Render free = EPHEMERAL disk.** | On the free tier, the filesystem (and thus `database.db` **and** any uploaded comic/story files) is **wiped on every restart / after inactivity**. **Decided (O3):** accepted for the learning phase — I re‑upload test images/stories via the admin page each time I verify a feature; no backlog compilation. Real storage must be solved **before real members** (B9). |
| C4 | **Content security = layman copy‑prevention (decided).** | **The bar (O2):** "no one can highlight or copy text using regular layman methods" — exactly what Google Docs' disable‑copy gives us today. DevTools bypasses are **acceptable** (possible on Docs too; if someone has the time to do that for 1M+ words, they earned it). Screenshots are not a concern. **Decided (O2):** B8 = CSS `user-select: none` on story text, disable image drag/right‑click, and keep content auth‑gated (free users never receive it). No watermarking, no signed‑URL project. |
| C5 | **Payments: own‑site (confirmed).** | **Decided (O1):** we are working towards a **self‑sufficient shop + memberships on my own site** (PayPal — matches the learning path, and the test site already speaks PayPal). Ko‑fi/Patreon remain the **fallback**: I can disable site payments and funnel from Ko‑fi/Patreon if I later decide to keep them as the payment layer. |
| C6 | **gqsa site = NEW workspace** (`gqsa-Site`), built from `skill-site-creation.md`. **Source of truth:** the `gqsa-Site` copy is the working code from now on — all A/B work happens there. | Don't cram it into the practice repo; start fresh and bring in the hardened patterns. The original Backend Practice workspace is **reference/history only** (its Render deploy stays up as the test server) — don't go editing the old workspace for project work. |
| C7 | **Content is adult / mature.** | Affects host + payment acceptance (Ko‑fi/Patreon/PayPal all have adult‑content rules). Keep the app **portable** so we can move hosts cheaply if a provider's ToS becomes an issue. |
| C8 | **Tiers: admin‑managed flexibility (decided).** | The tiering design itself isn't important — what matters is that **I can create tiers through the admin page as I please**. Early on, one **hard‑coded** membership tier is fine (created tiers would be lost on server reset anyway, C3). The **framework** must support the usual Patreon/Ko‑fi optimisations later: tier names, prices, perks, which content each tier unlocks (O4). |

---

## 4. Game plan (ordered steps + status)

Status legend: `⬜ not started` · `🔵 in progress` · `✅ done` · `⏸ deferred`

### Phase A — Learning foundations (done on the `gqsa-Site` starting code)
*A1 + A2 are standalone "learn the pattern first" steps. A3–A5 ride along with the gqsa site build
(Phase B) — they're not separate exercises. Each is a "next step" from `next_steps.txt` that we currently owe.*

| Step | Status | Notes / what we'll learn |
|------|--------|--------------------------|
| A1. **Security hardening** — bcrypt passwords, env‑only secrets, CSRF tokens, rate‑limit login | ✅ | `next_steps` #1. **Done 2026‑09‑21** on the gqsa‑Site starting code. What we learned: bcrypt (bcryptjs = same algorithm, pure JS) replaces SHA‑256, with a **transparent upgrade** — legacy SHA‑256 accounts still log in and get re-hashed to bcrypt on first login; secrets (session secret + PayPal creds) now come **only from the environment** via new `loadEnv.js` (self-running at import time, never overrides real env vars) + `.env` (gitignored) + committed `.env.example`; production **fails fast** if SESSION_SECRET is missing; **CSRF** = session-bound random token embedded in every form (hidden field) / sent by fetch() as `X-CSRF-Token` header, compared with `timingSafeEqual`; **login rate-limit** = in-memory per-IP, 5 attempts / 15 min (env-tunable via LOGIN_MAX_ATTEMPTS), 429 after. Consequences: login/register pages are now **server-rendered** (static `public/login.html`+`register.html` deleted — a static file can't carry a per-session token); PayPal sandbox creds that were hardcoded in `paypal-config.js` moved to local `.env`. Verified by `test-a1-security.mjs` (10/10 PASS). Gotcha: native `bcrypt` fails to install under the DSH sandbox (postinstall spawn EPERM) — bcryptjs is the drop-in replacement; swap back to `bcrypt` on a normal machine if desired. |
| A2. **Recurring payments** — PayPal **Subscriptions** + **webhooks** so membership renews monthly | ✅ | **Done 2026-09-21.** The one-time Step-9 flow is **REPLACED** (membership is now a monthly-renewing subscription). What we learned: **webhook signature verification** (RSA — verify `id\|time\|webhookId\|sha256(body)` against the cert PayPal hands us, 5-min replay window), **idempotency** (dedupe by event id in `paypal_webhook_events`, `INSERT OR IGNORE`, so PayPal's "retry until 2xx" is safe), **state transitions** (`free→active→suspended→active` / `→cancelled`, applied by `applyMembershipEvent`, idempotent + crash-replayed at startup). The **webhook is the source of truth** — the return page is pure UX that polls `/membership-status`. Files: `paypal-subscriptions.js` (all PayPal API + verification), `test-a2-subscriptions.mjs` (19/19 PASS offline; no real money). **To go live:** create the webhook in the PayPal dashboard pointing at `/paypal-webhook`, paste its id into `.env` (`PAYPAL_WEBHOOK_ID`), deploy (Render) so PayPal can reach it, and test with a sandbox account. **Deploy context (2026‑09‑21):** code lives on GitHub **`gqsa/pen-name-site`** (private, on the pen‑name `gqsa` account — the earlier `reece9joe` copy was deleted; Render's GitHub App only sees the `gqsa` account, hence the move). Render service = **`pen-name-site`** → **https://pen-name-site.onrender.com** (live); `render.yaml` service name + `APP_URL` env match it. GitHub tokens live in local git remote URLs only (never in committed files). |
| A3. **Password reset** (email‑based) | ⬜ | `next_steps` #4. A real site needs it; also teaches email sending. Built **as part of Phase B** once the account pages exist (needs an SMTP provider, e.g. Resend/Mailgun). |
| A4. **Simple admin panel** (list members, toggle membership, view payments, **create/edit tiers**) | ⬜ | `next_steps` #4. We'll manage members by hand today — automate it. Tier editor per C8/O4: name, price, perks, active toggle. Built **as part of Phase B** — it's the superset of B2's upload area. |
| A5. **Frontend approach** — ✅ **DECIDED: EJS** (O6). Adoption = install `ejs`, move HTML out of `server.js` into `views/`, render pages as templates | ⬜ (decided; adoption happens during B0/B3) | `next_steps` #5. Settled 2026‑09‑21 — **EJS for this site**. React/Vue is deliberately parked for the **main‑Site** project (see §8). |

### Phase B — gqsa site core (NEW workspace, from `skill-site-creation.md`)
*This is the product. Order is chosen so each step reuses a Phase A skill.*

| Step | Status | Notes / what we'll learn |
|------|--------|--------------------------|
| B0. **Scaffold new project** from `skill-site-creation.md` + bring in A1's hardened auth | ⬜ | New workspace/repo. Copy the bcrypt/env/CSRF patterns in from day one. |
| B1. **Content database** — tables for Stories, Comics (multi‑page), Images, Videos; fields: title, description, body/pages, publish date, free‑vs‑member, tier; **plus a `tiers` table** (name, price, perks, active) | ⬜ | `gqsa site` Phase 1 step 1. Models our two funnels (comics + stories). Start with ONE hard‑coded tier for learning (C8/O4) — but the schema already supports admin‑created tiers. |
| B2. **Admin upload area** (protected, only me) — add stories, upload comic pages/images/video, save metadata | ⬜ | `gqsa site` Phase 1 step 2. Teaches file upload + storing file refs in DB. |
| B3. **Public display pages** — Home/latest, Stories list + story page, Comics list + page reader, Image gallery, Video page | ⬜ | `gqsa site` Phase 1 step 3. The storefront that replaces the Pixiv/AO3 landing. |
| B4. **Member‑only gating** — reuse sessions + membership flag; some items free, some members‑only | ⬜ | `gqsa site` Phase 1 step 4. Replaces "share a gated Google Doc." |
| B5. **Reading/viewing experience** — clean story layout, next/prev comic pages, image lightbox, video player | ⬜ | `gqsa site` Phase 1 step 5. The part readers actually feel. |
| B6. **Progress tracking** — save where a user left off (story/comic), "Continue" button | ⬜ | `gqsa site` Phase 1 step 6. Reuses our checklist pattern. |
| B7. **Wire in recurring membership** (from A2) — access per tier (start: free + one hard‑coded paid tier) | ⬜ | `gqsa site` Phase 1 step 7. Replaces manual Ko‑fi/Patreon DM‑Gmail handoff. Tiers are admin‑managed (C8/O4): price/perks/name editable later. |
| B8. **Copy‑prevention (layman standard)** — CSS `user-select: none` on story text, disable image drag/right‑click; content stays auth‑gated | ⬜ | Matches the Google‑Docs bar: stop casual copying, don't chase DevTools. Optional: noindex on member pages. |
| B9. **Storage for real members** — make uploaded files + DB survive restarts | ⬜ | **Deferred per O3:** fine to re‑upload test content each time while learning. Solve (object storage or persistent disk) **only when real members arrive**. Keep file locations abstracted in B1/B2 so the backend can be swapped. |

### Phase C — Production hardening (deferred until we're ready to leave free tier)
| Step | Status | Notes |
|------|--------|-------|
| C1. **Deploy the gqsa site to Hostinger** (or another VPS) + connect domain | ⏸ | `next_steps` #2 / `gqsa site` step 8. **Deferred by C1.** Revisit when we decide to commit to a paid host. |
| C2. **Domain / DNS move** (nameservers, 301 rules if URLs change) | ⏸ | Only if/when we move hosts or change URLs. |
| C3. **Image optimisation** (sharp → WebP) + proper static serving (cache headers, range requests) | ⏸ | `gqsa site` Phase 2 step 2–3. Do when files get large / slow. |
| C4. **Reverse proxy + process manager** (Nginx + PM2/systemd) | ⏸ | `gqsa site` Phase 2 step 4. VPS‑era concern. |
| C5. **CDN** (Cloudflare free) in front | ⏸ | `gqsa site` Phase 2 step 5. Speed + basic protection. |
| C6. **Database upgrade** SQLite → Postgres/MySQL | ⏸ | `gqsa site` Phase 2 step 6. When concurrency/reliability demand it. |
| C7. **Monitoring + automated backups** | ⏸ | `gqsa site` Phase 2 step 8. Non‑negotiable once real members exist. |
| C8. **Background jobs** (thumbnails, conversions) | ⏸ (optional) | `gqsa site` Phase 2 step 7. Only if we add video/thumbnails at scale. |

---

## 5. Open questions / assumptions to confirm (answer these when ready)

These don't block planning, but they **will** change scope. Mark them when decided.

- **O1 — Payments:** ✅ **DECIDED: own‑site PayPal.** Self‑sufficient shop/memberships on my own site
  (matches the learning path + existing PayPal code). Ko‑fi/Patreon stay as the fallback: disable site
  payments and funnel from them if I later decide to keep them as the payment layer. A2/B7 proceed as
  "subscribe via PayPal."
- **O2 — Content‑security depth:** ✅ **DECIDED: layman methods only.** The bar is "no one can highlight
  or copy text using regular layman methods" — the same bar Google Docs' disable‑copy sets today.
  DevTools bypasses are acceptable (possible on Docs too; if someone has the time to do that for 1M+
  words of stories, they earned it). Screenshots are not a concern. B8 = `user-select: none` + image
  drag/right‑click disabled + server‑side gating. No watermarking, no signed‑URL project.
- **O3 — Storage on free tier:** ✅ **DECIDED: accept ephemeral during learning.** I re‑upload test
  images/stories through the admin page each time to check the feature we're working on; no backlog
  compilation during the learning steps. Solve real storage at B9, **only when real members arrive**.
  Still keep file locations abstracted in B1/B2 so we can swap backends later.
- **O4 — Tiers:** ✅ **DECIDED: admin‑managed, design‑flexible.** The site's tiering itself isn't
  important — what matters is that **I can make tiers through the admin page as I please**. Early on,
  one **hard‑coded** membership tier is acceptable (created tiers would be lost on server reset
  anyway, C3). The **framework** must let me later optimise the usual Patreon/Ko‑fi things: tier
  names, prices, perks, and which content each tier unlocks. Nothing is hard‑wired to today's two
  funnels — separate comic/story tiers stay possible later.
- **O5 — Host:** Is **Hostinger** still the intended paid host, or open to alternatives (given adult‑content
  ToS, C7)? *(Assumption: Hostinger remains the target, but keep the app portable.)*
- **O6 — Frontend approach:** ✅ **DECIDED: EJS** (2026‑09‑21). Server‑rendered templates, no build step,
  stays 100% Express — every gqsa page (B2 admin, B3 display, B5 reader) is written as an EJS template.
  **React/Vue is deliberately NOT used on this site** — it's parked for the **main‑Site** project (see §8),
  where animations + gamified interactive reading will need real interactivity.

---

## 6. Recommended order to work (the actual "next step" right now)

1. ~~**A1 — Security hardening** (bcrypt + env secrets + CSRF)~~ — **DONE** (2026‑09‑21).
2. ~~**A2 — Recurring payments** (PayPal Subscriptions + webhooks)~~ — **DONE** (2026‑09‑21).
3. **B0 — Adopt the gqsa site scaffold** (workspace `gqsa-Site` already holds the starting code — `npm install`, first boot, confirm A1's patterns are in place).
4. **Frontend: EJS (O6 decided)** — set up `ejs` + a `views/` folder during B0, and write every page as an EJS template from then on. *Decided 2026‑09‑21. React/Vue is out of scope for this site by design (§8).*
5. **B1 → B2 → B3 → B4** — content DB, uploads, display, gating (the core "it works" loop), pages written in the chosen approach.
6. **B5, B6** — reading experience + progress tracking (polish readers feel).
7. **B7 — wire recurring membership** end‑to‑end.
8. **B8** — copy‑prevention (layman standard) · **B9** — real storage (only when real members arrive).
9. **C1+** — Hostinger/domain/CDN/DB upgrades **when we're ready to leave the free tier.**

> **We are NOT touching Hostinger (C1).** A1 + A2 are done — the next build step is **B0**
> (scaffold + EJS setup), then B1 onward. A3–A5 will ride along with Phase B as noted above.

---

## 7. How to use this file (handoff protocol)

- **Start of any session:** read §1–§3 for context, then scan §4 for the first `⬜` in the recommended order (§6).
- **When a step is done:** set its Status to `✅` and add a one‑line note (what changed, what we learned, any gotcha).
- **If a decision in §5 gets made:** write the answer inline next to O1–O5 and adjust any affected rows.
- **If scope changes:** edit the row, don't delete it — keep the trail so a future session sees why.
- Keep this file **in every workspace** that touches this project. The `gqsa-Site` copy now lives **one level up** (`D:\Workspace\Deepseek Harness\gqsa-Site`) — keep both copies in sync whenever you edit one (writes there need a one‑time sandbox approval from this workspace).

---

## 7a. A2 hotfix — 2026‑09‑22 (membership never flipped; plan was one‑shot)

User approved the sandbox subscription (sub `I‑82RXE3SC9RGT`, $1 charged) but membership never flipped.
Diagnosis (all verified against the LIVE sandbox via API):

- **Webhook was fine all along:** `2G297211261546444` → `…/paypal-webhook`, all four events
  (ACTIVATED / SUSPENDED / CANCELLED / **RE‑ACTIVATED**) ENABLED. (The "events not selected" alarm was a
  misread — the list endpoint exposes them as `event_types`, and the detail endpoint shows them enabled.)
- **Root cause #1 (membership):** `PAYPAL_WEBHOOK_ID` was **not in the local .env** (and evidently not in
  Render either) → verification string built with the `PASTE_YOUR_WEBHOOK_ID` placeholder → every genuine
  event 400'd → no state change. FIX: `PAYPAL_WEBHOOK_ID=2G297211261546444` now in the local .env; the
  USER MUST ADD THE SAME VALUE IN RENDER (pen‑name‑site → Environment). PayPal retries failed deliveries
  for up to 3 days, so the pending ACTIVATED event should flip the user on its next retry after redeploy.
- **Root cause #2 (product bug):** plan `P‑5UW59772X95694310NKZAIHI` has `total_cycles: 1` — PayPal
  **defaults `total_cycles` to 1 when omitted** (spec: 0 = runs forever; 1–999 = finite). So the "monthly
  membership" was a ONE‑SHOT charge: sub activated 04:30:40Z, EXPIRED ~1s later. PATCH can't fix it (spec:
  only description / name / payment_preferences / taxes are patchable).
- **Code fixes (this commit):**
  1. `ensurePlan` is now self‑healing: validates the cached plan (must be ACTIVE + `total_cycles: 0`),
     else creates a proper recurring plan (`total_cycles: 0`), best‑effort deactivates the old one, and
     tolerates duplicate‑name rejection (retries with "… (monthly)"). No DB surgery needed.
  2. `MEMBERSHIP_EVENTS` gained `BILLING.SUBSCRIPTION.RE‑ACTIVATED` (the API's actual re‑activation name;
     REINSTATED kept as a legacy alias).
  3. `server.js` logs every webhook attempt: `[A2] webhook ACCEPTED/REJECTED: <event> — <reason>` →
     checkable in Render logs.
- **Tests:** `node test‑a2‑subscriptions.mjs` → all pass (signature, state machine, pipeline, recovery).
- **Cleanup:** scratch `.dsh‑*.mjs` scripts deleted; previous session's `scratch‑spec‑check.mjs` still
  untracked (harmless).

---

## 8. After gqsa‑Site: main‑Site handoff (deferred instruction — do NOT start now)

When the gqsa‑Site work is done, the next project is the **main‑name site** — a *different* site, a different
workspace. Recorded here so a future session has the instruction without a re‑explanation:

- **What it is:** the user's **main‑name site, currently on Squarespace**, to be **redone / moved to
  Hostinger**. The user has **already built the site in HTML**. Parts of it — the **animations**, and the
  **gamified reading experience** wanted for the main‑name stories — are overkill for plain HTML and are
  likely better done with **React or Vue**.
- **When to set up the handoff:** only **after gqsa‑Site is done**. Then:
  1. **Assess what has already been done/learned** from `next_steps.txt` via the gqsa‑Site work
     (security hardening, recurring payments, admin panel, EJS, …) — don't repeat it.
  2. Build a **`main-Site` handoff folder** (same pattern as the `gqsa-Site` folder: progress.md +
     next_steps.txt + README + the relevant skill file) scoped to **what's left**, including the
     **React/Vue** decision for the interactive/animation parts.
- The Squarespace‑site specifics are in `next_steps.txt` — read it **at that time**, not before.
- **Do not execute any of this yet.** The instruction is recorded; that's all it is right now.
