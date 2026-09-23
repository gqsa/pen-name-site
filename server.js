// Your backend server with registration, login, and dashboard!
import express from 'express';
import session from 'express-session';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs'; // the bcrypt algorithm in pure JS (same hashes, no native build)
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

  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
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

// B1 seed: one tier + a little sample content, ONLY while a table is empty
// (so a restart never duplicates it). Real content arrives in B2 via uploads;
// these rows just give the schema something real to hold and B3 something to
// display while we build the public pages.
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

// Home page — B0: now an EJS template (views/home.ejs). The old member /
// non-member variants collapse into one template via the `isMember` local.
app.get('/', (req, res) => {
  res.render('home', { isMember: !!req.session.userId });
});

// Show registration form (GET request)
// A1: server-rendered now (see /login above) — the form must embed this
// session's hidden CSRF token, which only the server can know.
app.get('/register', (req, res) => {
  res.render('register');
});

// Handle registration form submission (POST request)
app.post('/register', async (req, res) => {
  const username = req.body.username;
  const password = await hashPassword(req.body.password); // Hash before saving! (A1: bcrypt — slow on purpose)

  try {
    // Insert the new user
    const stmt = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");
    const result = stmt.run(username, password);
    
    // Get the ID of the newly created user
    const userId = result.lastInsertRowid;

    // Create default checklist items for this new user
    const defaultItems = [
      "Learn what a backend is",
      "Understand databases and SQL",
      "Build user registration",
      "Implement login with sessions",
      "Create a protected dashboard"
    ];
    
    for (const item of defaultItems) {
      db.prepare("INSERT INTO progress (user_id, item) VALUES (?, ?)").run(userId, item);
    }
    
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

  // User is logged in — load their progress + fresh membership state, then let
  // views/dashboard.ejs do the conditional rendering (status line, member box,
  // membership panel). The server still DECIDES membership; the template only
  // displays what we hand it.
  const items = db.prepare("SELECT * FROM progress WHERE user_id = ? ORDER BY id").all(req.session.userId);
  const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  const isMember = userRow && userRow.member === 1;
  const membershipStatus = userRow?.membership_status || 'free'; // free | active | suspended | cancelled
  const memberSince = userRow.member_since
    ? ` (since ${new Date(userRow.member_since).toLocaleDateString()})`
    : '';

  res.render('dashboard', {
    username: req.session.username,
    items,
    isMember,
    membershipStatus,
    memberSince,
    billingEmail: userRow.email || '',
    subscriptionPrice: SUBSCRIPTION_PRICE,
    subscriptionCurrency: SUBSCRIPTION_CURRENCY,
  });
});

// API endpoint to save progress item
app.post('/save-progress', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({error: 'Not logged in'});
  }

  // Parse JSON body manually since we're not using express.json() middleware
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      db.prepare("UPDATE progress SET completed = ? WHERE id = ? AND user_id = ?")
        .run(data.completed, data.id, req.session.userId);
      res.json({success: true});
    } catch (e) {
      res.status(400).json({error: e.message});
    }
  });
});

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
