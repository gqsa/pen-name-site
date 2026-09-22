# Skill: Create a Full Backend Website with Auth, Database & Payments

This skill teaches an agent how to build and deploy a complete backend website from scratch — including user registration/login, SQLite database persistence, session management, protected routes, interactive features that save per-user data, membership tiers, PayPal sandbox payments, and production deployment to Render.com.

## Project Overview

Build a simple personal website with:
- User registration and login (with password hashing)
- Session management (remembering who's logged in)
- Protected routes (dashboard only for members)
- Database persistence (SQLite storing users & progress)
- Interactive features that save per-user data (checklist)
- Membership tiers (free vs member)
- PayPal sandbox payment integration

Tech stack: Node.js + Express + SQLite (built-in `node:sqlite` module) — no npm packages needed for the database.

## Step 1: Create Project Skeleton

Create a new directory and initialize the project:

```bash
mkdir my-website-backend
cd my-website-backend
npm init -y
npm install express express-session
```

Edit `package.json` to add `"type": "module"` for ES module support.

Create `server.js`:

```javascript
import express from 'express';
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>My Website</title></head>
      <body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>Hello, this is the frontend!</h1>
        <p>Your backend server is running.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
```

Test by running `node server.js` and visiting http://localhost:3000.

## Step 2: Add SQLite Database

Create `create-db.js`:

```javascript
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('database.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )
`);
console.log('Database created with users table.');
```

Run it: `node create-db.js`. Verify `database.db` file appears.

## Step 3: Add User Registration & Login

Update `server.js` to include session middleware and auth routes:

```javascript
import express from 'express';
import session from 'express-session';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'my-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false
}));

const db = new DatabaseSync('database.db');

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

// Registration form (GET)
app.get('/register', (req, res) => {
  res.send(`
    <html>
      <head><title>Register</title></head>
      <body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>Create Account</h1>
        <form action="/register" method="POST">
          Username: <input type="text" name="username"><br><br>
          Password: <input type="password" name="password"><br><br>
          <button type="submit">Register</button>
        </form>
      </body>
    </html>
  `);
});

// Handle registration (POST)
app.post('/register', (req, res) => {
  const username = req.body.username;
  const password = hashPassword(req.body.password);
  
  try {
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, password);
    res.send(`<h1>Registration successful! Welcome, ${username}!</h1><p><a href="/login">Login now</a></p>`);
  } catch (error) {
    res.send(`<h1>Error</h1><p>${error.message}</p><p><a href="/register">Try again</a></p>`);
  }
});

// Login form (GET)
app.get('/login', (req, res) => {
  res.send(`
    <html>
      <head><title>Login</title></head>
      <body style="font-family: Arial; text-align: center; padding-top: 100px;">
        <h1>Login</h1>
        <form action="/login" method="POST">
          Username: <input type="text" name="username"><br><br>
          Password: <input type="password" name="password"><br><br>
          <button type="submit">Login</button>
        </form>
      </body>
    </html>
  `);
});

// Handle login (POST)
app.post('/login', (req, res) => {
  const username = req.body.username;
  const password = hashPassword(req.body.password);
  
  const stmt = db.prepare("SELECT * FROM users WHERE username = ?");
  const user = stmt.get(username);
  
  if (user && user.password === password) {
    req.session.userId = user.id;
    req.session.username = user.username;
    res.send(`<h1>Login successful! Welcome back, ${user.username}!</h1><p><a href="/dashboard">Go to Dashboard</a></p>`);
  } else {
    res.send(`<h1>Login failed</h1><p>Wrong username or password.</p><p><a href="/login">Try again</a></p>`);
  }
});

// Home page with login state check
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.send(`<h1>Welcome back!</h1><p>You are logged in.</p><p><a href="/dashboard">Go to Dashboard</a></p><p><a href="/logout">Logout</a></p>`);
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

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.send(`<h1>You are logged out!</h1><p><a href="/">Back to home</a></p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
```

## Step 4: Add Protected Dashboard with Progress Tracking

Create `create-progress-table.js`:

```javascript
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('database.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);
console.log('Progress table created.');
```

Run it: `node create-progress-table.js`.

Update the registration handler to create default checklist items for new users. Add a dashboard route that checks login state and displays/saves progress. Add an API endpoint `/save-progress` that accepts JSON POST requests to update item completion status.

## Step 5: Add Membership Tiers

Add a `member` column to the users table (INTEGER DEFAULT 0). Create `add-member-column.js`:

```javascript
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('database.db');
try {
  db.exec("ALTER TABLE users ADD COLUMN member INTEGER DEFAULT 0");
  console.log('Member column added.');
} catch (e) {
  console.log('Column may already exist:', e.message);
}
```

Run it. Update the dashboard to show membership status and a "Become a member" button for free users.

## Step 6: Add PayPal Sandbox Payments

> **⚠️ Superseded for subscriptions.** The one-shot payment approach below was the
> *first* implementation and carries the bugs it hit in production (one‑shot plan,
> webhook‑dependent grant, broken DELETE‑based cancel). For a **recurring membership**,
> use **`paypal-skill.md`** instead — it is the battle‑tested, one‑shot‑correct runbook
> (return‑route API grant, `POST …/cancel`, verified webhook, full roadblock list).
> This step is kept only as historical context.

Create `paypal-config.js`:

```javascript
export const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'PASTE_YOUR_TEST_CLIENT_ID_HERE';
export const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || 'PASTE_YOUR_TEST_SECRET_HERE';
export const PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const MEMBERSHIP_AMOUNT = { currency_code: 'USD', value: '1.00' };

const BASE_URL = process.env.APP_URL || 'http://localhost:3000';
export const RETURN_URL = `${BASE_URL}/paypal-return`;
export const CANCEL_URL = `${BASE_URL}/paypal-cancel`;
```

Add PayPal integration to server.js with these routes:
- `POST /become-member` — creates a PayPal order and redirects user to approve it
- `GET /paypal-return?token=ORDER-ID` — captures payment, verifies completion, updates user membership status
- `GET /paypal-cancel` — shows cancellation message

Include helper function `getPaypalToken()` that fetches OAuth token from PayPal API.

## Step 7: Prepare for Production Deployment

### Create .gitignore

```
node_modules/
database.db
.npm-cache/
npm-cache/
.env
```

### Initialize Git Repository

```bash
git init
git add .
git config user.email "your-email@example.com"
git config user.name "Your Name"
git commit -m "Initial commit: backend app with auth, database, and PayPal integration"
```

### Create render.yaml

```yaml
services:
  - type: web
    name: my-website-backend
    env: node
    buildCommand: npm install
    startCommand: node server.js
    healthCheckPath: /
    envVars:
      - key: NODE_ENV
        value: production
      - key: SESSION_SECRET
        generateValue: true
```

### Add Auto-Create Tables to server.js

Critical for production — the database file won't exist on first deploy. Add this after opening the database:

```javascript
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
```

## Step 8: Deploy to Render.com

### Push to GitHub

1. Create a new repository on GitHub (public or private)
2. Generate a Personal Access Token (PAT) with `repo` scope at github.com/settings/tokens
3. Set remote and push:

```bash
git remote add origin https://YOUR_USERNAME:YOUR_PAT@github.com/YOUR_USERNAME/REPO_NAME.git
git branch -M main
git push -u origin main
```

### Deploy on Render

1. Sign up at render.com (free tier, no credit card)
2. Click "New +" → "Web Service"
3. Connect GitHub and select your repository
4. Configure:
   - Name: `my-website-backend` (or custom)
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
5. Add environment variables in the "Environment" tab:
   - `SESSION_SECRET` — click Generate for random value
   - `PAYPAL_CLIENT_ID` — your PayPal sandbox client ID
   - `PAYPAL_CLIENT_SECRET` — your PayPal sandbox secret
   - `APP_URL` — your Render URL (add after deployment completes)
6. Click "Create Web Service"

### Post-Deployment Configuration

After the first successful deployment:
1. Note your live URL from Render dashboard
2. Add/update `APP_URL` environment variable with this URL
3. Save changes and wait for redeployment
4. Test registration, login, and PayPal payments on the live site

## Common Issues & Fixes

### "no such table: users" on deployed app
**Cause:** Database file doesn't exist on first deploy; tables were never created.  
**Fix:** Add auto-create tables code to server.js (Step 7).

### PayPal redirects to localhost instead of live URL
**Cause:** `APP_URL` environment variable not set or deployment hasn't completed after adding it.  
**Fix:** Set `APP_URL` in Render's Environment tab, save changes, wait for redeployment. Alternatively, set `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL` directly.

### Git push fails with SSL error on Windows
**Cause:** schannel backend can't find credentials.  
**Fix:** Run `git config http.sslBackend openssl` before pushing.

### Free hosting database persistence
**Note:** On Render's free tier, the filesystem is ephemeral — `database.db` gets wiped when the app restarts (after ~15 minutes of inactivity). Users will need to re-register after each restart. For persistent data, upgrade to a managed database like PostgreSQL.

## Testing Checklist

Before declaring deployment complete, verify:
- [ ] Home page loads and shows correct login state
- [ ] New user can register successfully
- [ ] Registered user can log in with correct credentials
- [ ] Login fails with wrong password
- [ ] Dashboard is protected (redirects to login if not authenticated)
- [ ] Checklist items load for logged-in user
- [ ] Checking/unchecking items saves progress
- [ ] Logout clears session
- [ ] "Become a member" button appears for free users
- [ ] PayPal payment flow completes successfully (sandbox mode)
- [ ] Membership status updates after payment

## Next Steps After Deployment

Once the app is live and working, suggest these enhancements to the user:
1. Share the live URL with others
2. Add profile editing or password reset features
3. Upgrade to PostgreSQL for persistent data
4. Switch PayPal from sandbox to live mode
5. Build a proper frontend with React/Vue instead of inline HTML
6. Add email notifications
7. Create an admin panel
