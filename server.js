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
} from './paypal-subscriptions.js';

const app = express();

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
    return res.status(403).send(`
      <html><body style="font-family: Arial, sans-serif; text-align: center; padding-top: 80px;">
        <h1>403 — request blocked</h1>
        <p>Missing or invalid anti-forgery token (CSRF check failed).</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
    `);
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

// Home page
app.get('/', (req, res) => {
  // Check if user is logged in
  if (req.session.userId) {
    res.send(`
      <html>
        <head><title>My Website</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Welcome back!</h1>
          <p>You are logged in.</p>
          <p><a href="/dashboard">Go to Dashboard</a></p>
          <p><a href="/logout">Logout</a></p>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head><title>My Website</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Hello, this is the frontend!</h1>
          <p>Your backend server is running.</p>
          <p><a href="/register">Register a new account</a></p>
          <p><a href="/login">Login</a></p>
        </body>
      </html>
    `);
  }
});

// Show registration form (GET request)
// A1: server-rendered now (see /login above) — the form must embed this
// session's hidden CSRF token, which only the server can know.
app.get('/register', (req, res) => {
  res.send(`
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Register</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; }
        input { display: block; width: 100%; padding: 8px; margin: 8px 0; box-sizing: border-box; }
        button { padding: 10px 20px; background: #4CAF50; color: white; border: none; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Create Account</h1>

      <!-- This form sends data to /register on the server -->
      <form action="/register" method="POST">
        <!-- A1: hidden CSRF field — the anti-forgery token for this session -->
        <input type="hidden" name="csrf" value="${res.locals.csrfToken}">

        <label>Username:</label>
        <input type="text" name="username" required placeholder="Choose a username">

        <label>Password:</label>
        <input type="password" name="password" required placeholder="Choose a password">

        <button type="submit">Register</button>
      </form>

      <p><a href="/">Back to home</a></p>
    </body>
    </html>
  `);
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
    
    res.send(`
      <html>
        <head><title>Success!</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Registration successful! 🎉</h1>
          <p>Welcome, ${username}!</p>
          <p><a href="/login">Login now</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    res.send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Error</h1>
          <p>${error.message}</p>
          <p><a href="/register">Try again</a></p>
        </body>
      </html>
    `);
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
    return res.status(429).send(`
      <html><body style="font-family: Arial, sans-serif; text-align: center; padding-top: 80px;">
        <h1>Too many login attempts</h1>
        <p>Please wait 15 minutes and try again.</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
    `);
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
  res.send(`
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Login</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; }
        input { display: block; width: 100%; padding: 8px; margin: 8px 0; box-sizing: border-box; }
        button { padding: 10px 20px; background: #4CAF50; color: white; border: none; cursor: pointer; }
        .error { color: red; font-weight: bold; margin-top: 10px; }
      </style>
    </head>
    <body>
      <h1>Login</h1>

      <form action="/login" method="POST">
        <!-- A1: hidden CSRF field — the anti-forgery token for this session -->
        <input type="hidden" name="csrf" value="${res.locals.csrfToken}">

        <label>Username:</label>
        <input type="text" name="username" required placeholder="Your username">

        <label>Password:</label>
        <input type="password" name="password" required placeholder="Your password">

        <button type="submit">Login</button>
      </form>

      <p><a href="/">Back to home</a></p>
      <p><a href="/register">Don't have an account? Register</a></p>
    </body>
    </html>
  `);
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
    
    res.send(`
      <html>
        <head><title>Login Successful</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Login successful! 🎉</h1>
          <p>Welcome back, ${user.username}!</p>
          <p><a href="/dashboard">Go to Dashboard</a></p>
        </body>
      </html>
    `);
  } else {
    // Wrong username or password
    res.send(`
      <html>
        <head><title>Login Failed</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Login failed</h1>
          <p>Wrong username or password.</p>
          <p><a href="/login">Try again</a></p>
        </body>
      </html>
    `);
  }
});

// Dashboard - only accessible if logged in
app.get('/dashboard', (req, res) => {
  // Check if user is logged in by looking at their session
  if (!req.session.userId) {
    // Not logged in — send them to login page
    res.send(`
      <html>
        <head><title>Please Login</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Please login first</h1>
          <p><a href="/login">Go to Login</a></p>
        </body>
      </html>
    `);
    return; // Stop here, don't show dashboard
  }

  // User is logged in — load their progress from database
  const stmt = db.prepare("SELECT * FROM progress WHERE user_id = ? ORDER BY id");
  const items = stmt.all(req.session.userId);

  let checklistHTML = '';
  for (const item of items) {
    const checked = item.completed ? 'checked' : '';
    checklistHTML += `
      <li>
        <input type="checkbox" id="item-${item.id}" data-id="${item.id}" ${checked} onchange="toggleItem(${item.id}, this.checked)">
        <label for="item-${item.id}">${item.item}</label>
      </li>
    `;
  }

  // A2: load this user's FULL membership state from the database.
  // The session only stores userId/username, so we look up the fresh value here.
  const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  const isMember = userRow && userRow.member === 1;
  const membershipStatus = userRow?.membership_status || 'free'; // free | active | suspended | cancelled

  // A line showing the current state — the recurring model has more states
  // than the old "free / member", and we show each one honestly.
  const memberSince = userRow.member_since
    ? ` (since ${new Date(userRow.member_since).toLocaleDateString()})`
    : '';
  const statusLine = {
    active:    `<p>Membership status: <strong>Member</strong> ⭐ — renews monthly${memberSince}</p>`,
    suspended: `<p style="color:#b45309;">Membership status: <strong>SUSPENDED</strong> — a payment failed. Fix it in your PayPal account to restore access.</p>`,
    cancelled: `<p>Membership status: <strong>Cancelled</strong> — join again any time.</p>`,
    free:      `<p>Membership status: <strong>Free</strong></p>`,
  }[membershipStatus] || '<p>Membership status: <strong>Free</strong></p>';

  // Member-only content — the SERVER decides whether to send it,
  // based on the stored flag. Free users never receive this HTML at all.
  let memberOnlyHTML = '';
  if (isMember) {
    memberOnlyHTML = `
      <div style="background:#f0fff4; border:1px solid #9ae6b4; padding:12px; border-radius:6px; margin-top:20px;">
        <h3 style="margin-top:0;">Members' Club ⭐</h3>
        <p>This box is only visible to members. Welcome to the club!</p>
      </div>
    `;
  }

  // A2: the membership panel — replaces the old one-time "$1.00" button.
  // Three shapes, one rule: this panel only STARTS or STOPS the process.
  // Granting and revoking access is ALWAYS done by the signed webhook,
  // never by a page the user can close or ignore.
  let membershipHTML = '';
  if (membershipStatus === 'active') {
    membershipHTML = `
      <div style="border:1px solid #9ae6b4; background:#f0fff4; border-radius:6px; padding:14px; margin-top:20px;">
        <h3 style="margin-top:0;">Your membership ⭐</h3>
        <p>${SUBSCRIPTION_PRICE} ${SUBSCRIPTION_CURRENCY}/month, renews automatically. Cancel any time.</p>
        <form action="/cancel-membership" method="POST" onsubmit="return confirm('Cancel your membership? Access ends as soon as PayPal confirms.');">
          <input type="hidden" name="csrf" value="${res.locals.csrfToken}">
          <button type="submit" style="padding:8px 16px; cursor:pointer; background:#c53030; color:white; border:none; border-radius:4px;">Cancel membership</button>
        </form>
      </div>
    `;
  } else if (membershipStatus === 'suspended') {
    membershipHTML = `
      <div style="border:1px solid #f6ad55; background:#fffaf0; border-radius:6px; padding:14px; margin-top:20px;">
        <h3 style="margin-top:0;">Your membership is suspended ⚠️</h3>
        <p>A payment failed, so PayPal paused billing. Fix the payment from your
        PayPal account and the REINSTATED webhook will restore your access.</p>
        <p>If you'd rather not continue:</p>
        <form action="/cancel-membership" method="POST" onsubmit="return confirm('Cancel your membership?');">
          <input type="hidden" name="csrf" value="${res.locals.csrfToken}">
          <button type="submit" style="padding:8px 16px; cursor:pointer; background:#c53030; color:white; border:none; border-radius:4px;">Cancel membership</button>
        </form>
      </div>
    `;
  } else {
    // free (or cancelled) -> the join panel
    membershipHTML = `
      <div style="border:1px solid #ccc; border-radius:6px; padding:14px; margin-top:20px;">
        <h3 style="margin-top:0;">Join the membership</h3>
        <p>${SUBSCRIPTION_PRICE} ${SUBSCRIPTION_CURRENCY}/month — renews automatically, cancel any time.
        (PayPal sandbox: no real money is charged.)</p>
        <form action="/join-membership" method="POST">
          <input type="hidden" name="csrf" value="${res.locals.csrfToken}">
          <label>Billing email (optional):
            <input type="email" name="email" value="${userRow.email || ''}" placeholder="you@example.com" style="padding:6px;">
          </label><br>
          <button type="submit" style="padding:8px 16px; cursor:pointer; margin-top:6px;">Join membership</button>
        </form>
      </div>
    `;
  }

  // User is logged in — show their dashboard!
  res.send(`
    <html>
      <head><title>Dashboard</title></head>
      <body style="font-family: Arial; max-width: 600px; margin: 50px auto;">
        <h1>Welcome to your Dashboard, ${req.session.username}!</h1>
        <p>This page is only visible when you're logged in.</p>

        ${statusLine}

        <h2>Your Learning Progress</h2>
        <ul style="list-style-type: none; padding: 0;">
          ${checklistHTML}
        </ul>

        ${memberOnlyHTML}
        ${membershipHTML}

        <p><a href="/logout">Logout</a></p>

        <script>
          // Save progress when checkbox is clicked
          async function toggleItem(id, completed) {
            const response = await fetch('/save-progress', {
              method: 'POST',
              // A1: fetch() calls aren't forms, so the CSRF token travels in a
              // HEADER (X-CSRF-Token) instead of a hidden form field.
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': '${res.locals.csrfToken}'
              },
              body: JSON.stringify({id: id, completed: completed ? 1 : 0})
            });
            console.log('Saved:', response.ok);
          }
        </script>
      </body>
    </html>
  `);
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
    return res.send(`
      <html><body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>You're already a member ⭐</h1>
        <p><a href="/dashboard">Go to your dashboard</a></p>
      </body></html>
    `);
  }

  // Friendly message if the credentials haven't been pasted in yet
  if (PAYPAL_CLIENT_ID.startsWith('PASTE_')) {
    return res.send(`
      <html>
        <head><title>PayPal not set up yet</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>PayPal isn't set up yet</h1>
          <p>Put your sandbox credentials in a local <code>.env</code> (see
          <code>.env.example</code>), restart the server, then join.</p>
          <p><a href="/dashboard">Back to dashboard</a></p>
        </body>
      </html>
    `);
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
      return res.send(`
        <html><body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Subscription created (${sub.status})</h1>
          <p>PayPal didn't give us an approval link — check the sandbox dashboard
          for the subscription, then refresh your dashboard here.</p>
          <p><a href="/dashboard">Back to dashboard</a></p>
        </body></html>
      `);
    }
    res.redirect(approve.href);
  } catch (error) {
    res.status(502).send(`
      <html>
        <head><title>Membership error</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Couldn't start your membership</h1>
          <p>${error.message}</p>
          <p><a href="/dashboard">Back to dashboard</a></p>
        </body>
      </html>
    `);
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

  const page = (headline, detailHtml) => res.send(`
    <html>
      <head><title>${headline}</title></head>
      <body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>${headline}</h1>
        <p>${detailHtml}</p>
        <p><a href="/dashboard">Go to your dashboard</a></p>
      </body>
    </html>
  `);

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
        'It renews monthly until you cancel it.'
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
    res.status(502).send(`
      <html>
        <head><title>Membership check failed</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Couldn't confirm your membership</h1>
          <p>${error.message}</p>
          <p><a href="/paypal-return">Try again</a> &middot; <a href="/dashboard">Back to dashboard</a></p>
        </body>
      </html>
    `);
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

// A2: cancel — ask PayPal to cancel the subscription. We do NOT flip the user
// off ourselves here: the CANCELLED webhook (or the buyer cancelling from
// their own PayPal account) does that, keeping ONE code path for every state
// change. We just report what we asked for.
app.post('/cancel-membership', async (req, res) => {
  const userRow = req.session.userId
    ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId)
    : null;
  if (!userRow) return res.redirect('/login');

  if (!userRow.paypal_subscription_id) {
    return res.send(`
      <html><body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>No subscription on file</h1>
        <p>Your membership wasn't started through PayPal (it may predate A2).
        Nothing to cancel on PayPal's side.</p>
        <p><a href="/dashboard">Back to dashboard</a></p>
      </body></html>
    `);
  }

  if (PAYPAL_CLIENT_ID.startsWith('PASTE_')) {
    return res.send(`
      <html><body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>PayPal isn't set up yet</h1>
        <p>Add your sandbox credentials to <code>.env</code> and restart to cancel.</p>
        <p><a href="/dashboard">Back to dashboard</a></p>
      </body></html>
    `);
  }

  try {
    await cancelSubscription(userRow.paypal_subscription_id);
    res.send(`
      <html>
        <head><title>Cancellation requested</title></head>
        <body style="font-family: Arial; text-align: center; padding-top: 100px;">
          <h1>Cancellation requested</h1>
          <p>PayPal accepted the cancellation. Your membership switches off as soon
          as the CANCELLED webhook arrives (usually within seconds).</p>
          <p><a href="/dashboard">Back to dashboard</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(502).send(`
      <html><body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>Couldn't cancel on PayPal's side</h1>
        <p>${error.message}</p>
        <p><a href="/dashboard">Back to dashboard</a></p>
      </body></html>
    `);
  }
});

// A2: PayPal sends the browser here if the buyer clicks "Cancel" on its
// Agree & Approve page. Nothing changed on our side — the subscription was
// never activated, so no webhook will ever grant membership. Pure "no worries"
// page.
app.get('/paypal-cancel', (req, res) => {
  res.send(`
    <html>
      <head><title>Join cancelled</title></head>
      <body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>Join cancelled</h1>
        <p>No charge was made and nothing changed on your account
        (and it was test mode anyway).</p>
        <p><a href="/dashboard">Back to dashboard</a></p>
      </body>
    </html>
  `);
});

// Logout - clear the session
app.get('/logout', (req, res) => {
  req.session.destroy(); // Forget who this user is
  
  res.send(`
    <html>
      <head><title>Logged Out</title></head>
      <body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>You are logged out!</h1>
        <p><a href="/">Back to home</a></p>
      </body>
    </html>
  `);
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
