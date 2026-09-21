// A1 security verification — runs against a LIVE server.
//
// HOW TO RUN:
//   1. start the server:  node server.js
//   2. in another terminal: node test-a1-security.mjs
//
// WHAT IT PROVES:
//   1. login/register pages carry a per-session CSRF token
//   2. a POST without that token is rejected (403)  ← the CSRF fix
//   3. registration stores a BCRYPT hash, not plain SHA-256  ← the bcrypt fix
//   4. login still works with the correct password
//   5. /save-progress needs the X-CSRF-Token header (fetch() version of #2)
//   6. a legacy SHA-256 account can still log in AND gets transparently
//      upgraded to bcrypt on first login  ← migration path
//   7. too many failed logins → 429  ← the rate-limit fix
//
// NOTE: the rate-limit counter is in server memory and shared per IP. If you
// hammered logins in the last 15 minutes, restart the server first.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const BASE = process.env.TEST_URL || 'http://localhost:3000';
let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
  if (!ok) failures++;
}

// --- tiny "cookie jar" helpers: the server identifies YOU by this cookie ---
function cookieOf(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

// Simulate a fresh browser visit: get a session cookie, then read the CSRF
// token out of the server-rendered login page (hidden form field).
async function newSession() {
  const boot = await fetch(BASE + '/');
  const cookie = cookieOf(boot);
  const loginPage = await fetch(BASE + '/login', { headers: { cookie } });
  const html = await loginPage.text();
  const m = html.match(/name="csrf" value="([a-f0-9]+)"/);
  return { cookie, token: m ? m[1] : null };
}

// POST a form the way a real browser would — with the session's csrf field.
async function postForm(path, session, fields) {
  const body = new URLSearchParams({ ...fields, csrf: session.token }).toString();
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body,
  });
}

// Read what the database actually stores for a user's password.
function storedHash(username) {
  const d = new DatabaseSync('database.db');
  const row = d.prepare('SELECT password FROM users WHERE username = ?').get(username);
  d.close();
  return row ? row.password : null;
}

console.log('== A1 security checks ==\n');

// 1. the rendered login page carries a per-session CSRF token
const s0 = await newSession();
check('login page carries a per-session CSRF token', Boolean(s0.token),
  s0.token ? s0.token.slice(0, 12) + '…' : 'no token found');

// 2. CSRF negative: a POST with NO token must be rejected (this is exactly
//    what an attacker's cross-site form would produce)
{
  const boot = await fetch(BASE + '/');
  const cookie = cookieOf(boot);
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: 'username=whoever&password=whatever',
  });
  check('POST without CSRF token is rejected (403)', res.status === 403, `got ${res.status}`);
}

// 3. registration + bcrypt storage
const ts = Date.now();
const user = `testalice${ts}`;
const pass = 'S3cret!pass';
{
  const s = await newSession();
  const res = await postForm('/register', s, { username: user, password: pass });
  const html = await res.text();
  check('register succeeds with CSRF token', res.status === 200 && /Registration successful/.test(html),
    `status ${res.status}`);
  const hash = storedHash(user);
  check('password stored as BCRYPT (hash starts with $2)', Boolean(hash) && hash.startsWith('$2'),
    hash ? hash.slice(0, 12) + '…' : 'no row found');
}

// 4. login with the correct password still works
{
  const s = await newSession();
  const res = await postForm('/login', s, { username: user, password: pass });
  const html = await res.text();
  if (res.status === 429) {
    console.log('\n!!! 429 rate limit hit — the server has remembered login attempts from the last 15 minutes.');
    console.log('!!! Restart the server (node server.js) and re-run this script.\n');
    process.exit(1);
  }
  check('login with correct password succeeds', /Login successful/.test(html), `status ${res.status}`);
}

// 5. /save-progress (the dashboard's fetch() call): header version of CSRF
{
  const s = await newSession();
  await postForm('/login', s, { username: user, password: pass }); // log this session in
  const d = new DatabaseSync('database.db');
  const item = d.prepare(
    'SELECT id FROM progress WHERE user_id = (SELECT id FROM users WHERE username = ?) LIMIT 1'
  ).get(user);
  d.close();

  const noHeader = await fetch(BASE + '/save-progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: s.cookie },
    body: JSON.stringify({ id: item.id, completed: 1 }),
  });
  check('/save-progress without X-CSRF-Token is rejected (403)', noHeader.status === 403, `got ${noHeader.status}`);

  const withHeader = await fetch(BASE + '/save-progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.token },
    body: JSON.stringify({ id: item.id, completed: 0 }),
  });
  check('/save-progress WITH X-CSRF-Token works (200)', withHeader.status === 200, `got ${withHeader.status}`);
}

// 6. legacy SHA-256 account: can still log in, and gets upgraded to bcrypt
{
  const legacyUser = `legacy${ts}`;
  const legacyPass = 'oldpass123';
  const sha = createHash('sha256').update(legacyPass).digest('hex');
  const d = new DatabaseSync('database.db');
  d.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(legacyUser, sha);
  d.close();

  const s = await newSession();
  const res = await postForm('/login', s, { username: legacyUser, password: legacyPass });
  const html = await res.text();
  check('legacy SHA-256 account can still log in', /Login successful/.test(html), `status ${res.status}`);

  const hash = storedHash(legacyUser);
  check('…and its hash was transparently upgraded to BCRYPT', Boolean(hash) && hash.startsWith('$2'),
    hash ? hash.slice(0, 12) + '…' : 'no row found');
}

// 7. rate limiting: keep failing until the server says "slow down" (429)
{
  let saw429 = false, attempts = 0;
  for (let i = 0; i < 8 && !saw429; i++) {
    const s = await newSession();
    const res = await postForm('/login', s, { username: user, password: 'definitely-wrong-' + i });
    attempts++;
    if (res.status === 429) { saw429 = true; break; }
  }
  check('login attempts are rate-limited (429 appears)', saw429, `after ${attempts} wrong attempts`);
}

console.log(failures === 0 ? '\nAll A1 checks passed ✅' : `\n${failures} check(s) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
