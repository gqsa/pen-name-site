// A1 security verification — SELF-CONTAINED.
//
// HOW TO RUN:
//   node test-a1-security.mjs
//
// The test spawns its OWN server (node server.js) on a free port with a
// controlled environment — a fresh in-memory rate-limit counter and a known
// ADMIN_USERNAME — runs the checks against it, then kills it. No need to
// start a server first, no port-3000 conflicts, and the rate-limit check can
// never be poisoned by logins from an earlier run.
//
// WHAT IT PROVES:
//   1. the login page carries a per-session CSRF token
//   2. a POST without that token is rejected (403)  ← the CSRF fix
//   3. registration stores a BCRYPT hash, not plain SHA-256  ← the bcrypt fix
//   4. login still works with the correct password
//   5. B2 admin area: the admin account is AUTO-CREATED at boot from
//      ADMIN_USERNAME + ADMIN_PASSWORD (the fresh-disk path that keeps the
//      owner able to log in on Render's wiped free-tier disk); /admin renders
//      for the owner (200 + tracker) and is 403 for a logged-in non-owner;
//      /admin/toggle-roadmap needs the X-CSRF-Token header (the fetch()
//      version of #2 — it replaced the retired /save-progress endpoint) and
//      rejects a valid token from a non-owner (the ADMIN_USERNAME gate)
//   6. a legacy SHA-256 account can still log in AND gets transparently
//      upgraded to bcrypt on first login  ← migration path
//   7. too many failed logins → 429  ← the rate-limit fix
//
// NOTE: the spawned server shares the repo's database.db. The admin account
// (a ts-suffixed name) is created by the server's OWN boot-seed — that's the
// fresh-disk path under test; the test also registers ts-suffixed throwaway
// users, and the one roadmap row it toggles is restored to its original state
// before the test ends.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'database.db');

// `connection: close` on every request: undici otherwise keeps a keep-alive
// socket open, and on Windows an abrupt process.exit() with a live socket
// trips a libuv assertion (win/async.c) that clobbers the exit code.
const CLOSE = { headers: { connection: 'close' } };

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
  if (!ok) failures++;
}

const ts = Date.now();
const USER = `testalice${ts}`;      // ordinary (non-admin) account
const ADMIN_USER = `a1admin${ts}`;  // matches the spawned server's ADMIN_USERNAME
const LEGACY_USER = `legacy${ts}`;
const PASS = 'S3cret!pass';

// --- grab a free port, spawn the server under a controlled environment -----
const port = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
const BASE = `http://localhost:${port}`;

// stdio 'inherit' (not 'pipe'): the DSH sandbox denies named-pipe stdio to
// children with EPERM; inherit works everywhere and just interleaves the
// server's log lines with the test output.
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: PASS, SESSION_SECRET: 'a1-test-secret' },
  stdio: 'inherit',
});
let childExitCode = null;
child.on('exit', (code) => { childExitCode = code; });

async function waitReady(deadlineMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (childExitCode !== null) throw new Error(`server exited early (code ${childExitCode})`);
    try {
      const r = await fetch(BASE + '/', CLOSE);
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready within ${deadlineMs}ms`);
}

// --- tiny "cookie jar" helpers: the server identifies YOU by this cookie ---
function cookieOf(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

// Simulate a fresh browser visit: get a session cookie, then read the CSRF
// token out of the server-rendered login page (hidden form field).
async function newSession() {
  const boot = await fetch(BASE + '/', CLOSE);
  const cookie = cookieOf(boot);
  const loginPage = await fetch(BASE + '/login', { headers: { cookie } });
  const html = await loginPage.text();
  const m = html.match(/name="csrf" value="([a-f0-9]+)"/);
  return { cookie, token: m ? m[1] : null };
}

async function get(path, session = null) {
  const headers = { 'connection': 'close' };
  if (session) headers.cookie = session.cookie;
  return fetch(BASE + path, { headers });
}

// POST a form the way a real browser would — with the session's csrf field.
async function postForm(path, session, fields) {
  const body = new URLSearchParams({ ...fields, csrf: session.token }).toString();
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie, 'connection': 'close' },
    body,
  });
}

// Read what the database actually stores for a user's password.
function storedHash(username) {
  const d = new DatabaseSync(DB_PATH);
  const row = d.prepare('SELECT password FROM users WHERE username = ?').get(username);
  d.close();
  return row ? row.password : null;
}

try {
  await waitReady();

  console.log('== A1 security checks ==\n');

  // 1. the rendered login page carries a per-session CSRF token
  const s0 = await newSession();
  check('login page carries a per-session CSRF token', Boolean(s0.token),
    s0.token ? s0.token.slice(0, 12) + '…' : 'no token found');

  // 2. CSRF negative: a POST with NO token must be rejected (this is exactly
  //    what an attacker's cross-site form would produce)
  {
    const boot = await fetch(BASE + '/', CLOSE);
    const cookie = cookieOf(boot);
    const res = await fetch(BASE + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'connection': 'close' },
      body: 'username=whoever&password=whatever',
    });
    check('POST without CSRF token is rejected (403)', res.status === 403, `got ${res.status}`);
  }

  // 3. registration + bcrypt storage
  {
    const s = await newSession();
    const res = await postForm('/register', s, { username: USER, password: PASS });
    const html = await res.text();
    check('register succeeds with CSRF token', res.status === 200 && /Registration successful/.test(html),
      `status ${res.status}`);
    const hash = storedHash(USER);
    check('password stored as BCRYPT (hash starts with $2)', Boolean(hash) && hash.startsWith('$2'),
      hash ? hash.slice(0, 12) + '…' : 'no row found');
  }

  // 4. login with the correct password still works
  let sUser;
  {
    const s = await newSession();
    const res = await postForm('/login', s, { username: USER, password: PASS });
    const html = await res.text();
    check('login with correct password succeeds', /Login successful/.test(html), `status ${res.status}`);
    sUser = s;
  }

  // 5. B2.1 — the admin account is AUTO-CREATED at boot from
  //    ADMIN_USERNAME + ADMIN_PASSWORD (the fresh-disk path that keeps the
  //    owner able to log in after a Render free-tier wipe). This run's admin
  //    name is brand-new, so the boot-seed just created it — log in with the
  //    env password. (No registration step: that would be testing nothing.)
  let sAdmin;
  {
    const s = await newSession();
    const login = await postForm('/login', s, { username: ADMIN_USER, password: PASS });
    const html = await login.text();
    check('admin account is auto-created at boot (login with env password works)',
      login.status === 200 && /Login successful/.test(html), `status ${login.status}`);
    if (login.status !== 200) throw new Error('admin login failed — the boot-seed did not create the account');
    sAdmin = s;
  }

  // 6. /admin renders for the owner, with the implementation tracker
  {
    const res = await get('/admin', sAdmin);
    const html = await res.text();
    check('admin area renders for the owner (200 + tracker)',
      res.status === 200 && /Implementation tracker/.test(html), `got ${res.status}`);
  }

  // 7. /admin is forbidden for a logged-in NON-owner
  {
    const res = await get('/admin', sUser);
    check('admin area is forbidden for a non-owner (403)', res.status === 403, `got ${res.status}`);
  }

  // 8–10. /admin/toggle-roadmap: the fetch()-style CSRF check (the header
  //       version of #2, now that /save-progress is retired) + the admin gate
  {
    const d = new DatabaseSync(DB_PATH);
    const row = d.prepare('SELECT id, done FROM roadmap ORDER BY sort_order LIMIT 1').get();
    d.close();
    if (!row) throw new Error('roadmap table missing — the server did not finish booting');

    // 8. owner session, NO header → the CSRF middleware must reject. Assert
    //    the anti-forgery message too, so this can't be confused with the
    //    admin gate (both answer 403, different bodies).
    const noHeader = await fetch(BASE + '/admin/toggle-roadmap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sAdmin.cookie, 'connection': 'close' },
      body: JSON.stringify({ id: row.id }),
    });
    const noHeaderText = await noHeader.text();
    check('/admin/toggle-roadmap without X-CSRF-Token is rejected (403)',
      noHeader.status === 403 && /anti-forgery/i.test(noHeaderText), `got ${noHeader.status}`);

    // 9. owner session WITH header → works. Toggle twice so the roadmap row
    //    is left exactly as we found it.
    const withHeader = await fetch(BASE + '/admin/toggle-roadmap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sAdmin.cookie, 'x-csrf-token': sAdmin.token, 'connection': 'close' },
      body: JSON.stringify({ id: row.id }),
    });
    const j1 = await withHeader.json().catch(() => ({}));
    const restored = await fetch(BASE + '/admin/toggle-roadmap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sAdmin.cookie, 'x-csrf-token': sAdmin.token, 'connection': 'close' },
      body: JSON.stringify({ id: row.id }),
    });
    const j2 = await restored.json().catch(() => ({}));
    check('/admin/toggle-roadmap WITH X-CSRF-Token works (200, flag flips)',
      withHeader.status === 200 && j1.done === 1 - row.done && restored.status === 200 && j2.done === row.done,
      `was ${row.done}, flip ${j1.done}, restored ${j2.done}`);

    // 10. logged-in non-owner WITH a valid token → the admin gate rejects
    const notAdmin = await fetch(BASE + '/admin/toggle-roadmap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sUser.cookie, 'x-csrf-token': sUser.token, 'connection': 'close' },
      body: JSON.stringify({ id: row.id }),
    });
    const naText = await notAdmin.text();
    check('/admin/toggle-roadmap rejects a non-owner, even with a valid token (403)',
      notAdmin.status === 403 && /Not admin/.test(naText), `got ${notAdmin.status}`);
  }

  // 11–12. legacy SHA-256 account: can still log in, and gets upgraded
  {
    const legacyPass = 'oldpass123';
    const sha = createHash('sha256').update(legacyPass).digest('hex');
    const d = new DatabaseSync(DB_PATH);
    d.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(LEGACY_USER, sha);
    d.close();

    const s = await newSession();
    const res = await postForm('/login', s, { username: LEGACY_USER, password: legacyPass });
    const html = await res.text();
    check('legacy SHA-256 account can still log in', /Login successful/.test(html), `status ${res.status}`);

    const hash = storedHash(LEGACY_USER);
    check('…and its hash was transparently upgraded to BCRYPT', Boolean(hash) && hash.startsWith('$2'),
      hash ? hash.slice(0, 12) + '…' : 'no row found');
  }

  // 13. rate limiting: keep failing until the server says "slow down" (429).
  //     A fresh spawn guarantees the in-memory counter starts at zero.
  {
    let saw429 = false, attempts = 0;
    for (let i = 0; i < 8 && !saw429; i++) {
      const s = await newSession();
      const res = await postForm('/login', s, { username: USER, password: 'definitely-wrong-' + i });
      attempts++;
      if (res.status === 429) { saw429 = true; break; }
    }
    check('login attempts are rate-limited (429 appears)', saw429, `after ${attempts} wrong attempts`);
  }

} catch (e) {
  check('test infrastructure (server boot / ready)', false, e.message);
} finally {
  try { child.kill(); } catch { /* already gone */ }
}

console.log(failures === 0 ? '\nAll A1 checks passed ✅' : `\n${failures} check(s) FAILED ❌`);
process.exitCode = failures === 0 ? 0 : 1;
// Safety net: if something still holds the loop open (a live socket), force
// exit after a generous delay. The natural path should finish long before
// this fires; the timer is unref()'d so it never, by itself, keeps the
// process alive. (See test-a2-subscriptions.mjs for the Windows story.)
setTimeout(() => { try { process.exit(process.exitCode); } catch { /* noop */ } }, 8000).unref();
