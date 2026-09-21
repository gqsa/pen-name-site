// A2 tests — recurring membership (PayPal Subscriptions + signed webhooks).
//
// Run:  node test-a2-subscriptions.mjs
//
// Everything is OFFLINE and side-effect-free:
//   - We generate our OWN RSA keypair and sign webhook events the exact way
//     PayPal does, then verify them with the SAME code the server uses.
//   - The state machine is exercised on an in-memory SQLite database.
//   - The final section talks to a LIVE server (default http://localhost:3000)
//     ONLY with requests that change nothing: it confirms the webhook route
//     exists, rejects a forged signature, and that /membership-status needs a
//     session. Start the server first if you want that section to run; it is
//     SKIPPED (not failed) if the server isn't up.
//
// No network to PayPal, no real money, no account created on the live server.

import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  verifyPaypalWebhook,
  processPaypalWebhook,
  applyMembershipEvent,
  reprocessPendingWebhooks,
} from './paypal-subscriptions.js';

let failures = 0;
const openDbs = []; // track in-memory DBs so we can close them before exit
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  —  ' + extra : ''}`);
  if (!ok) failures++;
}
const section = (t) => console.log(`\n=== ${t} ===`);

// --- our "PayPal": a generated keypair + a fake cert endpoint ----------------
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certPem = publicKey.export({ type: 'spki', format: 'pem' });
const FAKE_CERT_URL = 'https://fake.invalid/cert.pem';
const fakeCertFetch = async () => ({ ok: true, text: async () => certPem });
const WEBHOOK_ID = 'TEST-WEBHOOK-ID';

// Sign exactly the way PayPal does (mirrors verifyPaypalWebhook's algorithm):
//   verificationString = id|time|webhookId|hex(sha256(body))
function signBody(body, webhookId, transmissionId, timeStr, key = privateKey) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const verificationString = `${transmissionId}|${timeStr}|${webhookId}|${bodyHash}`;
  return createSign('RSA-SHA256').update(verificationString).sign(key, 'hex');
}
function headersFor(body, { webhookId = WEBHOOK_ID, timeStr, key = privateKey, transmissionId = 'tx-1', drop = null } = {}) {
  const t = timeStr || new Date().toISOString();
  const h = {
    'paypal-transmission-id': transmissionId,
    'paypal-transmission-time': t,
    'paypal-cert-url': FAKE_CERT_URL,
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': signBody(body, webhookId, transmissionId, t, key),
  };
  if (drop) delete h[drop];
  return h;
}

const ACTIVATED = {
  id: 'WH-test-1',
  event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
  resource: { id: 'I-test-sub', custom_id: '1' },
};
const activatedBody = JSON.stringify(ACTIVATED);

// ===========================================================================
section('1. Signature verification (real RSA, offline)');
{
  const now = Date.now();
  const timeStr = new Date(now).toISOString();

  const v1 = await verifyPaypalWebhook({
    headers: headersFor(activatedBody, { timeStr }), rawBody: activatedBody, webhookId: WEBHOOK_ID, now, fetchCertImpl: fakeCertFetch,
  });
  check('genuine signature is accepted', v1.valid === true, v1.reason || '');

  const v2 = await verifyPaypalWebhook({
    headers: headersFor(activatedBody, { timeStr }),
    rawBody: activatedBody.replace('"custom_id":"1"', '"custom_id":"999"'), // attacker tampers with the body
    webhookId: WEBHOOK_ID, now, fetchCertImpl: fakeCertFetch,
  });
  check('tampered body is rejected', v2.valid === false, v2.reason || 'signature mismatch');

  const staleTime = new Date(now - 2 * 3600 * 1000).toISOString(); // 2h old
  const v3 = await verifyPaypalWebhook({
    headers: headersFor(activatedBody, { timeStr: staleTime }), rawBody: activatedBody, webhookId: WEBHOOK_ID, now, fetchCertImpl: fakeCertFetch,
  });
  check('stale timestamp (replay) is rejected', v3.valid === false, v3.reason || '');

  const v4 = await verifyPaypalWebhook({
    headers: headersFor(activatedBody, { timeStr }), rawBody: activatedBody, webhookId: 'SOME-OTHER-WEBHOOK', now, fetchCertImpl: fakeCertFetch,
  });
  check('wrong webhook id is rejected', v4.valid === false, v4.reason || 'signature mismatch');

  const v5 = await verifyPaypalWebhook({
    headers: headersFor(activatedBody, { timeStr, drop: 'paypal-transmission-sig' }),
    rawBody: activatedBody, webhookId: WEBHOOK_ID, now, fetchCertImpl: fakeCertFetch,
  });
  check('missing signature header is rejected', v5.valid === false, v5.reason || '');
}

// ===========================================================================
section('2. Membership state machine (in-memory DB)');
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      member INTEGER DEFAULT 0,
      email TEXT,
      paypal_subscription_id TEXT,
      membership_status TEXT DEFAULT 'free',
      member_since INTEGER
    );
    CREATE TABLE paypal_webhook_events (
      event_id TEXT PRIMARY KEY, event_type TEXT, payload TEXT,
      received_at INTEGER, status TEXT DEFAULT 'received', note TEXT
    );
    CREATE TABLE paypal_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  d.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run('alice', 'x');
  openDbs.push(d);
  return d;
}
const ev = (id, type, customId, subId) => ({ id, event_type: type, resource: { id: subId, custom_id: customId } });

{
  const d = makeDb();
  const user = () => d.prepare('SELECT * FROM users WHERE id = 1').get();

  const r1 = applyMembershipEvent(d, ev('WH-1', 'BILLING.SUBSCRIPTION.ACTIVATED', '1', 'I-100'));
  check('ACTIVATED grants membership', r1.applied === true && user().member === 1 && user().membership_status === 'active' && user().paypal_subscription_id === 'I-100');

  const r2 = applyMembershipEvent(d, ev('WH-1', 'BILLING.SUBSCRIPTION.ACTIVATED', '1', 'I-100'));
  check('replaying the same event is idempotent', r2.applied === true && user().member === 1 && user().membership_status === 'active');

  applyMembershipEvent(d, ev('WH-2', 'BILLING.SUBSCRIPTION.SUSPENDED', '1', 'I-100'));
  check('SUSPENDED (payment failed) revokes access', user().member === 0 && user().membership_status === 'suspended');

  applyMembershipEvent(d, ev('WH-3', 'BILLING.SUBSCRIPTION.REINSTATED', '1', 'I-100'));
  check('REINSTATED restores access', user().member === 1 && user().membership_status === 'active');

  applyMembershipEvent(d, ev('WH-4', 'BILLING.SUBSCRIPTION.CANCELLED', '1', 'I-100'));
  check('CANCELLED revokes access', user().member === 0 && user().membership_status === 'cancelled');

  const rIgn = applyMembershipEvent(d, ev('WH-5', 'BILLING.PAYMENT.SALE.COMPLETED', '1', 'I-100'));
  check('unknown event type is ignored (no state change)', rIgn.ignored === true);

  const rNoUser = applyMembershipEvent(d, ev('WH-6', 'BILLING.SUBSCRIPTION.ACTIVATED', '9999', 'I-999'));
  check('event for an unknown user is skipped, no crash', rNoUser.skipped === true);
}

// ===========================================================================
section('3. Full webhook pipeline (verify -> dedupe -> apply)');
{
  const d = makeDb();
  async function signedPost(eventObj) {
    const body = JSON.stringify(eventObj);
    const t = new Date().toISOString();
    const headers = headersFor(body, { timeStr: t, transmissionId: 'tx-pipe' });
    return processPaypalWebhook(d, { headers, rawBody: body, webhookId: WEBHOOK_ID, fetchCertImpl: fakeCertFetch });
  }

  const member = () => d.prepare('SELECT member, membership_status FROM users WHERE id = 1').get();

  const p1 = await signedPost({ id: 'WH-E2E-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-200', custom_id: '1' } });
  check('signed event is processed and grants membership', p1.accepted === true && p1.stage === 'processed' && member().member === 1, p1.outcome ? JSON.stringify(p1.outcome) : '');

  const p2 = await signedPost({ id: 'WH-E2E-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-200', custom_id: '1' } });
  check('duplicate event id is reported as duplicate (idempotent)', p2.accepted === true && p2.stage === 'duplicate');

  // Forged: a DIFFERENT key signs it. Must be rejected, state untouched.
  const { privateKey: evilKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forgedBody = JSON.stringify({ id: 'WH-FORGED', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-666', custom_id: '1' } });
  const forgedHeaders = headersFor(forgedBody, { key: evilKey, transmissionId: 'tx-evil' });
  const p3 = await processPaypalWebhook(d, { headers: forgedHeaders, rawBody: forgedBody, webhookId: WEBHOOK_ID, fetchCertImpl: fakeCertFetch });
  check('forged signature is rejected and state is untouched', p3.accepted === false && member().member === 1 && member().membership_status === 'active', p3.reason || '');
}

// ===========================================================================
section('4. Crash recovery (reprocess pending events)');
{
  const d = makeDb();
  const payload = JSON.stringify({ id: 'WH-REC-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-300', custom_id: '1' } });
  d.prepare("INSERT INTO paypal_webhook_events (event_id, event_type, payload, received_at, status) VALUES ('WH-REC-1', 'BILLING.SUBSCRIPTION.ACTIVATED', ?, 123, 'received')").run(payload);

  const n = reprocessPendingWebhooks(d);
  const row = d.prepare("SELECT status FROM paypal_webhook_events WHERE event_id = 'WH-REC-1'").get();
  const member = d.prepare('SELECT member FROM users WHERE id = 1').get();
  check('pending event is replayed, applied, and marked processed',
    n === 1 && member.member === 1 && row.status === 'processed', `reprocessed=${n}, member=${member.member}, status=${row.status}`);
}

// ===========================================================================
section('5. Live server (optional — safe, no state change)');
{
  const BASE = process.env.TEST_URL || 'http://localhost:3000';
  // `connection: close` on every live request: undici otherwise keeps a
  // keep-alive socket open, and on Windows `process.exit()` with a live
  // socket trips a libuv assertion (win/async.c) that clobbers the exit code.
  const CLOSE = { headers: { connection: 'close' } };
  let reachable = false;
  try {
    const r = await fetch(BASE + '/', { ...CLOSE, signal: AbortSignal.timeout(1500) });
    reachable = r.status < 500;
  } catch { reachable = false; }

  if (!reachable) {
    console.log('SKIP  live server not reachable at ' + BASE + ' (start it with: node server.js)');
  } else {
    // 5a: the webhook route exists and REJECTS a forged signature.
    const forgedBody = JSON.stringify({ id: 'WH-LIVE-FORGED', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-live', custom_id: '1' } });
    const forgedHeaders = headersFor(forgedBody, { transmissionId: 'tx-live-evil' }); // signed by our key, not PayPal's
    let forgedStatus = 0, forgedText = '';
    try {
      const r = await fetch(BASE + '/paypal-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', connection: 'close', ...forgedHeaders },
        body: forgedBody,
        signal: AbortSignal.timeout(3000),
      });
      forgedStatus = r.status; forgedText = (await r.text()).slice(0, 120);
    } catch (e) { forgedText = String(e); }
    check('live /paypal-webhook rejects a forged signature (4xx)', forgedStatus >= 400 && forgedStatus < 500, `status=${forgedStatus} ${forgedText}`);

    // 5b: /membership-status exists and requires a session.
    let statusRes = 0;
    try {
      const r = await fetch(BASE + '/membership-status', { ...CLOSE, signal: AbortSignal.timeout(3000) });
      statusRes = r.status;
    } catch (e) { /* leave 0 */ }
    check('live /membership-status exists and requires login (401)', statusRes === 401, `status=${statusRes}`);
  }
}

// ===========================================================================
console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}`);

// Close the in-memory DBs, set the exit code, and let the process exit
// NATURALLY (drain the event loop) instead of an abrupt process.exit().
// On Windows, exiting abruptly while network handles (the live section's
// fetch sockets) are still open trips a libuv assertion (win/async.c:94)
// that crashes the process and clobbers the exit code. A natural exit lets
// those handles close first, so the exit code stays accurate.
for (const d of openDbs) { try { d.close(); } catch { /* already closed */ } }
process.exitCode = failures === 0 ? 0 : 1;
// Safety net: if something still holds the loop open, force-exit after a
// generous delay. The natural path should finish long before this fires; the
// timer is unref()'d so it never, by itself, keeps the process alive.
setTimeout(() => { try { process.exit(process.exitCode); } catch { /* noop */ } }, 8000).unref();
