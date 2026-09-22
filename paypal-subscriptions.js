// A2: PayPal recurring billing (Subscriptions) — the heart of the membership model.
//
// This file has two halves, and they are deliberately separated:
//
//   OUTBOUND  — our server calling the PayPal REST API: OAuth token, create
//               product, create plan, create subscription, cancel subscription.
//
//   INBOUND   — PayPal calling US: webhook signature verification + applying
//               membership state changes to our database.
//
// WHY the INBOUND half is the source of truth:
//   The /paypal-return page the browser lands on can be closed, faked, or
//   ignored. The signed webhook from PayPal's servers is the only message we
//   trust when granting or revoking membership. This is the Step-9 lesson
//   ("never trust the client to say 'I paid'") upgraded to the recurring
//   billing version of itself: membership follows the subscription's signed
//   lifecycle (activated / suspended / cancelled / reinstated), nothing else.
//
// No new dependencies: raw fetch + node:crypto (RSA signature verification).

import { createHash, createVerify } from 'node:crypto';
import {
  PAYPAL_BASE_URL,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  SUBSCRIPTION_NAME,
  SUBSCRIPTION_PRICE,
  SUBSCRIPTION_CURRENCY,
  SUBSCRIPTION_PERIOD,
  RETURN_URL,
  CANCEL_URL,
} from './paypal-config.js';

// ---------------------------------------------------------------------------
// OUTBOUND: our server -> PayPal REST API
// ---------------------------------------------------------------------------

// PayPal's access tokens are scoped to the client credentials and live ~1h.
// We cache one per process instead of minting a new one per request.
let cachedToken = null;
let tokenExpiresAt = 0;

export async function getPaypalToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken; // 1 min safety margin
  // AUTH TRANSPORT: the credentials go in the standard OAuth2
  // `Authorization: Basic` header (RFC 6749 §2.3.1), NOT in the form body.
  // Measured against our sandbox app: body-embedded credentials -> 401
  // invalid_client; the Basic header -> 200 + token. (Header is also the
  // method PayPal's own SDKs use, so it stays portable to the live API.)
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token failed: ${data.message || data.error || 'HTTP ' + res.status}`);
  }
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// Small key/value store for PayPal-side ids we create (product, plan).
// Stored in the DB (paypal_meta) so a restart never creates a second product.
function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM paypal_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function metaSet(db, key, value) {
  db.prepare('INSERT INTO paypal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Ensure a catalog product exists and return its id.
// (Verified against PayPal's OpenAPI spec: POST /v1/catalogs/products
//  requires only `name` and `type`.)
export async function ensureProduct(db) {
  const existing = metaGet(db, 'product_id');
  if (existing) return existing;
  const token = await getPaypalToken();
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/catalogs/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: SUBSCRIPTION_NAME,
      type: 'SERVICE', // it's an access subscription, not a physical/digital good
      description: 'Recurring membership for the gqsa site',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(`product failed: ${data.message || 'HTTP ' + res.status}`);
  metaSet(db, 'product_id', data.id);
  return data.id;
}

// Ensure a billing plan exists and return its id.
// (Verified against the spec: POST /v1/billing/plans requires
//  `name`, `billing_cycles`, `payment_preferences`, `product_id`.)
//
// Self-healing: the plan id cached in paypal_meta is only good while the plan
// is ACTIVE and actually recurring. PayPal silently defaults `total_cycles`
// to 1 when it is omitted — that builds a ONE-SHOT plan (the subscription
// expires right after the first payment; we hit this live: our first plan
// had exactly that shape). `0` is the spec's "runs forever" value. If the
// cached plan fails this check, we create a proper recurring one and retire
// the old one, so no manual DB surgery is ever needed.
export async function ensurePlan(db) {
  const existing = metaGet(db, 'plan_id');
  if (existing) {
    try {
      const token = await getPaypalToken();
      const res = await fetch(`${PAYPAL_BASE_URL}/v1/billing/plans/${existing}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const plan = await res.json();
        const cycle = (plan.billing_cycles || [])[0] || {};
        if (plan.status === 'ACTIVE' && Number(cycle.total_cycles) === 0) return existing;
      }
    } catch { /* network hiccup — fall through and (re)create below */ }
  }
  const productId = await ensureProduct(db);
  const token = await getPaypalToken();
  const create = (name) => fetch(`${PAYPAL_BASE_URL}/v1/billing/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      product_id: productId,
      name,
      billing_cycles: [
        {
          sequence: 1, // first (and only) cycle; REGULAR tenure = no trial
          tenure_type: 'REGULAR',
          frequency: { interval_unit: SUBSCRIPTION_PERIOD, interval_count: 1 },
          // 0 = this cycle runs forever (spec: "Regular billing cycles can be
          // executed infinite times (value of 0)"). Omitting it defaults to 1
          // — a one-time charge. Never omit it.
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: SUBSCRIPTION_PRICE, currency_code: SUBSCRIPTION_CURRENCY },
          },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true },
      status: 'ACTIVE',
    }),
  });
  let res = await create(SUBSCRIPTION_NAME);
  let data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Some PayPal tenants reject a duplicate plan name under the same product
    // (the retired one-shot plan is still listed there). Retry once, distinct.
    res = await create(`${SUBSCRIPTION_NAME} (monthly)`);
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok || !data.id) throw new Error(`plan failed: ${data.message || data.debug_id || 'HTTP ' + res.status}`);
  metaSet(db, 'plan_id', data.id);
  if (existing && existing !== data.id) {
    // Best-effort: retire the replaced plan so the dashboard isn't cluttered.
    // (PayPal may refuse while it still has live subscriptions — non-fatal.)
    try {
      await fetch(`${PAYPAL_BASE_URL}/v1/billing/plans/${existing}/deactivate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* non-fatal */ }
  }
  return data.id;
}

// Create a subscription for a user. Returns the raw API response, which
// contains `links` — we pull the `approve` link and redirect the browser to
// it (that's the "Agree & Approve" step on PayPal's side).
export async function createSubscription(db, { userId, username, email }) {
  const planId = await ensurePlan(db);
  const token = await getPaypalToken();
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      plan_id: planId,
      // `custom_id` is our bridge back: the webhook events echo it, so we can
      // map any event to the exact user without trusting anything else.
      custom_id: String(userId),
      subscriber: {
        name: { given_name: username, surname: username },
        email_address: email, // PayPal needs an email to invoice the buyer
      },
      application_context: {
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`subscription failed: ${data.message || data.debug_id || 'HTTP ' + res.status}`);
  return data;
}

// Cancel a user's subscription.
//
// CORRECT ENDPOINT (verified against the live sandbox, 2026-09-22):
//   POST /v1/billing/subscriptions/{id}/cancel   -> 204, sub becomes CANCELLED
// The old `DELETE /v1/billing/subscriptions/{id}` returns 404 AND does NOT
// cancel anything (the sub stays ACTIVE) — that is exactly the "cancel failed:
// HTTP 404" the user hit, with their subscription still live and charging.
// PayPal also demands a JSON content-type on this POST (a bare POST is 415).
//
// After this returns, the sub is CANCELLED on PayPal's side. We ALSO flip the
// membership off locally (see /cancel-membership) instead of waiting for the
// CANCELLED webhook — the sandbox webhook path is unreliable, and a later
// genuine webhook is a harmless no-op (applyMembershipEvent is idempotent).
export async function cancelSubscription(subscriptionId) {
  const token = await getPaypalToken();
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`cancel failed: ${data.message || data.debug_id || 'HTTP ' + res.status}`);
  }
}

// A2 fallback (sandbox webhook workaround): fetch a subscription's CURRENT
// state directly from PayPal's API. The browser's return route calls this
// after the buyer approves and acts on the answer — no signed webhook
// required. Read-only and idempotent; the signed webhook stays the source of
// truth for revocation and remains fully armed.
export async function getSubscription(subscriptionId) {
  const token = await getPaypalToken();
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(`status failed: ${data.message || data.debug_id || 'HTTP ' + res.status}`);
  }
  return data;
}

// The return route's grant: PayPal's API said the subscription is ACTIVE, so
// apply exactly the same state change an ACTIVATED webhook event would.
// Synthesizing the event keeps ONE code path for every membership change
// (applyMembershipEvent is idempotent, so a later genuine webhook for the
// same subscription is a harmless no-op).
export function activateMembershipFromApi(db, { userId, subscriptionId }) {
  return applyMembershipEvent(db, {
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource: { id: subscriptionId, custom_id: String(userId) },
  });
}

// The cancel route's revoke: we just asked PayPal to cancel (and it
// confirmed), so apply exactly the same state change a CANCELLED webhook
// event would — without waiting for that webhook (unreliable in sandbox).
// Idempotency holds: a later genuine CANCELLED webhook is a harmless no-op.
export function cancelMembershipFromApi(db, { userId, subscriptionId }) {
  return applyMembershipEvent(db, {
    event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
    resource: { id: subscriptionId, custom_id: String(userId) },
  });
}

// ---------------------------------------------------------------------------
// INBOUND: PayPal -> our server (webhooks)
// ---------------------------------------------------------------------------

// The events that can change a user's membership, and what they mean.
// Everything else (e.g. BILLING.PAYMENT.SALE.COMPLETED) we ignore on purpose.
const MEMBERSHIP_EVENTS = {
  'BILLING.SUBSCRIPTION.ACTIVATED': 'active', // approved + first payment taken (or trial start)
  'BILLING.SUBSCRIPTION.APPROVED': 'active', // legacy event name for the same moment
  'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended', // payment failed; PayPal pauses billing
  'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled', // buyer (or we) cancelled
  'BILLING.SUBSCRIPTION.REINSTATED': 'active', // suspended sub got paid and resumed
  // The new Subscriptions API actually names the re-activation event
  // RE-ACTIVATED (verified against the webhook event list PayPal offers) —
  // this is the one that fires; REINSTATED above is kept as a legacy alias.
  'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'active', // suspended sub got paid and resumed (API's real name)
};

// Find the user a subscription event belongs to, via the two bridges we
// control: our subscription id (strongest) or the custom_id we set (numeric
// user id). We never trust the email alone — buyers can share accounts.
function findUserForEvent(db, event) {
  const res = event.resource || {};
  if (res.id) {
    const bySub = db.prepare('SELECT id, username FROM users WHERE paypal_subscription_id = ?').get(res.id);
    if (bySub) return bySub;
  }
  const customId = String(res.custom_id ?? '');
  if (/^\d+$/.test(customId)) {
    return db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(customId)) || null;
  }
  return null;
}

// Apply one verified webhook event to the users table.
// Idempotent: running the same event twice yields the same state. That's what
// makes PayPal's "retries until you return 2xx" policy safe for us.
export function applyMembershipEvent(db, event) {
  const type = event.event_type;
  const target = MEMBERSHIP_EVENTS[type];
  if (!target) return { ignored: true, reason: 'not a membership event', type };

  const user = findUserForEvent(db, event);
  if (!user) return { skipped: true, reason: 'no matching user', type };

  const res = event.resource || {};
  const subscriptionId = res.id || null;
  const now = Date.now();

  if (target === 'active') {
    db.prepare(
      `UPDATE users SET member = 1, membership_status = 'active',
       paypal_subscription_id = COALESCE(?, paypal_subscription_id),
       member_since = COALESCE(member_since, ?) WHERE id = ?`
    ).run(subscriptionId, now, user.id);
  } else {
    // suspended / cancelled -> access off immediately; we keep the sub id so
    // a later REINSTATED event (or re-join) can find the user again.
    db.prepare(
      `UPDATE users SET member = 0, membership_status = ?,
       paypal_subscription_id = COALESCE(?, paypal_subscription_id) WHERE id = ?`
    ).run(target, subscriptionId, user.id);
  }
  return { applied: true, type, status: target, userId: user.id };
}

// --- signature verification -------------------------------------------------
//
// PayPal signs every webhook with an RSA key whose certificate URL it hands
// us in the request. The algorithm (from PayPal's docs + the official SDK):
//   1. PAYPAL-TRANSMISSION-TIME must be within 5 minutes of now (replay guard)
//   2. bodyHash = hex(sha256(rawBody))
//   3. verificationString = transmissionId|transmissionTime|webhookId|bodyHash
//   4. fetch the PEM certificate from PAYPAL-CERT-URL
//   5. verify(verificationString, signature, cert) — signature arrives as hex
//
// We implement it with plain node:crypto (no SDK) so the whole thing stays
// inspectable, and make time/fetch injectable so tests can run fully offline.
const WEBHOOK_HEADER_NAMES = [
  'paypal-transmission-id',
  'paypal-transmission-time',
  'paypal-cert-url',
  'paypal-auth-algo',
  'paypal-transmission-sig',
];
const ALGO_TO_NODE = { 'SHA256withRSA': 'RSA-SHA256', 'SHA1withRSA': 'RSA-SHA1' };

const certCache = new Map(); // certUrl -> { pem, fetchedAt }
const CERT_TTL_MS = 3_600_000;
async function fetchCert(certUrl, fetchImpl) {
  const hit = certCache.get(certUrl);
  if (hit && Date.now() - hit.fetchedAt < CERT_TTL_MS) return hit.pem;
  const res = await fetchImpl(certUrl);
  if (!res.ok) throw new Error(`cert fetch HTTP ${res.status}`);
  const pem = await res.text();
  // Accept a certificate PEM (what PayPal serves) or a bare public-key PEM
  // (what offline tests generate) — createVerify() handles both. Anything
  // else (an HTML error page, for instance) is rejected here.
  if (!/BEGIN (CERTIFICATE|PUBLIC KEY)/.test(pem)) throw new Error('cert fetch: not a PEM certificate/key');
  certCache.set(certUrl, { pem, fetchedAt: Date.now() });
  return pem;
}

export async function verifyPaypalWebhook({ headers, rawBody, webhookId, now = Date.now(), fetchCertImpl = fetch, maxAgeMs = 300_000 }) {
  // Normalize to lowercase keys (Node already does this for http.IncomingMessage,
  // but tests may pass a plain object).
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;

  for (const name of WEBHOOK_HEADER_NAMES) {
    if (!h[name]) return { valid: false, reason: `missing header: ${name.toUpperCase()}` };
  }

  const transmissionId = h['paypal-transmission-id'];
  const transmissionTime = h['paypal-transmission-time'];
  const certUrl = h['paypal-cert-url'];
  const algo = h['paypal-auth-algo'];
  const signature = h['paypal-transmission-sig'];

  const t = Date.parse(transmissionTime);
  if (Number.isNaN(t)) return { valid: false, reason: 'unparseable transmission time' };
  if (Math.abs(now - t) > maxAgeMs) return { valid: false, reason: 'transmission time outside 5-minute window' };

  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const verificationString = `${transmissionId}|${transmissionTime}|${webhookId}|${bodyHash}`;

  let pem;
  try {
    pem = await fetchCert(certUrl, fetchCertImpl);
  } catch (err) {
    return { valid: false, reason: `certificate fetch failed: ${err.message}` };
  }

  const sigBuffer = /^[0-9a-fA-F]+$/.test(signature) && signature.length % 2 === 0
    ? Buffer.from(signature, 'hex') // current PayPal scheme: hex
    : Buffer.from(signature, 'base64'); // legacy fallback

  const verifier = createVerify(ALGO_TO_NODE[algo] || 'RSA-SHA256');
  verifier.update(verificationString, 'utf8');
  try {
    const ok = verifier.verify(pem, sigBuffer);
    // An explicit reason is REQUIRED here: a failed verify() previously
    // returned `{ valid: false }` with no reason field, so the server logged
    // the useless "unknown reason" (this masked a live incident where PayPal's
    // genuine webhooks were rejected three times). A false result means the
    // signed string did not match — almost always a PAYPAL_WEBHOOK_ID that
    // differs from the id PayPal signed with (missing, mistyped, or padded
    // with a stray space/newline from pasting).
    return ok
      ? { valid: true }
      : {
          valid: false,
          // DIAGNOSTIC DUMP (2026-09-22 incident): the env var and webhook id
          // were verified correct, yet genuine PayPal deliveries still failed
          // verification with no reason. So instead of guessing, we dump every
          // input that went into the verification:
          //   - tid/time/wid: must match the event's headers in PayPal's
          //     dashboard exactly (wid incl. length — catches stray chars)
          //   - bodylen/bodyhash/bodyhead: compare against the payload shown
          //     in PayPal's dashboard — if our bodylen/hash differs, the body
          //     bytes were altered in transit (proxy/middleware)
          //   - siglen: 256 = 2048-bit RSA key (expected)
          //   - certfp: sha256 of the PEM text as served — re-fetch the same
          //     URL locally and compare to confirm we got the same certificate
          reason:
            'signature mismatch — ' +
            `tid=${transmissionId} time=${transmissionTime} ` +
            `wid=${JSON.stringify(webhookId)} (widlen=${String(webhookId).length}) ` +
            `algo=${algo} ` +
            `bodylen=${Buffer.isBuffer(rawBody) ? rawBody.length : typeof rawBody} ` +
            `bodyhash=${bodyHash} ` +
            `sig=${signature} ` +
            `siglen=${sigBuffer.length} ` +
            `cert=${certUrl} certfp=${createHash('sha256').update(pem).digest('hex').slice(0, 16)}`,
        };
  } catch (err) {
    return { valid: false, reason: `crypto error: ${err.message}` };
  }
}

// Full pipeline for one webhook request. server.js's route just calls this
// and maps the result to an HTTP status.
// fetchCertImpl is optional: the server leaves it as the real fetch, tests
// inject a fake so the whole pipeline runs offline.
export async function processPaypalWebhook(db, { headers, rawBody, webhookId, fetchCertImpl }) {
  const v = await verifyPaypalWebhook({ headers, rawBody, webhookId, fetchCertImpl });
  if (!v.valid) return { accepted: false, stage: 'verification', reason: v.reason };

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { accepted: false, stage: 'parse', reason: 'body is not valid JSON' };
  }
  const eventId = event.id || event.event_id;
  if (!eventId) return { accepted: false, stage: 'parse', reason: 'event has no id' };

  // Idempotency: the first delivery inserts; PayPal retries (and duplicate
  // deliveries) hit this guard and are reported as duplicates — we still
  // return 2xx so PayPal stops retrying.
  const inserted = db
    .prepare('INSERT OR IGNORE INTO paypal_webhook_events (event_id, event_type, payload, received_at, status) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, event.event_type || 'unknown', rawBody.toString('utf8'), Date.now(), 'received');
  if (inserted.changes === 0) return { accepted: true, stage: 'duplicate' };

  const outcome = applyMembershipEvent(db, event);
  db.prepare('UPDATE paypal_webhook_events SET status = ?, note = ? WHERE event_id = ?').run('processed', JSON.stringify(outcome), eventId);
  return { accepted: true, stage: 'processed', outcome };
}

// Crash recovery: if we received an event but crashed (or threw) before
// finishing, its row is still 'received'/'failed'. Re-apply it at startup —
// safe because applyMembershipEvent is idempotent.
export function reprocessPendingWebhooks(db) {
  const rows = db.prepare("SELECT event_id, payload FROM paypal_webhook_events WHERE status IN ('received', 'failed')").all();
  let reprocessed = 0;
  for (const row of rows) {
    try {
      const outcome = applyMembershipEvent(db, JSON.parse(row.payload));
      db.prepare("UPDATE paypal_webhook_events SET status = 'processed', note = ? WHERE event_id = ?").run(JSON.stringify(outcome), row.event_id);
      reprocessed++;
    } catch {
      // keep the row at its failed state; it will show up again next boot
    }
  }
  return reprocessed;
}
