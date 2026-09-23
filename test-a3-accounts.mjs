// A3 accounts & email verification — SELF-CONTAINED.
//
// HOW TO RUN:
//   node test-a3-accounts.mjs
//
// Spawns its OWN server(s) on free ports with a controlled environment
// (EMAIL_TRANSPORT=file writing to a scratch outbox, a known ADMIN_USERNAME,
// and LOGIN_MAX_ATTEMPTS raised — A1's suite owns the rate-limiter check with
// its own fresh server; this suite exercises the A3 flows instead), runs the
// checks, then kills them and cleans the scratch outbox.
//
// WHAT IT PROVES (server #1, EMAIL_REQUIRED off):
//   1.  register with NO email still works (the "optional for now" state) — stored NULL
//   2.  register WITH an email stores it (normalized to lowercase)
//   3.  an INVALID email is rejected and nothing is stored
//   4.  /settings requires a login (guest → "Please login first")
//   5.  /settings renders for a logged-in user, showing their email + the switch
//   6.  the email + notification switch save (DB email_notifications = 0, unchecked)
//   7.  an invalid email in /settings is rejected, the old one kept
//   8.  change-password with the WRONG current password fails; old password still logs in
//   9.  change-password with the right current password works; new logs in, old doesn't
//  10.  forgot-password sends a reset link through the ONE pathway (outbox +1, link extractable)
//  11.  forgot-password for an unknown account answers identically AND sends nothing
//       (no account-enumeration oracle)
//  12.  the reset link works: set a new password (old one stops working)
//  13.  the reset token is SINGLE-USE (replaying it is refused)
//  14.  /admin renders the "Member announcements" panel for the owner
//  15.  /admin/notify blasts exactly the eligible accounts (counts match the DB),
//       the opted-out one is NOT emailed, and the mail is in the outbox
//  16.  /admin/notify rejects a logged-in NON-owner (403)
// (server #2, EMAIL_REQUIRED=true):
//  17.  registering with a BLANK email is refused  ← the flip-is-the-migration
//  18.  …and with a valid email it still succeeds
//
// NOTE: the spawned servers share the repo's database.db (A1 house style):
// accounts here are ts-suffixed throwaways; the only other writes are the
// A3 migrations themselves (idempotent). The scratch outbox is deleted.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'database.db');
const OUTBOX = path.join(__dirname, '.mailoutbox-a3-test.json');
rmSync(OUTBOX, { force: true }); // start from an empty outbox

// `connection: close` on every request (A1's note: Windows + abrupt exit + a
// live keep-alive socket trips a libuv assertion that clobbers the exit code).
const CLOSE = { headers: { connection: 'close' } };

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
  if (!ok) failures++;
}

const ts = Date.now();
const NOEMAIL = `a3noemail${ts}`;  // registers without an email (the "optional" state)
const MAIL = `a3mail${ts}`;        // email + later opts OUT of notifications
const BLAST = `a3blast${ts}`;      // email + notifications ON — the blast target
const BAD = `a3bad${ts}`;          // invalid email — must never be stored
const ADMIN = `a3admin${ts}`;      // matches the spawned server's ADMIN_USERNAME
const PASS = 'S3cret!pass';
const MAIL_ADDR = `a3mail${ts}@example.com`;
const BLAST_ADDR = `a3blast${ts}@example.com`;
const BLAST_SUBJECT = `A3 TEST BLAST ${ts}`;

// --- shared helpers ----------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function spawnServer(base, port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    // stdio 'inherit' (not 'pipe'): the DSH sandbox denies named-pipe stdio to
    // children with EPERM; inherit works everywhere (see the A1 test note).
    env: {
      ...process.env,
      PORT: String(port), // the FREE port we picked — without this it falls back to 3000
      SESSION_SECRET: 'a3-test-secret',
      APP_URL: base, // reset links must point at THIS test server's port
      EMAIL_TRANSPORT: 'file',
      EMAIL_FILE_PATH: OUTBOX,
      // A1's suite owns the rate-limiter check (with its own fresh server);
      // this suite does more logins/forgot POSTs from one IP than the default
      // of 5 would allow — decouple, don't fight.
      LOGIN_MAX_ATTEMPTS: '1000',
      ...extraEnv,
    },
    stdio: 'inherit',
  });
  let code = null;
  child.on('exit', (c) => { code = c; });
  return { child, get code() { return code; } };
}

async function waitReady(base, server, deadlineMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (server.code !== null) throw new Error(`server exited early (code ${server.code})`);
    try {
      const r = await fetch(base + '/', CLOSE);
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready within ${deadlineMs}ms`);
}

function cookieOf(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

// Simulate a fresh browser visit: session cookie + the CSRF token from the
// server-rendered login page (A1's pattern).
async function newSession(base) {
  const boot = await fetch(base + '/', CLOSE);
  const cookie = cookieOf(boot);
  const loginPage = await fetch(base + '/login', { headers: { cookie } });
  const html = await loginPage.text();
  const m = html.match(/name="csrf" value="([a-f0-9]+)"/);
  return { cookie, token: m ? m[1] : null };
}

async function postForm(base, session, p, fields) {
  const body = new URLSearchParams({ ...fields, csrf: session.token }).toString();
  return fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie, 'connection': 'close' },
    body,
  });
}

function dbGet(sql, ...args) {
  const d = new DatabaseSync(DB_PATH);
  const r = d.prepare(sql).get(...args);
  d.close();
  return r;
}
function dbRun(sql, ...args) {
  const d = new DatabaseSync(DB_PATH);
  const r = d.prepare(sql).run(...args);
  d.close();
  return r;
}

function readOutbox() {
  try { return JSON.parse(readFileSync(OUTBOX, 'utf8')); } catch { return []; }
}

try {
  // ================= SERVER #1 — EMAIL_REQUIRED=false (the default) =========
  const port1 = await freePort();
  const base1 = `http://localhost:${port1}`;
  const s1 = spawnServer(base1, port1, { ADMIN_USERNAME: ADMIN, ADMIN_PASSWORD: PASS, EMAIL_REQUIRED: 'false' });
  await waitReady(base1, s1);

  console.log('== A3 checks (server #1: email optional for now) ==\n');

  // 1. register with NO email — still allowed (the "optional for now" state)
  {
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/register', { username: NOEMAIL, password: PASS });
    const html = await res.text();
    const row = dbGet('SELECT email FROM users WHERE username = ?', NOEMAIL);
    check('register without an email works (EMAIL_REQUIRED off) and stores NULL',
      res.status === 200 && /Registration successful/.test(html) && row && row.email === null,
      `status ${res.status}, db email=${row ? String(row.email) : 'no row'}`);
  }

  // 2. register WITH an email — stored, normalized to lowercase
  {
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/register', { username: MAIL, password: PASS, email: `A3MAIL${ts}@EXAMPLE.COM` });
    const html = await res.text();
    const row = dbGet('SELECT email FROM users WHERE username = ?', MAIL);
    check('register with an email stores it (lowercased)',
      res.status === 200 && /Registration successful/.test(html) && row && row.email === MAIL_ADDR,
      `db email=${row ? row.email : 'no row'}`);
  }

  // 3. register with an INVALID email — rejected, nothing stored
  {
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/register', { username: BAD, password: PASS, email: 'not-an-email' });
    const html = await res.text();
    const row = dbGet('SELECT 1 FROM users WHERE username = ?', BAD);
    check('an invalid email is rejected and no account is created',
      res.status === 200 && /look right/i.test(html) && !row,
      `status ${res.status}`);
  }

  // 4. /settings requires a login
  {
    const boot = await fetch(base1 + '/', CLOSE);
    const res = await fetch(base1 + '/settings', { headers: { cookie: cookieOf(boot), 'connection': 'close' } });
    const html = await res.text();
    check('/settings requires a login ("Please login first")', /Please login first/.test(html));
  }

  // 5. /settings renders for the logged-in user (email + the switch)
  let sMail;
  {
    const s = await newSession(base1);
    const login = await postForm(base1, s, '/login', { username: MAIL, password: PASS });
    const ok = /Login successful/.test(await login.text());
    sMail = s;
    const res = await fetch(base1 + '/settings', { headers: { cookie: s.cookie, 'connection': 'close' } });
    const html = await res.text();
    check('/settings renders for the user (email + announcement switch shown)',
      ok && res.status === 200 && html.includes(MAIL_ADDR) && /Send me email announcements/.test(html),
      `login ok=${ok}, status ${res.status}`);
  }

  // 6. saving /settings persists email + the opt-out switch
  {
    const res = await postForm(base1, sMail, '/settings', { email: MAIL_ADDR, email_notifications: 'off' });
    const html = await res.text();
    const row = dbGet('SELECT email, email_notifications FROM users WHERE username = ?', MAIL);
    const page = await fetch(base1 + '/settings', { headers: { cookie: sMail.cookie, 'connection': 'close' } });
    const pageHtml = await page.text();
    const unchecked = !/value="on"[\s\S]{0,40}checked/.test(pageHtml);
    check('/settings saves: email kept + notifications OFF (DB + unchecked box)',
      /Settings saved/.test(html) && row && row.email === MAIL_ADDR && Number(row.email_notifications) === 0 && unchecked,
      `db=${row ? row.email + '/' + row.email_notifications : 'no row'}`);
  }

  // 7. an invalid email in /settings is rejected; the old one is kept
  {
    const res = await postForm(base1, sMail, '/settings', { email: 'nope', email_notifications: 'off' });
    const html = await res.text();
    const row = dbGet('SELECT email FROM users WHERE username = ?', MAIL);
    check('/settings rejects an invalid email (old one kept)',
      /look right/i.test(html) && row && row.email === MAIL_ADDR,
      `db email=${row ? row.email : 'no row'}`);
  }

  // 8. change-password with the WRONG current password fails; old password still works
  //    (the route is session-gated — you must be logged in as the account first)
  {
    const s = await newSession(base1);
    await postForm(base1, s, '/login', { username: NOEMAIL, password: PASS }); // now logged in as NOEMAIL
    const res = await postForm(base1, s, '/change-password', {
      current_password: 'definitely-wrong', new_password: 'a3newpass1', confirm_password: 'a3newpass1',
    });
    const html = await res.text();
    const s2 = await newSession(base1);
    const relogin = await postForm(base1, s2, '/login', { username: NOEMAIL, password: PASS });
    const reloginHtml = await relogin.text();
    check('change-password refuses a wrong current password (old one still logs in)',
      /current password is wrong/i.test(html) && /Login successful/.test(reloginHtml));
  }

  // 9. change-password with the RIGHT current password works
  {
    const s = await newSession(base1);
    await postForm(base1, s, '/login', { username: NOEMAIL, password: PASS }); // logged in as NOEMAIL (old password)
    const res = await postForm(base1, s, '/change-password', {
      current_password: PASS, new_password: 'a3newpass1', confirm_password: 'a3newpass1',
    });
    const html = await res.text();
    const s2 = await newSession(base1);
    const withNew = await postForm(base1, s2, '/login', { username: NOEMAIL, password: 'a3newpass1' });
    const newWorks = /Login successful/.test(await withNew.text());
    const s3 = await newSession(base1);
    const withOld = await postForm(base1, s3, '/login', { username: NOEMAIL, password: PASS });
    const oldDead = /Login failed/.test(await withOld.text());
    check('change-password: new password logs in, the old one is dead',
      /Password updated/.test(html) && newWorks && oldDead, `newWorks=${newWorks} oldDead=${oldDead}`);
  }

  // 10. forgot-password sends a reset link through the ONE pathway
  let resetToken = null;
  {
    const before = readOutbox().length;
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/forgot-password', { username: MAIL });
    const html = await res.text();
    const box = readOutbox();
    const last = box[box.length - 1];
    const m = last && last.html ? last.html.match(/reset-password\?token=([0-9a-f]{64})/) : null;
    resetToken = m ? m[1] : null;
    check('forgot-password emails the reset link (outbox +1, link extractable)',
      /If that account exists/.test(html) && box.length === before + 1
        && last && last.to === MAIL_ADDR && Boolean(resetToken),
      `outbox ${before} -> ${box.length}`);
  }

  // 11. unknown account: same generic message, and NO mail goes out
  {
    const before = readOutbox().length;
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/forgot-password', { username: `nosuchuser${ts}` });
    const html = await res.text();
    const box = readOutbox();
    check('forgot-password for an unknown account is generic AND sends nothing (no enumeration oracle)',
      /If that account exists/.test(html) && box.length === before,
      `outbox ${before} -> ${box.length}`);
  }

  // 12. the reset link sets a new password
  {
    const page = await fetch(base1 + `/reset-password?token=${resetToken}`, { headers: { ...CLOSE } });
    const pageHtml = await page.text();
    const formOk = page.status === 200 && /Choose a new password/.test(pageHtml)
      && pageHtml.includes(`name="token" value="${resetToken}"`);
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/reset-password', { token: resetToken, password: 'a3resetpass1', password2: 'a3resetpass1' });
    const html = await res.text();
    const s2 = await newSession(base1);
    const withNew = await postForm(base1, s2, '/login', { username: MAIL, password: 'a3resetpass1' });
    const newWorks = /Login successful/.test(await withNew.text());
    const s3 = await newSession(base1);
    const withOld = await postForm(base1, s3, '/login', { username: MAIL, password: PASS });
    const oldDead = /Login failed/.test(await withOld.text());
    check('the reset link works: new password set, old one dead',
      formOk && /Password updated/.test(html) && newWorks && oldDead,
      `formOk=${formOk} newWorks=${newWorks} oldDead=${oldDead}`);
  }

  // 13. the reset token is single-use
  {
    const s = await newSession(base1);
    const res = await postForm(base1, s, '/reset-password', { token: resetToken, password: 'a3resetpass2', password2: 'a3resetpass2' });
    const html = await res.text();
    check('a used reset token is refused (single-use)', /no longer valid/.test(html));
  }

  // 14. /admin shows the Member announcements panel to the owner
  let sAdmin;
  {
    const s = await newSession(base1);
    const login = await postForm(base1, s, '/login', { username: ADMIN, password: PASS });
    const ok = /Login successful/.test(await login.text());
    sAdmin = s;
    if (!ok) throw new Error('admin login failed — the boot-seed did not create the account');
    const res = await fetch(base1 + '/admin', { headers: { cookie: s.cookie, 'connection': 'close' } });
    const html = await res.text();
    check('/admin renders the "Member announcements" panel for the owner',
      res.status === 200 && /Member announcements/.test(html) && /Send to members/.test(html),
      `status ${res.status}`);
  }

  // 15. the blast reaches EXACTLY the eligible accounts (counts straight from the DB)
  {
    // BLAST user: email + notifications ON (never toggled off — check 6 used MAIL).
    const s = await newSession(base1);
    const reg = await postForm(base1, s, '/register', { username: BLAST, password: PASS, email: `A3BLAST${ts}@EXAMPLE.COM` });
    const regOk = /Registration successful/.test(await reg.text());

    const expected = {
      sent: dbGet("SELECT COUNT(*) c FROM users WHERE email IS NOT NULL AND email <> '' AND (email_notifications IS NULL OR email_notifications = 1)").c,
      optedOut: dbGet("SELECT COUNT(*) c FROM users WHERE email IS NOT NULL AND email <> '' AND email_notifications = 0").c,
      noEmail: dbGet("SELECT COUNT(*) c FROM users WHERE email IS NULL OR email = ''").c,
    };
    const before = readOutbox().length;
    const res = await fetch(base1 + '/admin/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sAdmin.cookie, 'x-csrf-token': sAdmin.token, 'connection': 'close' },
      body: JSON.stringify({ subject: BLAST_SUBJECT, html: '<p>A3 test announcement.</p>' }),
    });
    const j = await res.json().catch(() => ({}));
    const box = readOutbox();
    const blasts = box.filter(e => e.subject === BLAST_SUBJECT);
    const toBlast = blasts.filter(e => e.to === BLAST_ADDR).length;
    const toMail = blasts.filter(e => e.to === MAIL_ADDR).length; // opted out → must be 0
    check('blast: JSON counts match the DB, the eligible one got it, the opted-out one did not',
      regOk && res.status === 200 && j.success === true
        && j.sent === expected.sent && j.optedOut === expected.optedOut && j.noEmail === expected.noEmail
        && box.length === before + expected.sent
        && toBlast === 1 && toMail === 0,
      `sent=${j.sent}/${expected.sent} optedOut=${j.optedOut}/${expected.optedOut} noEmail=${j.noEmail}/${expected.noEmail} toBlast=${toBlast} toMail=${toMail}`);
  }

  // 16. the blast endpoint is admin-only (a valid CSRF token from a non-owner is not enough)
  {
    const res = await fetch(base1 + '/admin/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sMail.cookie, 'x-csrf-token': sMail.token, 'connection': 'close' },
      body: JSON.stringify({ subject: 'should never send', html: '<p>x</p>' }),
    });
    const text = await res.text();
    check('/admin/notify rejects a logged-in non-owner (403, "Not admin")',
      res.status === 403 && /Not admin/.test(text), `got ${res.status}`);
  }

  try { s1.child.kill(); } catch { /* already gone */ }

  // ================= SERVER #2 — EMAIL_REQUIRED=true (the end state) ========
  const port2 = await freePort();
  const base2 = `http://localhost:${port2}`;
  const s2s = spawnServer(base2, port2, { ADMIN_USERNAME: ADMIN, ADMIN_PASSWORD: PASS, EMAIL_REQUIRED: 'true' });
  await waitReady(base2, s2s);

  console.log('\n== A3 checks (server #2: email REQUIRED — the end state) ==\n');

  // 17. a blank email is refused
  {
    const s = await newSession(base2);
    const res = await postForm(base2, s, '/register', { username: `a3req${ts}`, password: PASS });
    const html = await res.text();
    const row = dbGet('SELECT 1 FROM users WHERE username = ?', `a3req${ts}`);
    check('EMAIL_REQUIRED=true: registering without an email is refused',
      /email is required/i.test(html) && !row, `status ${res.status}`);
  }

  // 18. …and a valid email still registers fine
  {
    const s = await newSession(base2);
    const res = await postForm(base2, s, '/register', { username: `a3ok${ts}`, password: PASS, email: `a3ok${ts}@example.com` });
    const html = await res.text();
    check('EMAIL_REQUIRED=true: a valid email still registers',
      /Registration successful/.test(html), `status ${res.status}`);
  }

  try { s2s.child.kill(); } catch { /* already gone */ }

} catch (e) {
  check('test infrastructure (server boot / ready)', false, e.message);
} finally {
  rmSync(OUTBOX, { force: true }); // scratch artifact — never committed (.gitignore)
}

console.log(failures === 0 ? '\nAll A3 checks passed ✅' : `\n${failures} check(s) FAILED ❌`);
process.exitCode = failures === 0 ? 0 : 1;
// A1's safety net: force-exit if a live socket keeps the loop alive.
setTimeout(() => { try { process.exit(process.exitCode); } catch { /* noop */ } }, 8000).unref();
