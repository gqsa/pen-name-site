# Progress — gqsa Site + Backend Learning

> **Living handoff document.** This file is the source of truth.
> Update the **Status** of a row the moment we finish it, and add a one‑line "done / what we learned" note.
> If a fresh session opens, it should read **this file first** — everything needed to continue (context,
> constraints, the plan, and what's done) is here. No need to re‑explain the background.

**Last updated:** 2026‑09‑22 (renamed to gqsa; O4 tiers decided; **O6 decided: EJS**; A3–A5 re‑positioned; `gqsa-Site` = source of truth; **§8 main‑Site handoff instruction recorded — do not execute yet**. **A1 DONE — security hardening complete (bcrypt, env secrets, CSRF, login rate-limit; verified by test-a1-security.mjs, 10/10 PASS)**. **A2 DONE — recurring payments complete (PayPal Subscriptions + signed webhooks; the one-time Step-9 flow is REPLACED; verified by test-a2-subscriptions.mjs, 18/18 PASS offline). A2 hotfix #3 (§7c): grant now happens in `/paypal-return`, which asks PayPal's API "is this sub ACTIVE?" and applies the same idempotent `applyMembershipEvent` (sandbox webhooks keep failing signature verification; webhook stays armed for revocation + production). VERIFIED LIVE: user is Member ⭐. A2 hotfix #4 (§7d): the Cancel button was a no-op (wrong API — `DELETE` 404'd without cancelling, so a charged sub couldn't be cancelled); fixed to `POST …/cancel` (204 → CANCELLED) + membership flipped off locally + de-scared error page; VERIFIED end-to-end. **B0 DONE (2026‑09‑22): EJS adopted — all 5 pages + head/footer partials are `views/*.ejs`, inline HTML strings removed, every flow page shares one `message.ejs`; boots clean, all pages + membership UI verified.** **B1 DONE (2026‑09‑22): content database — 6 idempotent tables (tiers / stories / comics / comic_pages / images / videos) + one-time sample seed (1 tier "Patron", 2 stories, 2 comics, 1 image, 1 video); comic→pages parent/child with `ON DELETE CASCADE` + `UNIQUE(comic_id,page_number)`; seed idempotent (verified no-dup after a restart). Site themed red `#AC2E34` on black (shared `partials/head.ejs`).** **B2 DONE (2026‑09‑22): admin area + implementation tracker — “Your learning progress” retired (dashboard checklist + `/save-progress` + `progress` table all gone); new `roadmap` table (16 items, idempotent seed); `ADMIN_USERNAME` gate + `/admin` tracker page (toggleable, done‑count) + `/admin/toggle-roadmap` (CSRF + admin‑gated); A1 suite reworked self‑contained (spawns its own server; **14/14** incl. admin‑gate + boot‑seed checks); A2 re‑verified 18/18 incl. live section. **B2.1 DONE (2026‑09‑22): admin account now survives Render's disk wipes — boot‑seed creates `ADMIN_USERNAME` with `ADMIN_PASSWORD` when the account is missing (existing accounts never overwritten).** **A3 DONE (2026‑09‑23) — augmented per user request: accounts & email. Email at signup (collected NOW; the `EMAIL_REQUIRED` env switch flips optional→mandatory later, and that flip IS the migration), per‑account opt‑out for announcements (/settings), change password, email‑based password reset (token stored only as SHA‑256, 30‑min, single‑use, generic "if that account exists" answer = no enumeration oracle), and the member‑blast pathway — ONE `sendEmail()` pipe (console/file transports today, real provider in the C1 era) + `notifyMembers()` (respects opt‑outs) + `/admin/notify` + the /admin "Send to members" panel. Verified by `test-a3-accounts.mjs` **18/18** (two spawned servers: the optional state + the required state); A1 re‑verified 14/14, A2 re‑verified 18/18 incl. live. Roadmap updated: A3 done, A4 re‑scoped (tiers + payments; the member list itself moved to new **B10**, end of Phase B). NEXT: **B3 (comic editor)**.)

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
- [x] ~~No password reset / email / account settings~~ → **A3 done 2026‑09‑23**: email at signup (optional now, `EMAIL_REQUIRED` switch flips to mandatory later), announcements opt‑out, change + email‑reset password, member blasts (one `sendEmail()` pathway)
- [ ] No profile edit / admin panel (A4 — lands between B6 and B7; the member list itself is now **B10**)
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
| A3. **Accounts & email** — email at signup (optional now, mandatory later), notifications opt‑out, change + reset password, member announcements | ✅ (2026‑09‑23) | `next_steps` #4, **augmented per user request**: email is part of the account from day one (we're building the list NOW — "no optional email" is the end state, not the start), ONE shared pathway for blasts + resets, per‑user opt‑out in settings. What we built: **(1) email at signup** — always shown + collected; the `EMAIL_REQUIRED` env switch decides whether a blank one is accepted (false today, true later — **flipping the env var IS the "no optional email" migration**; invalid emails rejected either way). **(2) `/settings`** — the account's email + the "send me announcements" checkbox (`email_notifications`, default ON; NULL counts as ON so every pre‑A3 account is still notified) + **change password** (current password required). **(3) Password reset** — `/forgot-password` (username OR email; the answer is **identical whether or not the account exists** — no enumeration oracle; rate‑limited like login) → link through the email pathway; the token is 64‑hex, **only its SHA‑256 is stored** (a DB leak can't read live links), 30‑min expiry, **single‑use**. **(4) Member blast** — the ONE pathway `sendEmail()` (transports: **console** log or **file** JSON outbox you can open and read; a real provider — Resend/SMTP — is a third branch added in the C1 era, nothing else changes) + `notifyMembers()` (respects opt‑outs; returns sent / optedOut / noEmail counts) + `/admin/notify` (admin‑gated + CSRF) + a **"Send to members" panel on /admin** (shows which transport the mail goes to). Login stays username+password — email is the comms channel, not a credential. Verified by `test-a3-accounts.mjs` **18/18** (two spawned servers: the optional state AND the required state); A1 re‑verified 14/14, A2 re‑verified 18/18 incl. live. |
| A4. **Admin panel — tiers + payments** (tier CRUD + payments overview + hand‑toggle membership; the **member list itself is now B10**) | ⬜ | `next_steps` #4. We'll manage members by hand today — automate it. Tier editor per C8/O4: name, price, perks, active toggle. **Lands between B6 and B7** (B7's tier‑gating needs the tier infra to exist); the member‑list portion moved to **B10** (the audience‑page spec, end of Phase B). |
| A5. **Frontend approach** — ✅ **DECIDED: EJS** (O6). Adoption = install `ejs`, move HTML out of `server.js` into `views/`, render pages as templates | ⬜ (decided; adoption happens during B0/B3) | `next_steps` #5. Settled 2026‑09‑21 — **EJS for this site**. React/Vue is deliberately parked for the **main‑Site** project (see §8). |

### Phase B — gqsa site core (NEW workspace, from `skill-site-creation.md`)
*This is the product. Order is chosen so each step reuses a Phase A skill.*

| Step | Status | Notes / what we'll learn |
|------|--------|--------------------------|
| B0. **Scaffold new project** from `skill-site-creation.md` + bring in A1's hardened auth | ✅ (2026‑09‑22) | **DONE.** This workspace `gqsa-Site` IS the scaffold — A1‑hardened auth + A2 recurring payments already in. **EJS adopted (O6):** all 5 pages (home/login/register/dashboard/message) + 2 partials (`partials/head.ejs`, `partials/footer.ejs`) are now `views/*.ejs`; the inline HTML strings in `server.js` are gone. Every membership/flow page (register/login success‑fail, 403 CSRF, join‑/cancel‑membership, paypal‑return/cancel, logout) migrated to one shared `message.ejs` (locals are `typeof`‑guarded, so a missing optional local can't 500). Verified: boots clean, all pages render, membership UI pages render with the shared head/footer, no `undefined` locals leak. |
| B1. **Content database** — tables for Stories, Comics (multi‑page), Images, Videos; fields: title, description, body/pages, publish date, free‑vs‑member, tier; **plus a `tiers` table** (name, price, perks, active) | ✅ (2026‑09‑22) | **DONE.** 6 tables in `server.js` (idempotent `CREATE TABLE IF NOT EXISTS`): `tiers` (name, price in **cents**, currency, perks, active), `stories` (title, description, **body** text, publish_date, is_member, tier_id), `comics` + child `comic_pages` (comic_id, page_number, **file_path**; `ON DELETE CASCADE` + `UNIQUE(comic_id,page_number)` — the parent/child relationship), `images`, `videos`. One‑time **idempotent seed** (only while a table is empty): 1 tier (Patron, $5/mo), 2 stories (1 free + 1 member), 2 comics (free 3‑page + member 2‑page), 1 image, 1 video. Verified: counts correct after boot **and after a restart** (no duplicates), cascade + unique constraints present, gated stories correct. **Theme set (O‑new):** site is now **red `#AC2E34` on black** — applied to the shared `partials/head.ejs` CSS so every page + future B3 pages inherit it. |
| B2. **Admin area + Implementation Tracker** | ✅ (2026‑09‑22) | **DONE.** “Your learning progress” retired: dashboard checklist removed, `/save-progress` endpoint removed, per‑user progress seed removed, `progress` table DROPPED on boot. New `roadmap` table (idempotent seed — 16 items A1–A5 / B0–B9 / C1 with done flags: A1, A2, A5, B0, B1, B2 = done) + `ADMIN_USERNAME` env gate (`isAdmin(req)`; empty value = nobody is admin) + `/admin` tracker page (`views/admin.ejs`: phase‑grouped checkboxes, done‑count) + `/admin/toggle-roadmap` (CSRF `X-CSRF-Token` header + admin‑gated, JSON). Dashboard shows “Open the admin area →” **only for the owner**. **A1 suite reworked:** now SELF‑CONTAINED — spawns its own server on a free port with a controlled env (fresh rate‑limit memory + a known `ADMIN_USERNAME`), so no stale port‑3000 / 429 carryover between runs; the stale check #5 (hit the now‑gone `/save-progress` + `progress` table) was retargeted to `/admin/toggle-roadmap` (CSRF‑on‑fetch: no‑header → 403 anti‑forgery, owner+header → 200 flag flips & restores, non‑owner+header → 403 “Not admin”) + 2 new `/admin` page checks → **13/13 PASS**. A2 re‑verified **18/18** incl. the live section. Gotcha: the DSH sandbox denies piped child stdio (EPERM) — the test spawns with `stdio: 'inherit'`. **B2.1 addendum (admin persistence):** the admin account itself now survives Render's free‑tier disk wipes — at boot, if `ADMIN_USERNAME` names an account that doesn't exist, it is created with `ADMIN_PASSWORD` (bcrypt, exactly like registration); an existing account is **NEVER overwritten** (a locally changed password always wins); `ADMIN_USERNAME` set but no account and no `ADMIN_PASSWORD` → loud boot warning (the admin area would otherwise 403 everyone, which looks like a bug). A1 suite now **14/14** — the new check proves the fresh‑disk path (boot‑seed creates the account → login with the env password works); the existing‑account branch was verified by a clean local boot (no create/warn lines). |
| B3. **Comic editor — upload + reorder + captions** | ⬜ | Split view: **editor (left) + live preview (right)** of the comic page. Drag/drop a batch of images; **click the dropzone to paste**; **double-click opens the file explorer**. **Drag images to reorder** (doubles as planning). A **caption field above each page** (shows above the image when the comic displays). **Auto-save** — every change is stored, no "post" step. |
| B4. **Comic editor — marquee / crop selection** | ⬜ | **Marquee** button → click an image → **drag a rectangle** over it → confirm (OK / Enter) → only that region shows in the comic. In preview, a **toggle on top** switches between the marquee'd crop and the full image. Re-marquee a page → prompt "use the new marquee?" (OK / Enter updates). |
| B5. **Story editor — upload / paste + Google Doc link** | ⬜ | Upload files, **paste files**, or **paste a Google Doc link** → read that doc's content into the story body (and pull its images). **Auto-save** every change. |
| B6. **Story archive import** | ⬜ | The "super powerful" bit: give an **archive Google Doc** (a doc whose links point at one story per linked doc) → read the links, fetch each linked doc, treat each as a **story**. A **button to download a story + its images into the DB**; a **global button** to do this for every link in the archive. (Replaces the per‑tier Google‑Doc archives.) |
| B7. **Story tier-gating (inline highlights)** | ⬜ | **Highlight text/images/sections inline**, then click a **tier button** above the editor → that region is **blurred for readers below that tier** + gets a **thin theme‑red premium border** for that tier and above. Option to **hide blurred sections** from lower tiers; a **global hide/show-all** toggle (default: show). |
| B8. **Public display + member gating** | ⬜ | Home/latest, **comic reader** (captions above pages, marquee'd crops, prev/next), **story pages** (with B7 tier‑gated highlights), image gallery, video page. Enforce **is_member + tier** (reuses A2 sessions/membership). **Copy‑prevention (layman standard):** CSS `user-select:none` + disable image drag/right-click; content stays auth‑gated. Optional: reader "continue where you left off." Replaces the Pixiv/AO3/Google‑Docs landing. |
| B9. **Storage for real members** | ⏸ | **Deferred per O3:** fine to re‑upload test content each time while learning. Solve (object storage or persistent disk) **only when real members arrive**. Keep file locations abstracted in B2/B3 so the backend can be swapped. |
| B10. **Audience page (member list)** — Patreon "audience" style: **active / free / cancelled tabs**; each row = username, plan/tier, **payments to date**, email, + **terminate membership** | ⬜ | Added 2026‑09‑23 (user spec: "the 'active' tab, but also good to have the 'free' and 'cancelled' tabs, each switching which users populate the list"). Lands **after B8** (end of Phase B, before the deferred B9). Data = A2's `users` (membership_status, email, member) + `paypal_webhook_events` (payments to date) + A4's tiers. Terminate = flip `member=0` / `membership_status='cancelled'` (the same machinery A2's cancel uses). |

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
3. ~~**B0 — Adopt the gqsa site scaffold**~~ — **DONE** (2026‑09‑22). Workspace `gqsa-Site` holds the A1‑hardened + A2 code; first boot confirmed healthy.
4. ~~**Frontend: EJS (O6 decided)**~~ — **DONE** (2026‑09‑22, during B0). `ejs` installed; every page is now a `views/*.ejs` template (5 pages + `partials/head.ejs` + `partials/footer.ejs`); all flow pages share one `message.ejs`. *React/Vue stays out of scope for this site by design (§8).*
5. ~~**B1 — Content database** (Stories/Comics+pages/Images/Videos + `tiers`)~~ — **DONE** (2026‑09‑22). 6 idempotent tables + one‑time sample seed; comic→pages parent/child with cascade; **site themed red `#AC2E34` on black**.
6. ~~**B2 — Admin area + Implementation Tracker (+ B2.1 admin boot‑seed)**~~ — **DONE** (2026‑09‑22). Learning progress retired; `/admin` tracker + `ADMIN_USERNAME` gate in; admin account auto‑created at boot from `ADMIN_USERNAME`/`ADMIN_PASSWORD` (survives Render wipes); A1 suite reworked self‑contained (14/14), A2 re‑verified (18/18 incl. live).
7. ~~**A3 — Accounts & email**~~ — **DONE** (2026‑09‑23). Email at signup (collected now; the `EMAIL_REQUIRED` switch flips optional→mandatory later — **that flip IS the migration**), announcements opt‑out in /settings, change + email‑reset password (token SHA‑256'd, 30‑min, single‑use, no enumeration oracle), member blasts — ONE `sendEmail()` pathway (console/file transports now, real provider in the C1 era) + `/admin/notify` + the /admin "Send to members" panel. `test-a3-accounts.mjs` **18/18**; A1 14/14 + A2 18/18 re‑verified.
8. **B3 — Comic editor (upload + reorder + captions + live preview + auto‑save)** — **NEXT (now).**
9. **B4 — Comic marquee / crop selection** (rectangle select → confirm → only that region shows; preview toggle; re‑marquee prompt).
10. **B5 — Story editor (upload / paste / Google Doc link + auto‑save).**
11. **B6 — Story archive import** (read an archive doc's links → stories; download a story + images; global button).
12. **A4 — Admin panel: tiers + payments** (tier CRUD + payments overview + hand‑toggle membership; the member list itself = B10) — **lands BEFORE B7** (B7's tier‑gating needs the tier infra).
13. **B7 — Story tier‑gating** (inline highlight → per‑tier blur + theme‑red premium border; hide/show blurred sections).
14. **B8 — Public display + member gating** (comic reader, story pages with B7 highlights, gallery, video; enforce is_member + tier; copy‑prevention).
15. **B10 — Audience page (member list)** — active / free / cancelled tabs; username, plan/tier, payments to date, email, terminate membership.
16. **B9** — real storage (deferred until members arrive) · **C1+** — Hostinger/domain/CDN **when we're ready to leave the free tier.**

> **We are NOT touching Hostinger (C1).** A1 + A2 + B0 (scaffold + EJS) + B1 (content DB + red/black theme) + B2 (admin + tracker) + **A3 (accounts & email)** are done —
> the next build step is **B3 (comic editor)**, then B4 → B5 → B6, **A4 (tiers + payments admin) BEFORE B7**, then B7 → B8 → **B10 (audience/member list)**. (A5 = EJS, adopted during B0.)
>
> **Push / deploy status (user asked 2026‑09‑22):** there **IS** a live test deploy — Render free tier
> (`pen-name-site.onrender.com`), auto‑deployed from the GitHub repo this workspace pushes to
> (`gqsa/pen-name-site`). **Pushed 2026‑09‑23: origin/main = b7c840d (A3) — everything (B0–B2.1 + A3) is now
> on Render** (auto‑deployed; the free‑tier disk wipe per C3 means the live DB/uploads reset — the boot‑seed
> recreates the admin from `ADMIN_USERNAME`/`ADMIN_PASSWORD` in Render's env). Guardrails on every step: (1) a git commit (rollback
> available) and (2) the suites green — `test-a1-security.mjs` (**14/14**) + `test-a2-subscriptions.mjs`
> (**18/18**, incl. live section) + `test-a3-accounts.mjs` (**18/18**), all self‑contained. B‑steps are additive
> (new routes/tables/pages), not changes to the A1/A2 core (auth + PayPal), so pushing is low‑risk; a push
> triggers a Render auto‑deploy and — per C3 — wipes the ephemeral DB/uploads (re‑upload test content after).
> Push when ready.

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

## 7b. A2 hotfix #2 — 2026‑09‑22 (webhook REJECTED ×3: "unknown reason" = signature mismatch)

Live deploy of 7a's code worked (fresh product + recurring plan created on join; user's sub
`I‑GNWPG3H62NH5` ACTIVE, $1 billed, `custom_id "1"`), but the ACTIVATED webhook still didn't flip
membership. Render logs showed three PayPal deliveries, all
`[A2] webhook REJECTED: (rejected before parsing) — unknown reason (from ::1)`.

- **Root cause (diagnosis):** "unknown reason" is only printable when
  `processPaypalWebhook` returned `{ accepted: false }` **without a reason**. In `verifyPaypalWebhook`,
  a failed `verifier.verify()` returned `{ valid: false }` — a boolean with **no reason field** — which is
  the signature-mismatch case. So: PayPal's genuine signatures failed verification ⇒ the verification
  string (`transmissionId|time|webhookId|bodyHash`) differed from PayPal's ⇒ **`PAYPAL_WEBHOOK_ID` on
  Render is missing, mistyped, or padded with a stray space/newline from pasting** (the one input we
  control; body bytes are preserved by `express.raw`, cert comes from PayPal's header).
- **Code fix (commit 02f301c):** verify-false now returns an explicit reason —
  `signature mismatch — PAYPAL_WEBHOOK_ID must be EXACTLY the webhook id from the PayPal dashboard …`.
  Next time, the Render log line self-diagnoses. All 15 tests pass.
- **State cleanup:** orphaned sub `I‑GNWPG3H62NH5` cancelled via API (204 → CANCELLED) so the user's
  re-join starts clean.
- **Unblock (user, manual):** (1) Render → Environment: `PAYPAL_WEBHOOK_ID` must be exactly
  `2G297211261546444` (17 chars, no whitespace); (2) `git push` (sandbox has no GitHub creds);
  (3) wait for the deploy to go Live; (4) re-join + approve in the sandbox. If it fails again, the new
  log line says exactly why.

---

## 7c. A2 hotfix #3 — 2026‑09‑22 (membership still didn't flip → grant moved to the API)

The user's live re-test still ended without membership. The signed-webhook grant has now failed in
sandbox every time (3× rejected; the "unknown reason" mystery of 7b was diagnosed as a genuine
signature mismatch, and the production verification path was PROVEN healthy — a correctly signed
request through the real path verifies fine — so the failure is input-specific, not a bug in our
pipeline). Chasing the exact discrepancy further was dropped as a blocker: **the grant no longer
depends on the webhook at all**.

- **New primary grant path (works in sandbox AND production):** `/paypal-return` — the page the
  browser lands on after approval — now asks PayPal's API directly, with our server credentials,
  "is the sub I created ACTIVE?" If yes (ACTIVE/TRIALING) it grants membership via
  `activateMembershipFromApi` → `applyMembershipEvent` — the SAME idempotent state machine the
  webhook uses (a later genuine webhook is a harmless no-op). The decision is made server-side from
  PayPal's own API answer; the browser only triggers the check and can never claim "I'm a member".
  Other statuses get honest pages (APPROVAL_PENDING → "finish the Agree & Approve step"; CANCELLED →
  status page; API error → 502 with the PayPal message).
- **Webhook stays armed and unchanged** (verification, dedupe, state machine, logs): it remains the
  source of truth for **revocation** (SUSPENDED/CANCELLED) and the canonical grant path in
  production. Nothing was deleted — per the user, it's kept for later.
- **New code:** `paypal-subscriptions.js` + `getSubscription(id)` (read current status) and
  `activateMembershipFromApi(db, {userId, subscriptionId})`; `server.js` imports both, `/paypal-return`
  rewritten as above, temp `/debug-cert` diagnostic route (2659638) removed — job done.
- **Verified (real sandbox, live server):** 18/18 offline tests pass; smoke test — fresh APPROVAL_PENDING
  sub → "approval pending" page OK; real CANCELLED sub → status page OK; bad id → 502 OK; **real ACTIVE
  sub → "You are now a member! ⭐", member=1, membership_status=active, member_since set, repeat hit
  idempotent, dashboard shows the member panel and the join panel is gone**. Test users/subs cleaned up.
- **State:** the user's live sub `I‑GNWPG3H62NH5` is CANCELLED (7b cleanup); local E2E orphans
  `I‑KEUYMSP01XKP` / `I‑H24MEVGJS5RU` / `I‑VMF97A5ET617` are ACTIVE under local plan
  `P‑95F48615BW1409454NKZDAOI` (harmless sandbox clutter; the user's next join creates a fresh sub
  after the deploy wipes the DB and `ensurePlan` self-heals).
- **If the webhook mystery is ever resumed:** the mismatch dump (e194d07) captures tid/time/wid+
  len/algo/bodylen/bodyhash/siglen/certfp + the full signature — compare against the PayPal
  dashboard's event payload to find the one input that differs.

---

## 7d. A2 hotfix #4 — 2026‑09‑22 (cancel button was a no-op: wrong API call)

User got Member ⭐ (the 7c grant path works live), but the **Cancel membership** button returned
`Couldn't cancel on PayPal's side — cancel failed: HTTP 404`. That is a real bug (a charged
subscription that can't be cancelled), and it was confirmed:

- **Root cause:** `cancelSubscription` used `DELETE /v1/billing/subscriptions/{id}`. Verified
  against the live sandbox: that returns **404 and does NOT cancel** — the sub stays **ACTIVE**
  (still billing). The correct call is **`POST /v1/billing/subscriptions/{id}/cancel`**, which
  returns **204** and sets the sub to **CANCELLED** (proven: `I‑H24MEVGJS5RU` ACTIVE→CANCELLED).
  It also needs `Content-Type: application/json` (a bare POST is 415 UNSUPPORTED_MEDIA_TYPE).
- **Fix (this commit):**
  1. `cancelSubscription` → `POST …/cancel` + JSON content-type (was `DELETE`, the 404 no-op).
  2. New `cancelMembershipFromApi` (symmetric to `activateMembershipFromApi`): the cancel route now
     flips membership **off locally** through the same idempotent `applyMembershipEvent` instead of
     waiting for the (unreliable) CANCELLED webhook — so a successful cancel turns the user off
     immediately and the dashboard returns to the free/join state.
  3. Cancel route UX: success page now says "membership is now off, you won't be charged again";
     the failure page now says **membership is still on**, shows the PayPal error, and points to
     cancelling from the PayPal account as a fallback. Both paths log `[A2] cancel …`.
- **Verified (live sandbox):** 18/18 offline tests pass; end-to-end smoke — real ACTIVE sub
  `I‑VMF97A5ET617` → cancel route → **sub CANCELLED on PayPal + member=0/cancelled locally +
  dashboard back to join panel**; error branch (bogus id) → 502 with "still on" and membership
  correctly stays ON. Test user cleaned up.
- **Live state:** the user's live subscription is **still ACTIVE and charging** (the 7c grant
  created it; the broken cancel never cancelled it). After this deploy, the user clicks
  **Cancel membership** once and it will genuinely cancel + turn off. (Or cancel from their PayPal
  sandbox account — the next check will reflect it.)
- **Env note:** `git` push on this box now uses `http.sslBackend=openssl` (set in repo config) —
  the default schannel backend fails here with `SEC_E_NO_CREDENTIALS`.

---

## 7e. Skill written — 2026‑09‑22 (the PayPal runbook is now `paypal-skill.md`)

- **`paypal-skill.md` created** (this workspace): the one‑shot, battle‑tested runbook for the
  recurring‑membership PayPal integration. It encodes the exact API contract (§3), the webhook
  verification algorithm (§4), the route map (§5), **all 15 roadblocks and their fixes** (§6), and
  the verification checklist (§7) — fronted by the two decisions that made it work: **grant via the
  return‑route API check** (not the webhook) and **cancel via `POST …/cancel`** (not `DELETE`).
  Includes the three doc links to start from.
- **`skill-site-creation.md` Step 6** now carries a "superseded — use `paypal-skill.md`" banner so a
  future agent doesn't re‑follow the buggy one‑shot payment approach.
- **User's live subscription cancelled** (the 7c grant created it; the 7d broken cancel never
  cancelled it): `I‑CS2AUE16213G` confirmed as theirs (`custom_id "1"`, buyer
  `sb‑o5euf52980154@personal.example.com`, started 22:42:36Z), then `POST …/cancel` → **204 →
  CANCELLED**. No orphaned charging sub remains. Sandbox is clean.
- **State:** gqsa‑Site A2 is complete and verified (grant + cancel both work end‑to‑end); the skill
  captures it for reuse. Section 8 (main‑Site handoff) remains deferred — do NOT start it.

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
