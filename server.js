// Your backend server with registration, login, and dashboard!
import express from 'express';
import session from 'express-session';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs'; // the bcrypt algorithm in pure JS (same hashes, no native build)
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'; // A3: the "file" email transport (outbox); B2.2: existsSync for the admin-frontend dist check; B2.4: mkdirSync for upload dirs
import multer from 'multer'; // B2.4: multipart uploads for the admin editors
// A1 (env-only secrets): load .env BEFORE paypal-config.js, because ES modules
// run in import order and paypal-config reads process.env the moment it loads.
import './loadEnv.js';
// PayPal config (A1: credentials come from .env; A2: subscription settings).
import {
  PAYPAL_CLIENT_ID,
  PAYPAL_WEBHOOK_ID,
  SUBSCRIPTION_PRICE,
  SUBSCRIPTION_CURRENCY,
} from './paypal-config.js';
// A2: the recurring-billing engine — product/plan provisioning, creating and
// cancelling subscriptions, webhook signature verification, and the
// membership state machine. (It keeps the Step-9 lesson: never trust the
// browser to say "I paid" — here, the browser never even gets to say it.)
import {
  createSubscription,
  cancelSubscription,
  processPaypalWebhook,
  reprocessPendingWebhooks,
  getSubscription,
  activateMembershipFromApi,
  cancelMembershipFromApi,
} from './paypal-subscriptions.js';

import path from 'node:path';
import { spawnSync } from 'node:child_process'; // B2.2: boot-time SPA build (Render's build step is a bare `npm install`)
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// B0 (EJS): server-rendered templates. Pages live in ./views; every page is an
// EJS template that includes views/partials/head.ejs + footer.ejs for the shared
// shell. res.locals (e.g. the CSRF token set by the middleware above) is exposed
// to templates, so forms can embed <%- csrfToken %> directly.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Parse form data sent via POST requests
app.use(express.urlencoded({ extended: true }));

// Session middleware - remembers who is logged in
// Uses a secret string to sign the session cookie (keep it safe!)
//
// A1 (env-only secrets): the secret now COMES FROM THE ENVIRONMENT, not from a
// fallback string in the code. A hardcoded secret is a known secret: it lives
// in the repo, in git history, readable by anyone who can read the source.
//   - Production: if SESSION_SECRET is missing, we CRASH (fail fast).
//     A broken secret is far worse than a broken server — with a known secret,
//     anyone can forge "logged in as you" cookies.
//   - Local dev: a weak fallback is tolerated (with a loud warning), because
//     a dev machine has no real sessions worth forging.
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error(
    'Refusing to start: SESSION_SECRET is not set. ' +
    'Set it as an environment variable (see .env.example). ' +
    'A hardcoded session secret in production is a security hole.'
  );
}
if (!isProduction && !process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET not set — using a dev-only fallback. Fine locally, never in production.');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-fallback-do-not-use-in-production',
  resave: false,
  saveUninitialized: false
}));

// A1 (CSRF protection): Cross-Site Request Forgery.
// THE THREAT: your browser automatically attaches your session cookie to
// requests to THIS site — even when a DIFFERENT website you're visiting makes
// them. An attacker's page could silently POST to /join-membership or
// /save-progress and your browser would "cooperate".
// THE FIX: each session gets a random token (below). Every form we render
// embeds it in a hidden field; every fetch() sends it as a header. The server
// REJECTS any POST that doesn't carry this session's token. A cross-site page
// can't copy the token — browsers block one site from reading another's data.
function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    // 32 random bytes = 64 hex chars — computationally impossible to guess.
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

app.use((req, res, next) => {
  // Attach the token to res.locals so any server-rendered page can embed it:
  //   <input type="hidden" name="csrf" value="${res.locals.csrfToken}">
  res.locals.csrfToken = getCsrfToken(req);

  // A2: PayPal's webhook is a SERVER-TO-SERVER call — it can't carry our
  // browser's CSRF token (it has no browser, no session cookie). Its
  // authenticity comes from the RSA signature the /paypal-webhook route
  // verifies (see paypal-subscriptions.js), so we exempt exactly that path.
  if (req.path === '/paypal-webhook') return next();

  if (req.method !== 'POST') return next(); // only state-changing requests get checked

  // Accept the token from a form field ("csrf") or an X-CSRF-Token header
  // (used by the dashboard's fetch() call to /save-progress).
  const sent = String(req.body?.csrf ?? req.headers['x-csrf-token'] ?? '');
  const expected = getCsrfToken(req);
  // timingSafeEqual: compares without revealing HOW FAR the two strings match
  // (a plain === could leak that "the first 20 chars were right" via timing).
  const sentBuf = Buffer.from(sent);
  const expectedBuf = Buffer.from(expected);
  const valid = sentBuf.length === expectedBuf.length && timingSafeEqual(sentBuf, expectedBuf);

  if (!valid) {
    return res.status(403).render('message', {
      title: 'Request blocked', heading: '403 — request blocked',
      body: 'Missing or invalid anti-forgery token (CSRF check failed).',
      linkText: 'Back to home', linkHref: '/', tone: 'error',
    });
  }
  next();
});

// Serve static files (HTML, CSS, JS) from the "public" folder
app.use(express.static('public'));

// Open our database (creates the file if it doesn't exist)
const db = new DatabaseSync('database.db');

// Auto-create tables if they don't exist yet.
// This runs every time the server starts, but IF NOT EXISTS makes it safe to run repeatedly.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    member INTEGER DEFAULT 0
  );

  -- B2: the implementation roadmap — the single source of truth for "what's
  -- built". (The old per-reader "learning progress" checklist is RETIRED: it
  -- was a learning aid, but this is now a real product, so we track the BUILD
  -- itself, in the admin area, not per reader.)
  CREATE TABLE IF NOT EXISTS roadmap (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase TEXT NOT NULL,             -- 'A' | 'B' | 'C'
    step TEXT NOT NULL,              -- e.g. "A1", "B2.5", "C1"
    label TEXT NOT NULL,             -- human-readable description
    done INTEGER DEFAULT 0,          -- 0 = pending, 1 = done
    sort_order INTEGER DEFAULT 0     -- display order
  );
`);

// A2: recurring membership — new columns on users + two new tables.
//
// Why four new user columns? The old model was a single bit: member=0/1.
// A recurring subscription has a LIFECYCLE, and we want to show it honestly:
//   member               — the EFFECTIVE access flag (1/0). All content gating
//                          keeps using this, so nothing else changes.
//   membership_status    — free | active | suspended | cancelled. 'suspended'
//                          means "a payment failed, PayPal paused billing";
//                          'cancelled' means "the sub was cancelled".
//   paypal_subscription_id — the PayPal sub id; the webhook events carry it,
//                          so this is how we map an event back to a user.
//   member_since         — when they FIRST became a member (nice to show).
//
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we ask the schema first
// (PRAGMA table_info lists the current columns) and only add what's missing.
const userCols = db.prepare('PRAGMA table_info(users)').all().map(r => r.name);
const A2_COLUMNS = [
  ['email', 'TEXT'],
  ['paypal_subscription_id', 'TEXT'],
  ["membership_status", "TEXT DEFAULT 'free'"],
  ['member_since', 'INTEGER'],
];
for (const [col, ddl] of A2_COLUMNS) {
  if (!userCols.includes(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${ddl}`);
    console.log(`[A2] added users.${col} column`);
  }
}

// ============================================================
// A3: ACCOUNTS & EMAIL — one email pathway for everything
// ============================================================
// The email is part of the ACCOUNT from day one (not an optional extra):
// registration collects it, /settings edits it, and it's where member
// announcements ("a new story is out!") and password-reset links arrive.
// "No optional email" is the END state; until we have a real sending domain
// (C1 era) a SWITCH decides how much is enforced:
//   EMAIL_REQUIRED=false (default for now) — the field is shown + collected,
//       but a blank email still registers.
//   EMAIL_REQUIRED=true — registration REQUIRES a valid email.
// Flipping the env var IS the migration (see .env.example + progress.md A3).
//
// THE ONE PATHWAY: every email the site sends — resets, member blasts,
// receipts — goes through sendEmail(). The TRANSPORT is a switch too:
//   console (default) — log the envelope to the server output. Zero setup.
//   file              — append to a JSON outbox (EMAIL_FILE_PATH), so you can
//       open the file and read the actual email (and the test suite can pull
//       the reset link out of it).
//   (C1 era)          — a real provider (Resend/SMTP) once we have a domain:
//       add a branch here, nothing else changes.

// A3: the opt-out flag — the "turn email notifications off" switch. Default
// ON; NULL/missing counts as ON, so every pre-A3 account is still notified.
const a3UserCols = db.prepare('PRAGMA table_info(users)').all().map(r => r.name);
if (!a3UserCols.includes('email_notifications')) {
  db.exec('ALTER TABLE users ADD COLUMN email_notifications INTEGER DEFAULT 1');
  console.log('[A3] added users.email_notifications column (default ON)');
}

// A3: password-reset tokens. We store the SHA-256 of the link token, never
// the raw token — if the DB leaks, the live links can't be read out of it.
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,        -- sha256(token) — the raw token never touches the DB
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );
`);

// A3: the switches (env-tunable, see .env.example).
const EMAIL_REQUIRED = (process.env.EMAIL_REQUIRED || 'false').toLowerCase() === 'true';
const EMAIL_TRANSPORT = (process.env.EMAIL_TRANSPORT || 'console').toLowerCase(); // console | file | (provider later)
const EMAIL_FILE_PATH = process.env.EMAIL_FILE_PATH || '.mailoutbox.json';
const EMAIL_FROM = process.env.EMAIL_FROM || 'gqsa <hello@gqsa.site>';
const APP_BASE_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL_MS = 30 * 60 * 1000; // a reset link lives 30 minutes

// THE ONE PATHWAY (see section header). Returns an envelope-shaped summary.
function sendEmail({ to, subject, html }) {
  const envelope = { from: EMAIL_FROM, to, subject, html, sent_at: Date.now(), transport: EMAIL_TRANSPORT };
  if (EMAIL_TRANSPORT === 'file') {
    let box = [];
    try { box = JSON.parse(readFileSync(EMAIL_FILE_PATH, 'utf8')); } catch { box = []; }
    box.push(envelope);
    writeFileSync(EMAIL_FILE_PATH, JSON.stringify(box, null, 2));
    console.log(`[A3 email] (file) to=${to} subject="${subject}" — outbox ${EMAIL_FILE_PATH}`);
  } else {
    console.log(`[A3 email] (console) to=${to} subject="${subject}"\n${html}`);
  }
  return { to, subject, transport: EMAIL_TRANSPORT };
}

// A3: member blast — "a new story is out!". Sends to every user who has an
// email AND hasn't opted out (email_notifications !== 0). Returns the counts
// so the admin page + tests can prove exactly who got it.
function notifyMembers(subject, html) {
  const eligible = db.prepare(
    "SELECT email FROM users WHERE email IS NOT NULL AND email <> '' AND (email_notifications IS NULL OR email_notifications = 1)"
  ).all();
  const optedOut = db.prepare(
    "SELECT COUNT(*) c FROM users WHERE email IS NOT NULL AND email <> '' AND email_notifications = 0"
  ).get().c;
  const noEmail = db.prepare("SELECT COUNT(*) c FROM users WHERE email IS NULL OR email = ''").get().c;
  for (const r of eligible) sendEmail({ to: r.email, subject, html });
  console.log(`[A3 blast] "${subject}" -> sent=${eligible.length} optedOut=${optedOut} noEmail=${noEmail}`);
  return { sent: eligible.length, optedOut, noEmail };
}

// A3: reset-token helpers (raw token in the link, only its hash in the DB).
function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}
function findValidToken(token) {
  if (!token) return null;
  const row = db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0'
  ).get(hashToken(token));
  if (!row) return null;
  if (Date.now() > row.expires_at) return null; // expired
  return row;
}

db.exec(`
  -- Every webhook event PayPal delivers, remembered once. The UNIQUE
  -- event_id is our IDEMPOTENCY guard: PayPal retries until we answer 2xx,
  -- so the same event can arrive several times — and we must apply it once.
  CREATE TABLE IF NOT EXISTS paypal_webhook_events (
    event_id TEXT PRIMARY KEY,      -- PayPal's id for THIS notification
    event_type TEXT,                -- e.g. BILLING.SUBSCRIPTION.ACTIVATED
    payload TEXT,                   -- the full raw JSON (replay + debugging)
    received_at INTEGER,            -- epoch ms
    status TEXT DEFAULT 'received', -- received -> processed (crash recovery)
    note TEXT                       -- what applyMembershipEvent did with it
  );

  -- Key/value store for PayPal-side ids WE create (product, plan), so a
  -- server restart never creates a second product or plan.
  CREATE TABLE IF NOT EXISTS paypal_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// A2: users who joined in the one-time era (member=1) keep their access —
// just translate their state into the new vocabulary.
db.prepare("UPDATE users SET membership_status = 'active' WHERE member = 1 AND (membership_status IS NULL OR membership_status = 'free')").run();

// A2 CRASH RECOVERY: if we received a webhook event but died before finishing
// (or threw), its row is still 'received'/'failed'. Re-apply it now — safe,
// because applying an event is idempotent (same event, same result).
const reprocessed = reprocessPendingWebhooks(db);
if (reprocessed) console.log(`[A2] startup: reprocessed ${reprocessed} pending webhook event(s)`);
if (PAYPAL_WEBHOOK_ID.startsWith('PASTE_')) {
  console.warn('[A2] WARNING: PAYPAL_WEBHOOK_ID not set — /paypal-webhook will REJECT every event until you paste the webhook id from the PayPal dashboard (Webhooks tab).');
}
if (PAYPAL_CLIENT_ID.startsWith('PASTE_')) {
  console.warn('[A2] PayPal credentials not set — the join flow will show "not set up yet" until you add them to .env.');
}

// ============================================================
// B1: CONTENT DATABASE
// ============================================================
// The whole point of the gqsa site: host COMICS (images, multi-page) and
// STORIES (text), plus single images and videos, with member-only gating.
//
// The model has two layers:
//   1. A "work" — a story, a comic, an image, a video — one row each, each with
//      title / description / publish date / free-vs-member / tier.
//   2. A comic is special: it has PAGES in reading order, so it gets a child
//      table (comic_pages). A story's "pages" are just its body text, so it
//      doesn't need a child table.
//
// Gating (enforced in B4): is_member=0 → free (everyone). is_member=1 → members
// only (any paying member). tier_id → which tier it belongs to. For now there's
// ONE tier; the schema already supports many, so admin-created tiers (A4) work
// later with no schema change.
//
// Everything here is idempotent: CREATE TABLE IF NOT EXISTS + a seed that only
// runs while a table is empty, so a restart never duplicates anything.

db.exec(`
  -- The membership tiers. price is in CENTS (500 = $5.00) so we never do
  -- floating-point money math in the DB. The real billing price lives on
  -- PayPal's side (A2); this is the name/perks we SHOW readers.
  CREATE TABLE IF NOT EXISTS tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,              -- e.g. "Patron"
    price INTEGER NOT NULL,                 -- cents
    currency TEXT NOT NULL DEFAULT 'USD',
    perks TEXT,                             -- human-readable perk list
    active INTEGER DEFAULT 1,               -- is this tier being offered?
    created_at INTEGER
  );

  -- Stories: prose. body is the full text; description is the short blurb
  -- shown in lists.
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,                       -- blurb for lists
    body TEXT NOT NULL,                     -- the full prose
    publish_date INTEGER,                   -- epoch ms (when it went live)
    is_member INTEGER DEFAULT 0,            -- 0 = free, 1 = members-only
    tier_id INTEGER REFERENCES tiers(id),
    created_at INTEGER,
    updated_at INTEGER
  );

  -- Comics: the "work" row. Its pages live in comic_pages (below).
  CREATE TABLE IF NOT EXISTS comics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    publish_date INTEGER,
    is_member INTEGER DEFAULT 0,
    tier_id INTEGER REFERENCES tiers(id),
    created_at INTEGER,
    updated_at INTEGER
  );

  -- A comic's pages, in reading order. This is the PARENT/CHILD relationship:
  -- one comic → many pages. ON DELETE CASCADE: delete the comic, its pages go
  -- too (no orphaned page rows). UNIQUE (comic_id, page_number): a comic can't
  -- have two "page 1"s.
  CREATE TABLE IF NOT EXISTS comic_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    file_path TEXT NOT NULL,                -- where the image file lives
    UNIQUE (comic_id, page_number)
  );

  -- Single images (art, not part of a comic).
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    caption TEXT,
    file_path TEXT NOT NULL,
    publish_date INTEGER,
    is_member INTEGER DEFAULT 0,
    tier_id INTEGER REFERENCES tiers(id),
    created_at INTEGER
  );

  -- Videos.
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    publish_date INTEGER,
    is_member INTEGER DEFAULT 0,
    tier_id INTEGER REFERENCES tiers(id),
    created_at INTEGER
  );
`);

// B2.4: the editors need per-page and per-video captions (Step 2) and, to
// mirror the stories/comics pattern, updated_at on images + videos (Step 6 —
// B1's schema omitted it on those two). node:sqlite's ALTER TABLE ADD COLUMN
// has no IF NOT EXISTS, so we guard with PRAGMA table_info — a no-op on any DB
// that already has the column, idempotent across fresh + restarted boots.
// (images already had caption from B1.) Each migration carries its declared
// TYPE: captions are TEXT, updated_at is INTEGER — the same type as the
// stories/comics columns, so a value stored through the editors round-trips as
// a number on all four tables (SQLite's TEXT affinity would have coerced the
// epoch-ms into a string on store).
for (const [table, col, type] of [
  ['comic_pages', 'caption', 'TEXT'], ['videos', 'caption', 'TEXT'],
  ['images', 'updated_at', 'INTEGER'], ['videos', 'updated_at', 'INTEGER']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// B1 seed: one tier + a little sample content, ONLY while a table is empty
// (so a restart never duplicates it). Real content arrives via the admin
// upload routes (B2.4); these rows give the schema something real to hold
// and the editors (B2.5–B2.7) something to work with while they get built.
{
  const now = Date.now();
  const tierId = db.prepare('SELECT id FROM tiers ORDER BY id LIMIT 1').get();

  if (!tierId) {
    db.prepare('INSERT INTO tiers (name, price, currency, perks, active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Patron', 500, 'USD', 'All exclusive comics + stories', 1, now);
    console.log('[B1] seeded tier: Patron ($5/mo)');
  }

  const t = db.prepare('SELECT id FROM tiers ORDER BY id LIMIT 1').get().id;

  if (db.prepare('SELECT COUNT(*) c FROM stories').get().c === 0) {
    const ins = db.prepare('INSERT INTO stories (title, description, body, publish_date, is_member, tier_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(
      'The Last Lighthouse',
      'A free sample — the night the sea went wrong.',
      'The light at Vael\'s Point had been dead for thirty years, but on the night the tide went wrong, Mara climbed the stairs anyway. She carried no lamp. She carried the reason.\n\nDown in the village they told her the sea had swallowed the lighthouse whole, that the keeper had simply stopped. But Mara had kept his last letter for a decade — the one that said: when you are ready, the light will know you. And tonight, with the water black and the wind holding its breath, she set the match to the wick and waited for the glass to remember how to burn.',
      now, 0, null, now, now
    );
    ins.run(
      'Ember & Ash',
      'Members-only. A promise kept in a room full of ash.',
      'They told the city it was a fire — a gas line, an accident with a number and a date. What it was, was a promise kept.\n\nKestrel had been the only one who knew the vault under the old theatre, the only one who held the key that was also a tooth. When the sirens came for the rest of them, she was already inside, turning the lock the way her mother had taught her: twice left, once right, and a knock. The door opened onto a room full of ash and one small, impossible light. She closed the door behind her. The city would burn its stories and call them news. But the key was safe, and the light was hers, and that was the whole of it.',
      now, 1, t, now, now
    );
    console.log('[B1] seeded 2 sample stories (1 free, 1 member)');
  }

  if (db.prepare('SELECT COUNT(*) c FROM comics').get().c === 0) {
    const insC = db.prepare('INSERT INTO comics (title, description, publish_date, is_member, tier_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insP = db.prepare('INSERT INTO comic_pages (comic_id, page_number, file_path) VALUES (?, ?, ?)');
    const free = insC.run('Paper Moons', 'A 3-page free sample comic.', now, 0, null, now, now).lastInsertRowid;
    for (let p = 1; p <= 3; p++) insP.run(free, p, `/uploads/comics/${free}/${p}.png`);
    const mem = insC.run('Hollow Signal', 'Members-only comic (2 pages).', now, 1, t, now, now).lastInsertRowid;
    for (let p = 1; p <= 2; p++) insP.run(mem, p, `/uploads/comics/${mem}/${p}.png`);
    console.log('[B1] seeded 2 sample comics (free 3p, member 2p)');
  }

  if (db.prepare('SELECT COUNT(*) c FROM images').get().c === 0) {
    db.prepare('INSERT INTO images (title, caption, file_path, publish_date, is_member, tier_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Cover art — Paper Moons', 'The free sample cover.', '/uploads/images/paper-moons-cover.png', now, 0, null, now);
    console.log('[B1] seeded 1 sample image');
  }

  if (db.prepare('SELECT COUNT(*) c FROM videos').get().c === 0) {
    db.prepare('INSERT INTO videos (title, description, file_path, publish_date, is_member, tier_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Behind the ink', 'How a page gets drawn.', '/uploads/videos/behind-the-ink.mp4', now, 0, null, now);
    console.log('[B1] seeded 1 sample video');
  }
}

// B2 seed: the implementation roadmap (only while empty — idempotent). The done
// flags reflect the build state: A1/A2/A3/A5 + B0/B1/B2 + B2.1–B2.4 are done,
// the rest pending.
// B2.2: the B2.x sub-steps (the React admin build) are seeded BETWEEN B2 and
// B4 — a table that predates them gets them from the missing-step pass below.
const B2X_ROWS = [
  ['B2.1', 'Admin area: admin account boot-seed (survives Render wipes)', 1],
  ['B2.2', 'Scaffold admin-frontend (Vite + React) + Express serves it at /admin', 1],
  ['B2.3', 'Tracker (checklist) in React', 1],
  ['B2.4', 'Content JSON API + uploads (multer)', 1],
  ['B2.5', 'Comic editor in React (upload, reorder, captions, live preview, auto-save)', 1],
  ['B2.6', 'Story editor in React (upload / paste, auto-save)', 0],
  ['B2.7', 'Image / video upload editor in React', 0],
  ['B2.8', 'Editor sections minimisable (each comic / story / media editor section collapses to a header bar)', 0],
  ['B2.9', 'Member announcements in React + retire the EJS admin page', 0],
  ['B2.10', 'Production wiring + Render deploy + runbook', 0],
];
{
  if (db.prepare('SELECT COUNT(*) c FROM roadmap').get().c === 0) {
    const ins = db.prepare('INSERT INTO roadmap (phase, step, label, done, sort_order) VALUES (?, ?, ?, ?, ?)');
    const A = [
      ['A1', 'Security hardening (bcrypt, env secrets, CSRF, login rate-limit)', 1],
      ['A2', 'Recurring payments (PayPal Subscriptions + signed webhooks)', 1],
      ['A3', 'Accounts & email (signup email + switch, opt-out, change/reset, member announcements)', 1],
      ['A4', 'Admin panel (tiers + payments; the member list itself = B10)', 0],
      ['A5', 'Frontend approach (EJS) — decided + adopted', 1],
    ];
    const B = [
      ['B0', 'Scaffold the project + adopt EJS', 1],
      ['B1', 'Content database (stories / comics + pages / images / videos + tiers)', 1],
      ['B2', 'Admin area + implementation tracker', 1],
      ...B2X_ROWS, // B2.1–B2.10 sit between B2 and B4 (the old B3/B5 rows merged into B2.5/B2.6)
      ['B4', 'Comic editor — marquee / crop selection', 0],
      ['B6', 'Story import (archive doc links → stories; + single-doc link → story body + images)', 0],
      ['B7', 'Story tier-gating (inline highlight → per-tier blur + red border)', 0],
      ['B8', 'Public display pages + member gating + copy-prevention', 0],
      ['B9', 'Storage for real members (deferred)', 0],
      ['B10', 'Audience page (member list: active / free / cancelled + terminate membership)', 0],
    ];
    const C = [
      ['C1', 'Deploy to Hostinger / domain (deferred)', 0],
    ];
    let order = 0;
    for (const [step, label, done] of A) ins.run('A', step, label, done, order++);
    for (const [step, label, done] of B) ins.run('B', step, label, done, order++);
    for (const [step, label, done] of C) ins.run('C', step, label, done, order++);
    console.log(`[B2] seeded implementation roadmap (${order} items)`);
  }
  // A3: bring EXISTING roadmap tables up to date — the seed above only runs
  // while the table is empty, so a database that predates A3 gets: (a) the
  // refreshed A3 label + done flag (A3 is the build state as of this commit),
  // (b) the re-scoped A4 label (the member list itself is now B10), and
  // (c) the new B10 row. Each step is a no-op once applied (idempotent).
  const A3_LABEL = 'Accounts & email (signup email + switch, opt-out, change/reset, member announcements)';
  const A4_LABEL = 'Admin panel (tiers + payments; the member list itself = B10)';
  const B10_LABEL = 'Audience page (member list: active / free / cancelled + terminate membership)';
  const a3Row = db.prepare("SELECT label, done FROM roadmap WHERE phase = 'A' AND step = 'A3'").get();
  if (a3Row && (a3Row.label !== A3_LABEL || !a3Row.done)) {
    db.prepare("UPDATE roadmap SET label = ?, done = 1 WHERE phase = 'A' AND step = 'A3'").run(A3_LABEL);
    console.log('[A3] refreshed roadmap A3 row (label + done)');
  }
  const a4Row = db.prepare("SELECT label FROM roadmap WHERE phase = 'A' AND step = 'A4'").get();
  if (a4Row && a4Row.label !== A4_LABEL) {
    db.prepare("UPDATE roadmap SET label = ? WHERE phase = 'A' AND step = 'A4'").run(A4_LABEL);
    console.log('[A3] refreshed roadmap A4 row (label)');
  }
  if (!db.prepare("SELECT 1 FROM roadmap WHERE phase = 'B' AND step = 'B10'").get()) {
    const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS m FROM roadmap').get().m;
    db.prepare("INSERT INTO roadmap (phase, step, label, done, sort_order) VALUES ('B', 'B10', ?, 0, ?)")
      .run(B10_LABEL, nextOrder);
    console.log('[A3] added roadmap B10 row');
  }
  // B2.2: add the B2.x sub-steps to tables seeded before them (the "missing-step"
  // pattern — the seed above only runs while the table is empty). The rows go
  // BETWEEN B2 and B4: everything after B2 shifts down by the number of rows
  // added. No-op once every B2.x row exists (idempotent across restarts).
  {
    // NOTE: SQLite LIKE has no backslash escape — 'B2.%' is "B2." + any tail
    // (a backslash would be a literal char and match nothing).
    const existing = new Set(
      db.prepare("SELECT step FROM roadmap WHERE phase = 'B' AND step LIKE 'B2.%'").all().map(r => r.step)
    );
    const missing = B2X_ROWS.filter(([step]) => !existing.has(step));
    if (missing.length) {
      const b2 = db.prepare("SELECT sort_order FROM roadmap WHERE phase = 'B' AND step = 'B2'").get();
      if (b2) {
        db.prepare('UPDATE roadmap SET sort_order = sort_order + ? WHERE sort_order > ?')
          .run(missing.length, b2.sort_order);
        let order = b2.sort_order + 1;
        const ins = db.prepare('INSERT INTO roadmap (phase, step, label, done, sort_order) VALUES (?,?,?,?,?)');
        for (const [step, label, done] of B2X_ROWS) {
          if (!existing.has(step)) ins.run('B', step, label, done, order++);
        }
        console.log(`[B2.2] added roadmap B2.x rows (${missing.length})`);
      }
    }
  }
  // B-step cleanup (2026-09-24): the old B3/B5 rows were merged into B2.5/B2.6
  // (the editors are the React admin's B2.5–B2.7 — see progress.md). Existing
  // tables still carry the redundant B3/B5 checkboxes — drop them. And B2.3 is
  // DONE (the React tracker is live): the seed above marks it done for fresh
  // tables; this flips it for tables seeded before that fix. No-ops once
  // applied (idempotent).
  const dropped = db.prepare("DELETE FROM roadmap WHERE phase = 'B' AND step IN ('B3', 'B5')").run();
  if (dropped.changes) console.log(`[cleanup] dropped merged roadmap rows B3/B5 (${dropped.changes})`);
  const b23 = db.prepare("SELECT done FROM roadmap WHERE phase = 'B' AND step = 'B2.3'").get();
  if (b23 && !b23.done) {
    db.prepare("UPDATE roadmap SET done = 1 WHERE phase = 'B' AND step = 'B2.3'").run();
    console.log('[cleanup] marked roadmap B2.3 done');
  }
  // B6 grew to include the single-doc case (absorbed from old B5) — refresh the
  // label on tables seeded with the short version (same pattern as the A3/A4
  // label refreshes above).
  const B6_LABEL = 'Story import (archive doc links → stories; + single-doc link → story body + images)';
  const b6 = db.prepare("SELECT label FROM roadmap WHERE phase = 'B' AND step = 'B6'").get();
  if (b6 && b6.label !== B6_LABEL) {
    db.prepare("UPDATE roadmap SET label = ? WHERE phase = 'B' AND step = 'B6'").run(B6_LABEL);
    console.log('[cleanup] refreshed roadmap B6 label (single-doc import added)');
  }
  // B2.8 re-scoped (2026-09-27): the old "Multi-editor + minimise-all" step is
  // SUPERSEDED — each editor already has a dropdown of the created comics/stories/
  // media + auto-save, so a WIP is just another entry in that dropdown; parallel
  // editor instances add nothing. Its minimise intent lives on as the new B2.8
  // (editor sections minimisable, formerly B14). Refresh the label on tables
  // seeded with the old scope (same pattern as the B6 label refresh above) —
  // no-ops once applied (idempotent), so no phantom open item stays in the tracker.
  const B28_LABEL = 'Editor sections minimisable (each comic / story / media editor section collapses to a header bar)';
  const b28 = db.prepare("SELECT label FROM roadmap WHERE phase = 'B' AND step = 'B2.8'").get();
  if (b28 && b28.label !== B28_LABEL) {
    db.prepare("UPDATE roadmap SET label = ? WHERE phase = 'B' AND step = 'B2.8'").run(B28_LABEL);
    console.log('[cleanup] refreshed roadmap B2.8 label (re-scoped: multi-editor superseded → sections minimisable)');
  }
  // Retire the old per-reader "learning progress" table (no longer used).
  db.exec('DROP TABLE IF EXISTS progress;');
}

// Helper function to hash passwords — A1: now bcrypt, not SHA-256.
// WHY bcrypt and not SHA-256?
//   SHA-256 is designed to be FAST — a GPU can compute a BILLION of them per
//   second. If the database leaks, a thief just runs 10 billion common
//   passwords through SHA-256 and sees which one matches your stored hash.
//   bcrypt is deliberately SLOW. The cost factor (10 here) means each hash
//   takes ~2^10 = 1024x more work. For us that's ~0.1s once per registration —
//   irrelevant. For a thief making a billion guesses — the difference between
//   "a weekend" and "a thousand years".
//   Bonus: bcrypt auto-generates a random SALT per password, so two users
//   with the same password store different hashes (a dictionary of hashes
//   becomes useless).
// RULE TO REMEMBER: SHA-256 = fast checksums (file integrity). bcrypt = slow
// password hashing.
const BCRYPT_COST = 10;
function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST); // async — call with await
}

// B2.1: the admin ACCOUNT itself must survive Render's free-tier disk wipes
// (C3). Env vars persist across redeploys; database.db does not. So at boot,
// if ADMIN_USERNAME names an account that doesn't exist yet, create it with
// ADMIN_PASSWORD (bcrypt-hashed, exactly like registration). That's what keeps
// the owner able to log in as admin after every wipe.
// Rules:
//   - An EXISTING account is never touched — the seed only fills a missing
//     account, so a locally-changed password always wins.
//   - ADMIN_USERNAME set but ADMIN_PASSWORD missing (and no account) means
//     nobody can log in as admin → warn loudly at boot instead of failing
//     silently (the admin area 403s for everyone, which looks like a bug).
if (process.env.ADMIN_USERNAME) {
  const adminRow = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME);
  if (adminRow) {
    // Account exists (local machine, or pre-wipe state) — leave it alone.
  } else if (process.env.ADMIN_PASSWORD) {
    await db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
      .run(process.env.ADMIN_USERNAME, await hashPassword(process.env.ADMIN_PASSWORD));
    console.log(`[B2.1] created admin account "${process.env.ADMIN_USERNAME}" from env (fresh disk)`);
  } else {
    console.warn(`[B2.1] WARNING: ADMIN_USERNAME="${process.env.ADMIN_USERNAME}" is set but the account does not exist AND ADMIN_PASSWORD is not set — the admin area is unreachable. Set ADMIN_PASSWORD in the environment (see .env.example).`);
  }
}

// Home page — B0: now an EJS template (views/home.ejs). The old member /
// non-member variants collapse into one template via the `isMember` local.
app.get('/', (req, res) => {
  res.render('home', { isMember: !!req.session.userId });
});

// Show registration form (GET request)
// A1: server-rendered now (see /login above) — the form must embed this
// session's hidden CSRF token, which only the server can know.
app.get('/register', (req, res) => {
  res.render('register', { emailRequired: EMAIL_REQUIRED });
});

// Handle registration form submission (POST request)
app.post('/register', async (req, res) => {
  const username = req.body.username;
  // A3: email is part of the account from day one (announcements + password
  // resets arrive here). The field is ALWAYS shown + collected; the
  // EMAIL_REQUIRED switch (see the A3 section header) decides whether a blank
  // one is accepted. Invalid emails are rejected either way.
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) {
    return res.render('message', {
      title: 'Email not valid', heading: "That email doesn't look right",
      body: 'Check the address (like name@example.com) and try again.',
      linkText: 'Try again', linkHref: '/register', tone: 'error',
    });
  }
  if (EMAIL_REQUIRED && !email) {
    return res.render('message', {
      title: 'Email needed', heading: 'Almost — an email is required',
      body: 'Add the email where member announcements and password-reset links arrive.',
      linkText: 'Try again', linkHref: '/register', tone: 'error',
    });
  }

  const password = await hashPassword(req.body.password); // Hash before saving! (A1: bcrypt — slow on purpose)

  try {
    // Insert the new user
    const stmt = db.prepare("INSERT INTO users (username, password, email) VALUES (?, ?, ?)");
    const result = stmt.run(username, password, email || null);
    
    // Get the ID of the newly created user
    const userId = result.lastInsertRowid;

    res.render('message', {
      title: 'Success!', heading: 'Registration successful! 🎉',
      body: `Welcome, ${username}!`, linkText: 'Login now', linkHref: '/login', tone: 'success',
    });
  } catch (error) {
    res.render('message', {
      title: 'Error', heading: 'Error',
      body: error.message, linkText: 'Try again', linkHref: '/register', tone: 'error',
    });
  }
});

// A1 (login rate limiting): THE THREAT is brute force — a script trying
// thousands of passwords against one account, every minute, forever.
// THE FIX: keep a short in-memory list of attempt timestamps PER IP address,
// and once there are too many within the window, answer 429
// ("Too Many Requests") and stop processing logins from that IP until the
// oldest attempts fall out of the window.
// CAVEAT (known and accepted): the memory resets when the server restarts,
// and multi-server setups would share one counter per server. For this
// learning app, in-memory is the right-sized tool.
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // ip -> [timestamps]
function loginRateLimiter(req, res, next) {
  const now = Date.now();
  const recent = (loginAttempts.get(req.ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).render('message', {
      title: 'Too Many Requests', heading: 'Too many login attempts',
      body: 'Please wait 15 minutes and try again.', linkText: 'Back to home', linkHref: '/', tone: 'error',
    });
  }
  recent.push(now);
  loginAttempts.set(req.ip, recent);
  next();
}

// Show login form (GET request)
// A1: now SERVER-RENDERED (not a static file). Why? A static file can't know
// THIS session's CSRF token — the token is personal to the visitor, so the
// page must be built by the server to embed it in the hidden form field.
// (This is also the first taste of the EJS direction we decided in O6.)
app.get('/login', (req, res) => {
  res.render('login');
});

// Handle login form submission (POST request)
app.post('/login', loginRateLimiter, async (req, res) => {
  const username = req.body.username;

  // Look up user in database by username
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

  let passwordOk = false;
  if (user) {
    if (user.password.startsWith('$2')) {
      // A1: new-style bcrypt hash — bcrypt.compare() does the heavy lifting
      // (it re-runs the same slow hashing with the stored salt and compares).
      passwordOk = await bcrypt.compare(req.body.password, user.password);
    } else {
      // TRANSITION PATH: accounts created before A1 store a plain SHA-256
      // hash (64 hex chars). Check against that...
      const legacy = Buffer.from(createHash('sha256').update(req.body.password).digest('hex'));
      const stored = Buffer.from(user.password);
      passwordOk = legacy.length === stored.length && timingSafeEqual(legacy, stored);
      // ...and if it worked, quietly UPGRADE the stored hash to bcrypt so the
      // next login is already secure. ("Transparent upgrade" — the user never
      // has to reset their password.)
      if (passwordOk) {
        const upgraded = await bcrypt.hash(req.body.password, BCRYPT_COST);
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(upgraded, user.id);
      }
    }
  }

  if (passwordOk) {
    // Passwords match! Start a session for this user.
    req.session.userId = user.id;
    req.session.username = user.username;
    
    res.render('message', {
      title: 'Login Successful', heading: 'Login successful! 🎉',
      body: `Welcome back, ${user.username}!`, linkText: 'Go to Dashboard', linkHref: '/dashboard', tone: 'success',
    });
  } else {
    // Wrong username or password
    res.render('message', {
      title: 'Login Failed', heading: 'Login failed',
      body: 'Wrong username or password.', linkText: 'Try again', linkHref: '/login', tone: 'error',
    });
  }
});

// ============================================================
// A3: PASSWORD RESET (email-based) — the "I can't get in" path
// ============================================================
// Flow: /forgot-password (username OR email) -> sendEmail() a link
//   /reset-password?token=<64-hex> -> /reset-password (new password) ->
//   token marked used. Only the token's SHA-256 lives in the DB, and the
//   token is single-use + 30-min expiry (RESET_TTL_MS).
// SECURITY: the reset EMAIL is sent through the ONE pathway (sendEmail), so
//   it respects the same console/file transport + opt-out rules as everything
//   else. We look the user up by username OR email so either works.

// A3: the forgot-password form (no session needed).
app.get('/forgot-password', (req, res) => {
  res.render('forgot', {});
});

// A3: handle the "I forgot my password" request.
// NOTE: we always answer the same way whether or not the account exists, so
// this endpoint can't be used to probe which usernames/emails are registered
// (an account-enumeration oracle). The only difference is whether an email
// actually went out.
app.post('/forgot-password', loginRateLimiter, (req, res) => {
  const identifier = String(req.body.username || '').trim();
  if (!identifier) {
    return res.render('forgot', { error: 'Enter your username or email.' });
  }
  // Match on username (exact) OR email (case-insensitive).
  const user = db.prepare(
    "SELECT * FROM users WHERE username = ? OR lower(email) = lower(?) LIMIT 1"
  ).get(identifier, identifier);

  if (user && user.email) {
    const token = randomBytes(32).toString('hex'); // 64 hex chars, unguessable
    const now = Date.now();
    db.prepare(
      'INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(hashToken(token), user.id, now, now + RESET_TTL_MS);

    const link = `${APP_BASE_URL}/reset-password?token=${token}`;
    sendEmail({
      to: user.email,
      subject: 'Reset your gqsa password',
      html:
        `<p>Someone asked to reset the password for <strong>${user.username}</strong>.</p>` +
        `<p><a href="${link}">Click here to choose a new password</a></p>` +
        `<p>If you didn't ask for this, you can ignore this email — your password stays as it is.</p>` +
        `<p style="opacity:0.7">This link expires in 30 minutes and works once.</p>`,
    });
  }

  // Same message either way (no account-enumeration oracle).
  res.render('message', {
    title: 'Check your email', heading: 'If that account exists…',
    body: 'If an account with that username or email has an email on file, a reset link is on its way. Check your inbox (or the server log / outbox file, depending on the transport).',
    linkText: 'Back to login', linkHref: '/login', tone: 'success',
  });
});

// A3: the reset form — reached by clicking the emailed link.
// We validate the token up front so a dead link shows a clear message
// instead of a form that would 400 on submit.
app.get('/reset-password', (req, res) => {
  const token = String(req.query.token || '');
  const row = findValidToken(token);
  if (!row) {
    return res.render('message', {
      title: 'Link expired', heading: 'That reset link is no longer valid',
      body: 'Reset links expire after 30 minutes and work once. Request a fresh one.',
      linkText: 'Request a new link', linkHref: '/forgot-password', tone: 'error',
    });
  }
  res.render('reset', { token });
});

// A3: set the new password and burn the token.
app.post('/reset-password', async (req, res) => {
  const token = String(req.body.token || '');
  const row = findValidToken(token);
  if (!row) {
    return res.render('message', {
      title: 'Link expired', heading: 'That reset link is no longer valid',
      body: 'Reset links expire after 30 minutes and work once. Request a fresh one.',
      linkText: 'Request a new link', linkHref: '/forgot-password', tone: 'error',
    });
  }

  const newPassword = String(req.body.password || '');
  if (newPassword.length < 6) {
    return res.render('reset', { token, error: 'Password must be at least 6 characters.' });
  }
  if (newPassword !== String(req.body.password2 || '')) {
    return res.render('reset', { token, error: 'The two passwords don\'t match.' });
  }

  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id); // single-use

  res.render('message', {
    title: 'Password updated', heading: 'Password updated! 🔒',
    body: 'Your new password is set. Log in with it.',
    linkText: 'Login now', linkHref: '/login', tone: 'success',
  });
});

// Dashboard - only accessible if logged in
app.get('/dashboard', (req, res) => {
  // Check if user is logged in by looking at their session
  if (!req.session.userId) {
    // Not logged in — send them to login page
    return res.render('message', {
      title: 'Please Login', heading: 'Please login first',
      body: '', linkText: 'Go to Login', linkHref: '/login', tone: 'neutral',
    });
  }

  // User is logged in — load fresh membership state + whether THIS account is
  // the admin (for the /admin link), then let views/dashboard.ejs do the
  // conditional rendering. The server DECIDES membership + admin; the template
  // only displays what we hand it.
  const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  const isMember = userRow && userRow.member === 1;
  const membershipStatus = userRow?.membership_status || 'free'; // free | active | suspended | cancelled
  const memberSince = userRow.member_since
    ? ` (since ${new Date(userRow.member_since).toLocaleDateString()})`
    : '';

  res.render('dashboard', {
    username: req.session.username,
    isMember,
    isAdmin: isAdmin(req),
    membershipStatus,
    memberSince,
    billingEmail: userRow.email || '',
    subscriptionPrice: SUBSCRIPTION_PRICE,
    subscriptionCurrency: SUBSCRIPTION_CURRENCY,
  });
});

// ============================================================
// A3: SETTINGS — the account's email + the notification switch + password
// ============================================================
// Membership lives on the dashboard (that's money talk); /settings is
// ACCOUNT talk: where announcements go, whether they go at all, and the
// password itself. Both are plain session pages (login required).

app.get('/settings', (req, res) => {
  if (!req.session.userId) {
    return res.render('message', {
      title: 'Please login', heading: 'Please login first',
      body: '', linkText: 'Go to Login', linkHref: '/login', tone: 'neutral',
    });
  }
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.render('settings', {
    username: req.session.username,
    email: userRow.email || '',
    emailOn: userRow.email_notifications !== 0, // NULL/missing counts as ON
    emailRequired: EMAIL_REQUIRED,
    flash: null,
    error: null,
  });
});

app.post('/settings', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const userId = req.session.userId;

  const email = String(req.body.email || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) {
    return res.render('settings', {
      username: req.session.username, email, emailOn: true, emailRequired: EMAIL_REQUIRED,
      flash: null, error: "That email doesn't look right — check the address.",
    });
  }
  // Checkbox pattern: a hidden 'off' default + the checkbox value 'on', so an
  // unchecked box still arrives (as 'off') instead of being absent.
  const notifOn = req.body.email_notifications === 'on' ? 1 : 0;

  db.prepare('UPDATE users SET email = ?, email_notifications = ? WHERE id = ?')
    .run(email || null, notifOn, userId);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.render('settings', {
    username: req.session.username,
    email: fresh.email || '',
    emailOn: fresh.email_notifications !== 0,
    emailRequired: EMAIL_REQUIRED,
    flash: 'Settings saved.',
    error: null,
  });
});

// A3: change password from inside a logged-in session (current password
// required — the email reset link is the "I don't know it" path).
app.post('/change-password', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');

  const base = {
    username: req.session.username,
    email: userRow.email || '',
    emailOn: userRow.email_notifications !== 0,
    emailRequired: EMAIL_REQUIRED,
  };
  const fail = (error) => res.render('settings', { ...base, flash: null, error });

  if (next.length < 6) return fail('The new password must be at least 6 characters.');
  if (next !== confirm) return fail('The two new passwords don\'t match.');
  if (!(await bcrypt.compare(current, userRow.password))) return fail('Your current password is wrong.');

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(next), userRow.id);
  res.render('settings', { ...base, flash: 'Password updated.', error: null });
});

// B2: ADMIN AREA — gated to the site owner. The creator's username (set as
// ADMIN_USERNAME in .env) is the only admin; if that env var is empty, nobody
// is admin. Every admin route checks isAdmin(req) first.
function isAdmin(req) {
  return !!process.env.ADMIN_USERNAME && req.session.username === process.env.ADMIN_USERNAME;
}

// B2.2: /admin is now the REACT SPA (admin-frontend) — but the gate stays
// server-side, and the EJS admin page (views/admin.ejs, retired in B2.9) is
// the fallback when dist/ hasn't been built yet (fresh clone, or a Render
// deploy before B2.10's build step lands). Either way, the SPA HTML never
// leaves an admin session.
const ADMIN_DIST = path.join(__dirname, 'admin-frontend', 'dist');

// B2.2 deploy self-heal (2026-09-27): the Render service's build step is a
// bare `npm install` (its dashboard config), and its free-tier disk is wiped
// on every cold start. Lifecycle hooks proved unreliable — Render's npm runs
// workspace postinstall BEFORE the workspace deps exist (`vite: not found`,
// 2026-09-27 deploy). So: at boot, if dist/ is missing, build it here while
// the deps are still in node_modules. A failed or impossible build falls
// through to the EJS page below exactly as before — the SPA is a
// convenience, never a hard dependency.
if (!existsSync(path.join(ADMIN_DIST, 'index.html'))) {
  const viteBin = [
    path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(__dirname, 'admin-frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
  ].find((p) => existsSync(p));
  if (viteBin) {
    console.log('[B2.2] admin-frontend/dist missing at boot — running vite build now…');
    const r = spawnSync(process.execPath, [viteBin, 'build'], {
      cwd: path.join(__dirname, 'admin-frontend'),
      stdio: 'inherit',
      timeout: 120000,
    });
    if (r.status === 0) {
      console.log('[B2.2] admin-frontend/dist built at boot');
    } else {
      console.warn(`[B2.2] boot-time vite build failed (exit ${r.status ?? 'signal'}) — /admin will serve the EJS page`);
    }
  } else {
    console.warn('[B2.2] admin-frontend/dist missing and vite not found in node_modules — /admin will serve the EJS page. Run `npm install && npm run build:admin`.');
  }
}

// The implementation tracker: the A/B/C roadmap with done = checked.
// (EJS admin page — the no-build fallback; the React version lands in B2.3.)
function renderEjsAdmin(req, res) {
  const roadmap = db.prepare('SELECT id, phase, step, label, done FROM roadmap ORDER BY sort_order').all();
  const byPhase = { A: [], B: [], C: [] };
  for (const r of roadmap) (byPhase[r.phase] || (byPhase[r.phase] = [])).push(r);
  const doneCount = roadmap.filter(r => r.done).length;
  res.render('admin', {
    byPhase, doneCount, total: roadmap.length, csrfToken: req.session.csrfToken,
    // A3: the blast panel shows WHERE the mail is going (console log vs outbox
    // file) so the owner knows where to look after "Send".
    emailTransport: EMAIL_TRANSPORT,
  });
}

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).render('message', {
      title: 'Forbidden', heading: 'Not your area', tone: 'error',
      body: 'The admin area is only for the site owner.', linkText: 'Back to home', linkHref: '/',
    });
  }
  const distIndex = path.join(ADMIN_DIST, 'index.html');
  if (existsSync(distIndex)) {
    return res.sendFile(distIndex); // B2.2: the React shell
  }
  console.warn('[B2.2] admin-frontend/dist is missing — serving the EJS admin page. Run `npm run build:admin`.');
  return renderEjsAdmin(req, res);
});

// B2.2: the SPA's boot endpoint — the source of the X-CSRF-Token header the
// React app sends on every state-changing POST (the fetch() version of the
// A1 posture; the EJS pages embed the same token in hidden form fields).
// Admin-gated exactly like the page itself: a non-admin gets 403, and the
// shell's "not admin" screen is pure display, never a grant.
app.get('/api/admin/boot', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  res.json({
    isAdmin: true,
    csrfToken: getCsrfToken(req),
    emailTransport: EMAIL_TRANSPORT,
  });
});

// B2.3: the tracker's list endpoint — the React admin fetches the WHOLE
// roadmap (all phases, in sort_order) and renders the checklist (the EJS
// page used to server-render the same query — renderEjsAdmin above).
// Admin-gated exactly like /api/admin/boot. It's a GET (read-only), so the
// global CSRF middleware (POST-only) doesn't apply — the CSRF posture lives
// on the state-changing POST /admin/toggle-roadmap below.
app.get('/api/admin/roadmap', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const items = db.prepare('SELECT id, phase, step, label, done FROM roadmap ORDER BY sort_order').all();
  res.json({
    items,
    done: items.filter(r => r.done).length,
    total: items.length,
  });
});

// Toggle a roadmap item's done flag (the check / uncheck in the tracker).
app.post('/admin/toggle-roadmap', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { id } = JSON.parse(body);
      const row = db.prepare('SELECT done FROM roadmap WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      const next = row.done ? 0 : 1;
      db.prepare('UPDATE roadmap SET done = ? WHERE id = ?').run(next, id);
      res.json({ success: true, done: next });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// A3: MEMBER BLAST — the "a new story is out!" announcement, usable today.
// Same CSRF posture as /admin/toggle-roadmap (JSON in, X-CSRF-Token header,
// admin-gated). Sends through notifyMembers() -> the ONE pathway. B2.9 adds
// the proper "Send to members" panel (React admin); this is the pipe + the
// handle the tests (and the EJS fallback page) use.
app.post('/admin/notify', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { subject, html } = JSON.parse(body);
      if (!subject || !html) return res.status(400).json({ error: 'subject + html required' });
      const counts = notifyMembers(String(subject), String(html));
      res.json({ success: true, ...counts });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// B2.4: uploads land under public/uploads/{kind}/{uuid}/ — served for free by the
// existing express.static('public'). The DB stores the URL-style path /uploads/{kind}/{uuid}/{name}.
// The whole location lives in these two consts (C3/O3: swap for object storage at B9 —
// the upload route is the only code that touches the filesystem here).
const publicRoot = path.join(__dirname, 'public');
const uploadRoot = path.join(publicRoot, 'uploads');
const uploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // `kind` arrives as a regular multipart field. GOTCHA: multer walks the
      // stream in order, so `kind` must be appended BEFORE the file field by
      // the client — a `kind` after the file would not be in req.body yet when
      // this runs and the dir would fall back to 'misc'. comics|images|videos, else 'misc'.
      const kind = ['comics', 'images', 'videos'].includes(req.body?.kind) ? req.body.kind : 'misc';
      const dir = path.join(uploadRoot, kind, randomUUID());
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname.replace(/[/\\]/g, '_')),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// B2.4: multipart upload. CSRF token arrives via the X-CSRF-Token header (urlencoded does not
// parse multipart, so req.body.csrf is empty here — the global middleware already checks the header).
app.post('/api/admin/upload', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  uploader.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file field "file" in the multipart body' });
    // Relative to the STATIC ROOT (public/), not a fixed slice(-N) — that breaks
    // when the checkout path depth changes: /uploads/{kind}/{uuid}/{name}, which
    // express.static('public') serves for free.
    const urlPath = '/' + path.relative(publicRoot, f.path).split(path.sep).join('/');
    res.json({ success: true, file_path: urlPath, originalName: f.originalname, bytes: f.size });
  });
});

// B2.4: manual JSON body parse (the house pattern — express.json is deliberately NOT
// registered, see the /admin/toggle-roadmap + /admin/notify comments). A global
// express.json() would consume the stream BEFORE those two manual parsers run and
// silently break them. Returns a Promise<object> ({} for an empty body).
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// B2.4: the editors' data source — every content row + counts, in one read.
// GET → CSRF-exempt (the middleware checks POST only); the admin gate is the door.
app.get('/api/admin/content', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const stories = db.prepare('SELECT * FROM stories ORDER BY id').all();
  const comics = db.prepare('SELECT * FROM comics ORDER BY id').all();
  const pages = db.prepare('SELECT * FROM comic_pages ORDER BY comic_id, page_number').all();
  const images = db.prepare('SELECT * FROM images ORDER BY id').all();
  const videos = db.prepare('SELECT * FROM videos ORDER BY id').all();
  res.json({
    stories, comics, pages, images, videos,
    counts: { stories: stories.length, comics: comics.length,
              pages: pages.length, images: images.length, videos: videos.length },
  });
});

// B2.4: stories CRUD — the single-text entity (the simplest of the editors' backends).
// All admin-gated + readJsonBody. PUT semantics: fields absent from the payload
// (or explicitly null, for description) keep the row's current value; tier_id CAN
// be explicitly cleared with null (the `=== undefined` check). publish_date = epoch ms.
app.post('/api/admin/stories', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  try {
    const { title, description, body, publish_date, is_member, tier_id } = await readJsonBody(req);
    if (!title || !body) return res.status(400).json({ error: 'title + body required' });
    const now = Date.now();
    const r = db.prepare('INSERT INTO stories (title, description, body, publish_date, is_member, tier_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(String(title), description ?? null, String(body), publish_date ?? now, is_member ? 1 : 0, tier_id ?? null, now, now);
    res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/stories/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const b = await readJsonBody(req);
    db.prepare('UPDATE stories SET title=?, description=?, body=?, publish_date=?, is_member=?, tier_id=?, updated_at=? WHERE id=?')
      .run(b.title ?? row.title, b.description ?? row.description, b.body ?? row.body,
           b.publish_date ?? row.publish_date, (b.is_member ?? row.is_member) ? 1 : 0,
           b.tier_id === undefined ? row.tier_id : b.tier_id, Date.now(), id);
    res.json({ success: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/stories/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const r = db.prepare('DELETE FROM stories WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// B2.4: comics + comic_pages CRUD — the parent/child entity. Comics OWN their
// pages: ON DELETE CASCADE actually fires here (node:sqlite runs with
// foreign_keys ON — verified empirically: deleting a comic deletes its pages),
// so a plain DELETE is enough. page_number = display order; UNIQUE(comic_id,
// page_number) means renumbering must avoid temporary collisions (the reorder
// below is two-phase for exactly that reason).
app.post('/api/admin/comics', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  try {
    const { title, description, publish_date, is_member, tier_id } = await readJsonBody(req);
    if (!title) return res.status(400).json({ error: 'title required' });
    const now = Date.now();
    const r = db.prepare('INSERT INTO comics (title, description, publish_date, is_member, tier_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(String(title), description ?? null, publish_date ?? now, is_member ? 1 : 0, tier_id ?? null, now, now);
    res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/comics/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const r = db.prepare('DELETE FROM comics WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true }); // its pages are gone with it (ON DELETE CASCADE)
});

app.post('/api/admin/comic-pages', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  try {
    const { comic_id, page_number, file_path, caption } = await readJsonBody(req);
    if (!comic_id || !Number.isInteger(page_number) || page_number < 1 || !file_path)
      return res.status(400).json({ error: 'comic_id + integer page_number (>= 1) + file_path required' });
    if (!db.prepare('SELECT id FROM comics WHERE id = ?').get(Number(comic_id)))
      return res.status(404).json({ error: 'Comic not found' });
    const r = db.prepare('INSERT INTO comic_pages (comic_id, page_number, file_path, caption) VALUES (?,?,?,?)')
      .run(Number(comic_id), page_number, String(file_path), caption ?? null);
    res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message))
      return res.status(409).json({ error: 'A page with that number already exists for this comic' });
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/admin/comic-pages/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM comic_pages WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const b = await readJsonBody(req);
    db.prepare('UPDATE comic_pages SET page_number=?, caption=?, file_path=? WHERE id=?')
      .run(b.page_number ?? row.page_number,
           b.caption === undefined ? row.caption : b.caption, // explicit null CLEARS the caption
           b.file_path ?? row.file_path, id);
    res.json({ success: true, id });
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message))
      return res.status(409).json({ error: 'A page with that number already exists for this comic' });
    res.status(400).json({ error: e.message });
  }
});

// B2.5 Step 12: delete RENUMBERS. After a page goes, the comic's remaining
// pages must be a clean 1..N (the old handler left gaps). The two-phase
// renumber is the reorder handler's exact pattern — a naive in-place renumber
// collides with UNIQUE(comic_id,page_number) the moment a page moves onto a
// number another page still holds. Delete + renumber in ONE transaction: if
// the renumber fails, the delete rolls back with it (no gap, no half state).
// Deleting the LAST page is a no-op renumber (empty loop) — the comic stays
// with zero pages, which is legal (reorder's contract only applies when pages
// exist).
app.delete('/api/admin/comic-pages/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const id = Number(req.params.id);
  const page = db.prepare('SELECT comic_id FROM comic_pages WHERE id = ?').get(id);
  if (!page) return res.status(404).json({ error: 'Not found' });
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM comic_pages WHERE id = ?').run(id);
    const remaining = db.prepare('SELECT id FROM comic_pages WHERE comic_id = ? ORDER BY page_number ASC').all(page.comic_id);
    const BASE = 1000000; // temp range that can't collide with real page numbers
    for (let i = 0; i < remaining.length; i++)
      db.prepare('UPDATE comic_pages SET page_number = ? WHERE id = ?').run(BASE + i, remaining[i].id);
    for (let i = 0; i < remaining.length; i++)
      db.prepare('UPDATE comic_pages SET page_number = ? WHERE id = ?').run(i + 1, remaining[i].id);
    db.exec('COMMIT');
    res.json({ success: true, comic_id: page.comic_id, count: remaining.length });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

// B2.4: reorder = renumber. CONTRACT: page_ids must be EXACTLY the comic's
// current page set — all of them, in the new order (the editor sends the full
// list on every drag; a partial list is rejected, not silently patched).
// TWO-PHASE renumber (temp range first, then 1..N): a naive in-place renumber
// collides with UNIQUE(comic_id,page_number) the moment a page moves onto a
// number another page still holds. One transaction — node:sqlite is
// synchronous, so the plain loops are atomic inside it.
app.patch('/api/admin/comics/:id/reorder', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const comicId = Number(req.params.id);
  const comic = db.prepare('SELECT id FROM comics WHERE id = ?').get(comicId);
  if (!comic) return res.status(404).json({ error: 'Not found' });
  try {
    const { page_ids } = await readJsonBody(req);
    if (!Array.isArray(page_ids) || page_ids.length === 0 || !page_ids.every((x) => Number.isInteger(x)))
      return res.status(400).json({ error: 'page_ids must be a non-empty array of page ids' });
    const current = db.prepare('SELECT id FROM comic_pages WHERE comic_id = ?').all(comicId).map((r) => r.id);
    const want = new Set(page_ids);
    if (want.size !== page_ids.length || current.length !== page_ids.length || !current.every((x) => want.has(x)))
      return res.status(400).json({ error: 'page_ids must be EXACTLY the comic\'s current page set (all of them, in the new order)' });
    db.exec('BEGIN');
    try {
      const BASE = 1000000; // temp range that can't collide with real page numbers
      for (let i = 0; i < page_ids.length; i++) {
        db.prepare('UPDATE comic_pages SET page_number = ? WHERE id = ?').run(BASE + i, page_ids[i]);
      }
      for (let i = 0; i < page_ids.length; i++) {
        db.prepare('UPDATE comic_pages SET page_number = ? WHERE id = ?').run(i + 1, page_ids[i]);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ success: true, comic_id: comicId, order: page_ids });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// B2.4: images + videos CRUD — the two single-media entities, mirroring the
// stories pattern (Step 4): PUT merge is `??`-based (absent fields keep the
// row's value), `caption` CAN be cleared with an explicit null (the
// `=== undefined` check), `description` (videos) keeps the Step 4 semantics,
// and `file_path` is NOT NULL so it can never be cleared. `file_path` values
// come from the Step 1 upload response. (updated_at on these two tables was
// added by the Step 6 guard in the caption-migration loop above.)
app.post('/api/admin/images', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  try {
    const { title, caption, file_path, publish_date, is_member, tier_id } = await readJsonBody(req);
    if (!title || !file_path) return res.status(400).json({ error: 'title + file_path required' });
    const now = Date.now();
    const r = db.prepare('INSERT INTO images (title, caption, file_path, publish_date, is_member, tier_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(String(title), caption ?? null, String(file_path), publish_date ?? now, is_member ? 1 : 0, tier_id ?? null, now, now);
    res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/images/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const b = await readJsonBody(req);
    db.prepare('UPDATE images SET title=?, caption=?, file_path=?, publish_date=?, is_member=?, tier_id=?, updated_at=? WHERE id=?')
      .run(b.title ?? row.title,
           b.caption === undefined ? row.caption : b.caption, // explicit null CLEARS the caption
           b.file_path ?? row.file_path,
           b.publish_date ?? row.publish_date,
           (b.is_member ?? row.is_member) ? 1 : 0,
           b.tier_id === undefined ? row.tier_id : b.tier_id,
           Date.now(), id);
    res.json({ success: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/images/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const r = db.prepare('DELETE FROM images WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.post('/api/admin/videos', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  try {
    const { title, description, caption, file_path, publish_date, is_member, tier_id } = await readJsonBody(req);
    if (!title || !file_path) return res.status(400).json({ error: 'title + file_path required' });
    const now = Date.now();
    const r = db.prepare('INSERT INTO videos (title, description, caption, file_path, publish_date, is_member, tier_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(String(title), description ?? null, caption ?? null, String(file_path), publish_date ?? now, is_member ? 1 : 0, tier_id ?? null, now, now);
    res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/videos/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const b = await readJsonBody(req);
    db.prepare('UPDATE videos SET title=?, description=?, caption=?, file_path=?, publish_date=?, is_member=?, tier_id=?, updated_at=? WHERE id=?')
      .run(b.title ?? row.title,
           b.description ?? row.description, // Step 4 semantics: absent/null keeps the current value
           b.caption === undefined ? row.caption : b.caption, // explicit null CLEARS the caption
           b.file_path ?? row.file_path,
           b.publish_date ?? row.publish_date,
           (b.is_member ?? row.is_member) ? 1 : 0,
           b.tier_id === undefined ? row.tier_id : b.tier_id,
           Date.now(), id);
    res.json({ success: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/videos/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not admin' });
  const r = db.prepare('DELETE FROM videos WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// B2.2: the built SPA's assets (Vite base '/admin/' → /admin/assets/…).
// Served to ADMIN SESSIONS ONLY — the bundle is the admin app itself, so a
// non-admin never even receives it (the page-level 403 above covers /admin;
// this covers its sub-paths). Registered AFTER the exact /admin routes above,
// so those keep winning; mounted only when dist/ exists, so a pre-build
// checkout has no dangling static middleware at all.
if (existsSync(ADMIN_DIST)) {
  app.use('/admin', (req, res, next) => {
    if (!isAdmin(req)) {
      return res.status(403).render('message', {
        title: 'Forbidden', heading: 'Not your area', tone: 'error',
        body: 'The admin area is only for the site owner.', linkText: 'Back to home', linkHref: '/',
      });
    }
    next();
  }, express.static(ADMIN_DIST));
}

// ===========================================================================
// A2: RECURRING MEMBERSHIP (PayPal Subscriptions + signed webhooks)
// ===========================================================================
//
// THE BIG CHANGE from the old Step-9 one-time flow: the return page no longer
// does the work. In Step 9 the browser landed on /paypal-return and OUR SERVER
// asked PayPal "was this order paid?" (capture). A page the user can close was
// doing the granting.
//
// In A2 the granting is done by a SIGNED WEBHOOK from PayPal's servers
// (BILLING.SUBSCRIPTION.ACTIVATED), which the user cannot forge, close, or
// ignore. The return page is now pure UX — it polls our own /membership-status
// until the webhook shows up. This is the Step-9 lesson ("never trust the
// client") taken to its logical conclusion.
//
// The flow, in 4 acts (act 3 is the one that matters):
//   1. /join-membership — create the subscription (auto-creating product+plan
//      on first use) and redirect the browser to PayPal's Agree & Approve.
//   2. Buyer approves   — PayPal activates the sub and bills monthly.
//   3. /paypal-webhook  — PayPal's servers POST a signed event; we verify the
//      RSA signature, dedupe by event id, and flip membership. GRANTING HAPPENS.
//   4. /paypal-return   — the browser lands here as pure UX; it polls
//      /membership-status until act 3 has landed.
//
// (The OAuth "access token" helper moved to paypal-subscriptions.js, where all
//  the PayPal API calls now live.)

// A2 ACT 1: join — create the subscription, send the browser to PayPal.
app.post('/join-membership', async (req, res) => {
  const userRow = req.session.userId
    ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId)
    : null;
  if (!userRow) return res.redirect('/login');

  // Already an active member? Don't start a second subscription.
  if (userRow.member === 1) {
    return res.render('message', {
      title: 'Already a member', heading: "You're already a member ⭐",
      body: '', linkText: 'Go to your dashboard', linkHref: '/dashboard', tone: 'success',
    });
  }

  // Friendly message if the credentials haven't been pasted in yet
  if (PAYPAL_CLIENT_ID.startsWith('PASTE_')) {
    return res.render('message', {
      title: 'PayPal not set up yet', heading: "PayPal isn't set up yet",
      body: 'Put your sandbox credentials in a local <code>.env</code> (see <code>.env.example</code>), restart the server, then join.',
      linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'neutral',
    });
  }

  // Billing email: the form's value wins; fall back to the stored one.
  // (PayPal needs an email to invoice the buyer; if we don't have one, it
  // uses the buyer's own PayPal account email.)
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email) {
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userRow.id);
  }

  try {
    const sub = await createSubscription(db, {
      userId: userRow.id,
      username: userRow.username,
      email: email || undefined,
    });

    // Remember the subscription id right away: the ACTIVATED webhook (which
    // carries the same id, plus our custom_id) arrives a moment later and
    // matches the user on it.
    if (sub.id) {
      db.prepare("UPDATE users SET paypal_subscription_id = ? WHERE id = ?").run(sub.id, userRow.id);
    }

    // PayPal's answer includes a list of links; find the "approve" one and
    // send the user's browser to it (the Agree & Approve step).
    const approve = (sub.links || []).find(l => l.rel === 'approve');
    if (!approve) {
      return res.render('message', {
        title: 'Subscription created', heading: `Subscription created (${sub.status})`,
        body: "PayPal didn't give us an approval link — check the sandbox dashboard for the subscription, then refresh your dashboard here.",
        linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'neutral',
      });
    }
    res.redirect(approve.href);
  } catch (error) {
    res.status(502).render('message', {
      title: 'Membership error', heading: "Couldn't start your membership",
      body: error.message, linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'error',
    });
  }
});

// A2 ACT 4 (v2 — API check): the browser lands here after the buyer approves
// (or bails) on PayPal's page.
//
// WHY THIS CHANGED (2026-09-22): in sandbox, PayPal's signed webhooks have
// been arriving with signatures we cannot verify, so the act-3 grant never
// fires there (the production pipeline is proven healthy — a correctly
// signed request through the real path verifies fine; the failure is
// input-specific). So this route now ASKS PAYPAL'S API directly — "is this
// subscription ACTIVE?" — and grants membership itself on a yes. The grant
// goes through activateMembershipFromApi -> applyMembershipEvent, the SAME
// code path the webhook uses, so there is still exactly one place that
// changes membership state (and it's idempotent: if a genuine webhook later
// arrives for the same subscription, it's a harmless no-op).
//
// SECURITY NOTE: the decision is made SERVER-SIDE from PayPal's own API
// answer, using our server-side credentials and the subscription id WE
// created — the browser only triggers the check, it can never claim
// "I'm a member". (In production the signed webhook remains the primary
// path and this route is a compatible second trigger.)
app.get('/paypal-return', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  const page = (heading, body, tone = 'neutral') => res.render('message', {
    title: heading, heading, body,
    linkText: 'Go to your dashboard', linkHref: '/dashboard', tone,
  });

  if (!userRow || !userRow.paypal_subscription_id) {
    return page(
      'No subscription on file',
      "You don't have a PayPal subscription started yet. " +
      '<a href="/dashboard">Join from your dashboard</a>.'
    );
  }

  if (PAYPAL_CLIENT_ID.startsWith('PASTE_')) {
    return page(
      "PayPal isn't set up yet",
      'Add your sandbox credentials to <code>.env</code> (or the Render env) and restart.'
    );
  }

  try {
    const sub = await getSubscription(userRow.paypal_subscription_id);
    console.log(`[A2] return-route check: user ${userRow.id} sub ${sub.id} -> ${sub.status}`);

    if (sub.status === 'ACTIVE' || sub.status === 'TRIALING') {
      const outcome = activateMembershipFromApi(db, { userId: userRow.id, subscriptionId: sub.id });
      console.log(`[A2] return-route GRANT: user ${userRow.id} sub ${sub.id} -> ${JSON.stringify(outcome)}`);
      return page(
        'You are now a member! ⭐',
        'PayPal confirms your subscription is active — membership is on. ' +
        'It renews monthly until you cancel it.',
        'success'
      );
    }

    if (sub.status === 'APPROVAL_PENDING') {
      return page(
        'Almost there — approval pending',
        'Your subscription exists, but it hasn\'t been approved yet. Finish the ' +
        '<strong>Agree &amp; Approve</strong> step in the PayPal window, then ' +
        '<a href="/paypal-return">check again</a>.'
      );
    }

    return page(
      'Subscription status: ' + sub.status,
      'PayPal reports your subscription as <code>' + sub.status + '</code>, so ' +
      'membership stays off. If you just approved it, wait a moment and ' +
      '<a href="/paypal-return">check again</a>.'
    );
  } catch (error) {
    console.log(`[A2] return-route check FAILED: user ${userRow.id} — ${error.message}`);
    res.status(502).render('message', {
      title: 'Membership check failed', heading: "Couldn't confirm your membership",
      body: error.message,
      linkText: 'Try again', linkHref: '/paypal-return',
      link2Text: 'Back to dashboard', link2Href: '/dashboard',
      tone: 'error',
    });
  }
});

// A2 ACT 3 (the one that matters): PayPal's SERVERS POST signed events here.
//
// Why express.raw()? Signature verification needs the EXACT bytes PayPal
// signed. If any middleware transformed the body (JSON re-serialization,
// charset changes, a trailing newline), the hash would differ and a genuine
// webhook would be rejected. raw() hands us the untouched bytes as a Buffer.
//
// The CSRF middleware above exempts this path on purpose — see that comment.
app.post('/paypal-webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const result = await processPaypalWebhook(db, {
    headers: req.headers,
    rawBody: req.body, // a Buffer — the exact bytes PayPal signed
    webhookId: PAYPAL_WEBHOOK_ID,
  });

  const eventType = (result.parsed && result.parsed.event_type) || '(rejected before parsing)';
  if (!result.accepted) {
    console.log(
      `[A2] webhook REJECTED: ${eventType} — ${result.reason || 'unknown reason'} (from ${req.ip || 'unknown ip'})`
    );
    // 4xx tells PayPal "this is a permanent problem" — it will retry with
    // backoff, which is fine (verification is deterministic, so it keeps
    // failing until the problem is fixed). For a forger, 400 + no state
    // change is all they ever get.
    return res.status(400).json({ error: result.reason || 'rejected' });
  }

  console.log(
    `[A2] webhook ACCEPTED: ${eventType} — ${result.stage}${result.userId ? ` (user ${result.userId})` : ''}`
  );
  // 2xx = "received, stop retrying" — for BOTH a freshly processed event and
  // a duplicate (idempotency: same event twice = same result, applied once).
  res.status(200).json({ status: result.stage });
});

// A2: machine-readable membership state. /paypal-return polls it, and it's
// handy for debugging (curl it with a session cookie while testing webhooks).
app.get('/membership-status', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'not logged in' });
  }
  const userRow = db.prepare(
    "SELECT member, membership_status, paypal_subscription_id, member_since, email FROM users WHERE id = ?"
  ).get(req.session.userId);
  res.json({
    member: userRow.member === 1,
    status: userRow.membership_status,
    subscriptionId: userRow.paypal_subscription_id,
    memberSince: userRow.member_since,
    email: userRow.email,
  });
});

// A2: cancel — ask PayPal to cancel the subscription, and (once PayPal
// confirms) flip the user off through the SAME state machine the webhook
// uses. We no longer wait for the CANCELLED webhook to do the flipping
// (it's unreliable in sandbox); a later genuine webhook is a harmless no-op
// (applyMembershipEvent is idempotent). If PayPal's cancel fails, membership
// stays ON and the page says so plainly, with a fallback path.
app.post('/cancel-membership', async (req, res) => {
  const userRow = req.session.userId
    ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId)
    : null;
  if (!userRow) return res.redirect('/login');

  if (!userRow.paypal_subscription_id) {
    return res.render('message', {
      title: 'No subscription on file', heading: 'No subscription on file',
      body: "Your membership wasn't started through PayPal (it may predate A2). Nothing to cancel on PayPal's side.",
      linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'neutral',
    });
  }

  if (PAYPAL_CLIENT_ID.startsWith('PASTE_')) {
    return res.render('message', {
      title: 'PayPal not set up yet', heading: "PayPal isn't set up yet",
      body: 'Add your sandbox credentials to <code>.env</code> and restart to cancel.',
      linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'neutral',
    });
  }

  try {
    await cancelSubscription(userRow.paypal_subscription_id);
    // PayPal confirmed the cancellation. Flip membership OFF NOW through the
    // same state machine the webhook uses — don't wait for the (unreliable)
    // CANCELLED webhook. A later genuine webhook is a harmless no-op.
    const outcome = cancelMembershipFromApi(db, {
      userId: userRow.id,
      subscriptionId: userRow.paypal_subscription_id,
    });
    console.log(`[A2] cancel confirmed: user ${userRow.id} sub ${userRow.paypal_subscription_id} -> ${JSON.stringify(outcome)}`);
    res.render('message', {
      title: 'Membership cancelled', heading: 'Membership cancelled',
      body: "PayPal confirmed the cancellation and your membership is now off. You won't be charged again.",
      linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'success',
    });
  } catch (error) {
    console.log(`[A2] cancel FAILED for user ${userRow.id}: ${error.message}`);
    res.status(502).render('message', {
      title: "Couldn't cancel", heading: "Couldn't cancel on PayPal's side",
      body: "PayPal didn't accept the cancellation, so <strong>your membership is still on</strong>. Details: " +
            error.message + ". You can also cancel from your PayPal account (Subscriptions), and your membership will turn off the next time we check.",
      linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'error',
    });
  }
});

// A2: PayPal sends the browser here if the buyer clicks "Cancel" on its
// Agree & Approve page. Nothing changed on our side — the subscription was
// never activated, so no webhook will ever grant membership. Pure "no worries"
// page.
app.get('/paypal-cancel', (req, res) => {
  res.render('message', {
    title: 'Join cancelled', heading: 'Join cancelled',
    body: 'No charge was made and nothing changed on your account (and it was test mode anyway).',
    linkText: 'Back to dashboard', linkHref: '/dashboard', tone: 'neutral',
  });
});

// Logout - clear the session
app.get('/logout', (req, res) => {
  req.session.destroy(); // Forget who this user is
  
  res.render('message', {
    title: 'Logged Out', heading: 'You are logged out!',
    body: '', linkText: 'Back to home', linkHref: '/', tone: 'success',
  });
});

// Start listening on a port.
// It reads the PORT environment variable if one is set, otherwise uses 3000.
// (Environment variables are values you set OUTSIDE the code — on a host like
//  Hostinger the platform often sets the port for you, so reading it from the
//  environment instead of hard-coding it is the standard, portable approach.)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
