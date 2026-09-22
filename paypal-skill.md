# Skill: PayPal Subscriptions (recurring membership) — one‑shot, no‑headache implementation

This is the battle‑tested runbook for wiring a **recurring monthly membership** into a
Node.js + Express + `node:sqlite` site using the **PayPal Subscriptions v1 API** (sandbox).
It encodes the exact API contract, the architecture that actually works, **every roadblock we
hit and how we got around it**, and the verification checklist that proves it. Follow it top‑to‑
bottom and you land directly on the working final state — you will not re‑discover the bugs.

The canonical, working implementation lives in this repo (read it if the skill is ever unclear):
- `paypal-config.js` — env‑driven config
- `paypal-subscriptions.js` — all PayPal API calls + webhook verification + membership state machine
- `server.js` — the join / return / cancel / webhook routes
- `test-a2-subscriptions.mjs` — offline test suite (signature, state machine, pipeline, recovery)

If you need official docs, **start here** (in this order):
1. https://developer.paypal.com/subscriptions/webhooks
2. https://developer.paypal.com/subscriptions/integrate.md
3. https://developer.paypal.com/api/rest/webhooks.md

---

## 0. The two decisions that save you the most pain (read first)

These two are the difference between "works on first deploy" and "a week of debugging":

### Decision A — Do NOT rely on the webhook to GRANT membership.
Sandbox webhook signature verification is unreliable (genuine PayPal deliveries fail RSA
verification; see Pitfall #3). So the **grant happens in the return route**: after the buyer
approves, PayPal redirects the browser to `RETURN_URL`; **that route asks PayPal's API "what is
this subscription's status right now?"** and, if `ACTIVE`, grants membership. This is the
verification that finally made membership work, and it must be the primary grant path.

The **signed webhook stays fully armed** — but only as the source of truth for **revocation**
(suspended / cancelled / re‑activated) and for **production**, where its signatures do verify.

### Decision B — Cancel with `POST …/cancel`, never `DELETE`.
The correct cancel call is `POST /v1/billing/subscriptions/{id}/cancel` (returns 204 → CANCELLED).
`DELETE /v1/billing/subscriptions/{id}` returns **404 and does NOT cancel anything** — the
subscription stays ACTIVE and keeps charging. This is exactly the scary bug the user hit. Use the
POST form.

And, symmetric to Decision A: **don't wait for the CANCELLED webhook to flip the user off.** When
PayPal confirms the cancel, flip membership off locally through the same idempotent state machine.

---

## 1. Architecture (final working state)

```
                 ┌───────────────────────────────────────────────────────────┐
  User clicks     │  POST /join-membership                                    │
  "Join" ───────► │   guards → createSubscription() → save sub id →          │
                 │   find `approve` link → 302 redirect to PayPal            │
                 └───────────────────────────┬───────────────────────────────┘
                                             │ buyer sees "Agree & Approve"
                                             ▼
                          ┌───────────────────────────────────────────────────┐
                          │  PayPal buyer sandbox account approves the sub     │
                          └───────────────────────────┬───────────────────────┘
                                                      │ browser redirect (token + PAYERID)
                                                      ▼
                 ┌───────────────────────────────────────────────────────────┐
  ★ GRANT PATH    │  GET /paypal-return                                        │
  (works in       │   session check → user.paypal_subscription_id →           │
   sandbox)       │   getSubscription(id) → status == ACTIVE?                 │
                  │     yes → activateMembershipFromApi() → "You are a member"│
                  │     APPROVAL_PENDING → "finish Approve" page              │
                  │     other / error → status / 502 page                     │
                  └───────────────────────────────────────────────────────────┘

  User clicks     ┌───────────────────────────────────────────────────────────┐
  "Cancel" ─────► │  POST /cancel-membership                                  │
                  │   cancelSubscription()  (POST …/cancel → 204)             │
  ★ CANCEL PATH   │   → cancelMembershipFromApi()  → "membership is now off" │
                  │   error → 502 "your membership is STILL on" page          │
                  └───────────────────────────────────────────────────────────┘

  PayPal (any     ┌───────────────────────────────────────────────────────────┐
  time) ─────────► │  POST /paypal-webhook  (signed)                          │
   ARMED, not the  │   express.raw (exact bytes) → verify signature →         │
   grant path      │   dedupe → applyMembershipEvent() → 200                 │
   in sandbox      │   (suspended/cancelled/re‑activated; idempotent)        │
                  └───────────────────────────────────────────────────────────┘

  EVERY membership change funnels through ONE idempotent function:
      applyMembershipEvent(db, event)
  Both the webhook AND the API‑driven grant/cancel call it. That is what makes
  "the webhook fires later too" a harmless no‑op instead of a double‑apply.
```

**Key idea:** one code path for every state change (`applyMembershipEvent`), idempotent, so it
doesn't matter *which* trigger (return‑route API check, cancel‑route API check, or webhook)
applies it first or twice.

---

## 2. Prerequisites & environment

### 2.1 Sandbox account
- A PayPal **sandbox** merchant account (developer account) and a sandbox **buyer** account to
  act as the customer (e.g. `sb‑…@personal.example.com`).
- In the PayPal developer dashboard → **Apps & Credentials → Create App** (type: *Server*):
  copy the **Client ID** and **Secret**.
- In the dashboard → **Webhooks → Create webhook**:
  - Webhook URL: `https://YOUR_APP_URL/paypal-webhook`
  - Enable events: `BILLING.SUBSCRIPTION.ACTIVATED`, `…SUSPENDED`, `…CANCELLED`,
    `…RE-ACTIVATED` (that hyphenated name is the one that actually fires; see Pitfall #10).
  - Copy the **Webhook ID** (e.g. `2G297211261546444`). It is **17 characters, no spaces**.

### 2.2 Environment variables (set in BOTH local `.env` and the host, e.g. Render → Environment)
```
PAYPAL_CLIENT_ID=            <your sandbox client id>
PAYPAL_CLIENT_SECRET=        <your sandbox secret>
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
APP_URL=https://your-live-or-localhost   # used to build RETURN_URL / CANCEL_URL
PAYPAL_RETURN_URL=           # optional override, default = APP_URL/paypal-return
PAYPAL_CANCEL_URL=           # optional override, default = APP_URL/paypal-cancel
PAYPAL_WEBHOOK_ID=           <the webhook id, EXACTLY — see Pitfall #6>
SESSION_SECRET=              <random string; required in production>
```
Never hardcode credentials. Ship `PASTE_…` placeholders and **fail fast** (a guard that refuses to
create a subscription while a `PASTE_` value is still in place) so a mis‑configured deploy never
silently "works".

### 2.3 Database tables
```sql
users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT,
  email TEXT,
  member INTEGER DEFAULT 0,              -- 1 = has access
  membership_status TEXT,                -- 'active' | 'suspended' | 'cancelled'
  paypal_subscription_id TEXT,          -- bridge to PayPal (strongest key)
  member_since INTEGER
);
paypal_meta( key TEXT PRIMARY KEY, value TEXT );   -- stores product_id / plan_id
paypal_webhook_events( event_id TEXT PRIMARY KEY, event_type TEXT, received_at INTEGER, status TEXT ); -- dedupe
```
Store the created **product_id** and **plan_id** in `paypal_meta` so a restart never creates a
second product/plan. (The site's `database.db` is ephemeral on Render free tier — see Pitfall #13.)

---

## 3. The exact PayPal API contract (all calls verified against the live sandbox)

Base URL (sandbox): `https://api-m.sandbox.paypal.com`. Every call (except #1) is
`Authorization: Bearer <token>`.

### 3.1 OAuth token — `POST /v1/oauth2/token`
**Credentials go in the `Authorization: Basic` header — NOT in the form body.**
(For this app, body‑embedded credentials → `401 invalid_client`; the Basic header → 200.)
```
POST /v1/oauth2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

body: grant_type=client_credentials
```
Returns `{ access_token, expires_in, ... }`. Cache it ~1h (subtract a 1‑min margin).

### 3.2 Product — `POST /v1/catalogs/products`
```
{ "name": "gqsa membership", "type": "SERVICE", "description": "Recurring membership" }
```
Returns `{ id: "PROD-…", ... }`. Store in `paypal_meta`.

### 3.3 Plan — `POST /v1/billing/plans`  ⚠️ the trap
```
{
  "product_id": "PROD-…",
  "name": "gqsa membership",
  "billing_cycles": [
    {
      "sequence": 1,
      "tenure_type": "REGULAR",
      "frequency": { "interval_unit": "MONTH", "interval_count": 1 },
      "total_cycles": 0,                       // ← 0 = runs FOREVER. NEVER OMIT.
      "pricing_scheme": { "fixed_price": { "value": "1.00", "currency_code": "USD" } }
    }
  ],
  "payment_preferences": { "auto_bill_outstanding": true },
  "status": "ACTIVE"
}
```
- **`total_cycles: 0` is mandatory for a recurring plan.** PayPal **silently defaults it to `1`
  when omitted** → a ONE‑SHOT charge (the sub activates, is charged once, and EXPIRED ~1s later).
  This was our first live bug. Always set `0`, and **validate any cached plan** for
  `status == ACTIVE && total_cycles == 0` before reusing it.
- `PATCH` cannot fix `total_cycles` (only name/description/payment_preferences/taxes are
  patchable) — you must create a new plan.
- Some tenants reject a **duplicate plan name** under the same product → retry once with a distinct
  name (e.g. append " (monthly)").
- Returns `{ id: "P-…", ... }`. Store in `paypal_meta`.

### 3.4 Subscription — `POST /v1/billing/subscriptions`
```
{
  "plan_id": "P-…",
  "custom_id": "1",                            // ← our bridge: the numeric user id (string)
  "subscriber": {
    "name": { "given_name": "Alice", "surname": "A" },
    "email_address": "buyer@example.com"        // required to invoice the buyer
  },
  "application_context": {
    "return_url": "https://APP/paypal-return",  // where the buyer's browser lands after Approve
    "cancel_url": "https://APP/paypal-cancel"
  }
}
```
- `custom_id` is how webhook events map back to *your* user. Set it to the **string user id**.
- The response `links` array contains an `approve` href — **redirect the browser there** (that is
  the "Agree & Approve" step). Store `id` (`I-…`) in `users.paypal_subscription_id`.

### 3.5 Subscription status — `GET /v1/billing/subscriptions/{id}`
Returns `{ id, status, custom_id, start_time, subscriber, plan, ... }`. `status` ∈
`ACTIVE`, `APPROVAL_PENDING`, `CANCELLED`, `EXPIRED`, `SUSPENDED`. **This is what the return
route (Decision A) calls.** Read‑only, idempotent, no webhook required.

### 3.6 Cancel — `POST /v1/billing/subscriptions/{id}/cancel`  ⚠️ not DELETE
```
POST /v1/billing/subscriptions/{id}/cancel
Content-Type: application/json      // ← REQUIRED, a bare POST is 415 UNSUPPORTED_MEDIA_TYPE
body: {}
```
Returns **204** and the sub becomes **CANCELLED**. This is Decision B.
- `DELETE /v1/billing/subscriptions/{id}` → **404 and does NOT cancel** (sub stays ACTIVE/charging).
- After a successful cancel, also flip membership off locally (Decision B / Pitfall #5).

### 3.7 Debug helpers (useful, optional)
- `GET /v1/catalogs/products` — list products.
- `GET /v1/billing/plans?product_id=…` — list plans for a product.
- `GET /v1/billing/subscriptions?plan_id=…` — list subs. **Note: the `plan_id` filter is IGNORED
  by this endpoint** (it returns all subs for the merchant); filter client‑side if needed.

---

## 4. Webhook signature verification (the algorithm)

PayPal signs every webhook with an RSA key whose **certificate URL** it sends in the request.
Implement with plain `node:crypto` (no SDK) so it stays inspectable and testable offline:

1. Read headers (case‑insensitive): `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-TIME`,
   `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`, `PAYPAL-TRANSMISSION-SIG` (hex).
2. **Replay guard:** `PAYPAL-TRANSMISSION-TIME` must be within **5 minutes** of now.
3. `bodyHash = hex( sha256( rawBody ) )` — over the **exact** request bytes.
4. `verificationString = transmissionId + "|" + transmissionTime + "|" + webhookId + "|" + bodyHash`
   where `webhookId` is your dashboard webhook id (exact).
5. `cert = GET(PAYPAL-CERT-URL)` → PEM (cache ~1h).
6. Map algo: `SHA256withRSA → RSA-SHA256`, `SHA1withRSA → RSA-SHA1`.
7. `node:crypto` `createVerify(algo).update(verificationString).verify(cert, signatureHex, 'hex')`.

**Two hard requirements that are easy to get wrong:**
- The body hash must be over the **exact raw bytes**. Use `express.raw({ type: '*' })` on the
  webhook route (or `req.on('data')`) so no JSON parsing/re‑serialization changes the bytes.
  Any middleware that reformats the body breaks verification.
- `webhookId` in step 4 must be **exactly** the dashboard value (Pitfall #6).

**Event map** (the only events that change membership; ignore the rest, e.g. `PAYMENT.SALE.COMPLETED`):
```
BILLING.SUBSCRIPTION.ACTIVATED   -> active      (approved + first payment)
BILLING.SUBSCRIPTION.APPROVED    -> active      (legacy name, same moment)
BILLING.SUBSCRIPTION.SUSPENDED   -> suspended   (payment failed, billing paused)
BILLING.SUBSCRIPTION.CANCELLED   -> cancelled   (buyer or we cancelled)
BILLING.SUBSCRIPTION.REINSTATED  -> active      (legacy alias)
BILLING.SUBSCRIPTION.RE-ACTIVATED-> active      (the API's REAL re‑activation name)
```

**`applyMembershipEvent(db, event)`** — the single idempotent funnel:
- Look up the user via `resource.id` (match `users.paypal_subscription_id`, strongest) **or**
  `resource.custom_id` (numeric → user id). Never trust email alone.
- `active` → `member=1, membership_status='active'`, set `paypal_subscription_id`, set
  `member_since` (once).
- `suspended`/`cancelled` → `member=0`, `membership_status=<that>`, keep the sub id so a later
  RE‑ACTIVATED/re‑join can find them.
- Idempotent: applying the same event twice yields the same state → PayPal's "retry until 2xx"
  is safe, and a later genuine webhook after an API‑driven change is a harmless no‑op.
- **Dedupe** by `event_id` in `paypal_webhook_events` (INSERT OR IGNORE). **Crash recovery:** on
  boot, re‑process any event stuck in `pending`.

---

## 5. The routes (Express)

```
POST /join-membership
  - guard: not already a member; not a PASTE_ credential
  - createSubscription() -> save users.paypal_subscription_id
  - find `approve` link in response.links -> res.redirect(approve.href)

GET /paypal-return                 ★ GRANT PATH (Decision A)
  - session check (no session -> /login)
  - sub id = user.paypal_subscription_id   (none -> "No subscription on file" page)
  - sub = getSubscription(id)
  - sub.status == ACTIVE (or TRIALING) -> activateMembershipFromApi() -> "You are now a member! ⭐"
  - APPROVAL_PENDING -> "Almost there — finish Agree & Approve, then check again"
  - other -> status page with a retry link;  catch -> 502 page
  - log: [A2] return-route check: user <id> sub <id> -> <status>

POST /cancel-membership            ★ CANCEL PATH (Decision B)
  - cancelSubscription(id)   (POST …/cancel, JSON)
  - on success -> cancelMembershipFromApi() -> "Membership cancelled, you won't be charged again"
  - on error   -> 502 "Couldn't cancel … your membership is STILL on" + PayPal error +
                  fallback: cancel from your PayPal account
  - log: [A2] cancel confirmed/FAILED for user <id>

POST /paypal-webhook               (signed, armed; NOT the grant path in sandbox)
  - express.raw -> verify (section 4) -> dedupe -> applyMembershipEvent -> 200
  - log: [A2] webhook ACCEPTED/REJECTED: <event> — <reason>   (reason must be explicit!)

GET /membership-status             (JSON: { member, status, subscriptionId, memberSince, email })
GET /paypal-cancel                 ("Join cancelled" page)
```

**Important:** PayPal's return redirect carries `token` + `PAYERID`, **not the subscription id**.
That's fine — the sub id is already stored server‑side at join time, and it's the stronger key.
Use the stored `users.paypal_subscription_id`, not the query params.

---

## 6. Roadblocks we hit and how we got around them (the value of this skill)

1. **Membership never flipped; sub was one‑shot.** Cause: plan `total_cycles` omitted → PayPal
   defaulted it to `1` → sub activated, charged once, EXPIRED ~1s later. **Fix:** always send
   `total_cycles: 0`; validate the cached plan (`ACTIVE && total_cycles==0`); `ensurePlan` is
   self‑healing (creates a proper recurring plan, best‑effort deactivates the bad one, tolerates
   duplicate‑name rejection). See §3.3.
2. **OAuth 401 `invalid_client`.** Cause: credentials were sent in the form body. **Fix:** send
   them as `Authorization: Basic base64(id:secret)` with body `grant_type=client_credentials`.
   See §3.1.
3. **Webhook REJECTED ×3 with an "unknown reason" (= signature mismatch).** Genuine sandbox
   deliveries failed RSA verification while our own correctly‑signed test request verified fine
   through the *same* code path → the verification path was healthy; the failure was
   input‑specific/sandbox‑side. We proved it with a temp `/debug-cert` route serving a known test
   key. **Resolution (the key decision):** *don't make the grant depend on the webhook* — grant
   via the return‑route API check (Decision A), keep the webhook armed for revocation/production.
   Also: make the verify‑fail reason **explicit** ("signature mismatch — PAYPAL_WEBHOOK_ID must be
   EXACTLY the dashboard id…") so the log line self‑diagnoses. See §0, §4, Pitfall #6.
4. **Cancel returned 404 and did nothing (sub stayed ACTIVE/charging).** Cause: used
   `DELETE /v1/billing/subscriptions/{id}`. **Fix:** `POST /v1/billing/subscriptions/{id}/cancel`
   with `Content-Type: application/json` (bare POST → 415). Returns 204 → CANCELLED. See §3.6,
   Decision B.
5. **Waiting on the webhook to flip state** (both grant and revoke) is unreliable in sandbox.
   **Fix:** apply state locally right after the API confirms (grant on the return route; revoke on
   the cancel route), through the same idempotent `applyMembershipEvent`. A later real webhook is a
   no‑op. See §0, §4, §5.
6. **`PAYPAL_WEBHOOK_ID` wrong/missing** (a `PASTE_…` placeholder or a stray space/newline from
   pasting) → every genuine event 400s. **Fix:** set it to the **exact** dashboard id (17 chars,
   no whitespace) in BOTH local and the host env. See §2.2, §4.
7. **Body bytes changed before hashing** → signature mismatch. **Fix:** `express.raw` on the
   webhook route so the hash is over the exact bytes. See §4.
8. **Re‑processing / double‑apply anxiety.** **Fix:** idempotent `applyMembershipEvent` +
   dedupe by `event_id` + crash‑recovery of `pending` events. Makes PayPal's "retry until 2xx"
   safe. See §4.
9. **Event name mismatch on re‑activation.** The new Subscriptions API fires
   `BILLING.SUBSCRIPTION.RE-ACTIVATED` (hyphen), not `REINSTATED`. **Fix:** map both (REINSTATED
   kept as legacy alias). See §4.
10. **`PATCH` can't fix a one‑shot plan.** Only name/description/payment_preferences/taxes are
    patchable. **Fix:** create a new plan with `total_cycles: 0`; retire the old one. See §3.3.
11. **Duplicate plan name rejected** on some tenants. **Fix:** retry once with a distinct name.
    See §3.3.
12. **Return redirect gives `token`+`PAYERID`, not the sub id.** **Fix:** use the stored
    `users.paypal_subscription_id`. See §5.
13. **Render free tier is ephemeral.** `database.db` (and users, and `paypal_meta`) is wiped on
    every restart/deploy → users re‑register, and `ensureProduct`/`ensurePlan` recreate PayPal
    objects (which **do persist** on PayPal's side → dashboard clutter, e.g. 6 products). This is
    expected; the self‑healing plan logic means it still works. For real persistence, use a managed
    DB. See §2.3.
14. **Git push SSL failure on Windows** (`schannel` / `SEC_E_NO_CREDENTIALS`). **Fix:**
    `git config http.sslBackend openssl` (now set in this repo) before pushing.
15. **Don't leave a charged sub orphaned** when a test fails. Cancel it via §3.6 so the buyer isn't
    billed again and the next test starts clean.

---

## 7. Verification checklist (do not skip)

### 7.1 Offline (no network, no real charge)
```
node test-a2-subscriptions.mjs
```
Expect **all PASS** (18 tests): webhook signature verification with a real generated RSA key,
the idempotent state machine (grant / suspend / cancel / re‑activate, incl. `custom_id` bridge),
the full pipeline, and crash‑recovery replay. This proves the *logic* without touching PayPal.

### 7.2 Live smoke (sandbox, real $1, safe — then clean up)
1. **GRANT (the verification that made membership work — Decision A):** register → Join →
   approve in the buyer sandbox account → PayPal redirects to `/paypal-return` → **page shows
   "You are now a member! ⭐"** and the DB shows `member=1, membership_status='active'`. A repeat
   hit is idempotent. This confirms `getSubscription()` + `activateMembershipFromApi()` end‑to‑end.
2. **CANCEL (the solution — Decision B):** click **Cancel membership** → page shows "Membership
   cancelled, you won't be charged again" → verify the sub is **CANCELLED on PayPal's side**
   (`GET /v1/billing/subscriptions/{id}`) **and** `member=0 / membership_status='cancelled'`
   locally. This confirms `POST …/cancel` + `cancelMembershipFromApi()` end‑to‑end.
3. **Error branch:** cancel with a bogus sub id → **502** with "your membership is STILL on" and
   the user's `member` stays `1` (correct: we couldn't cancel, so we don't claim we did).
4. **Webhook armed (optional, for production):** confirm the 4 events are ENABLED on the dashboard
   webhook and that a genuine delivery logs `[A2] webhook ACCEPTED …` (in production) — in sandbox
   it may log REJECTED (Pitfall #3); that is expected and non‑fatal because grant/cancel no longer
   depend on it.
5. **Clean up:** cancel any test subscription you created (§3.6) and delete the test user, so no
   orphaned sub keeps the buyer charged.

### 7.3 Definition of done
- [ ] Grant path: buyer approves → member, via `/paypal-return` + `getSubscription()` (Decision A)
- [ ] Cancel path: button → sub CANCELLED on PayPal + membership off locally (Decision B)
- [ ] Error paths are honest (no false success; "still on" when we couldn't cancel)
- [ ] Offline suite green (18/18)
- [ ] Webhook armed for revocation/production, idempotent, deduped, crash‑recovering
- [ ] No orphaned charging subscriptions; credentials from env only

---

## 8. Minimal reference snippets (the "money shots")

**Token (Pitfall #2):**
```js
const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
await fetch(`${BASE}/v1/oauth2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
  body: new URLSearchParams({ grant_type: 'client_credentials' }),
});
```

**Plan (Pitfall #1) — the `total_cycles: 0` is the whole game:**
```js
billing_cycles: [{ sequence: 1, tenure_type: 'REGULAR',
  frequency: { interval_unit: 'MONTH', interval_count: 1 },
  total_cycles: 0,                     // NEVER omit → defaults to 1 (one‑shot!)
  pricing_scheme: { fixed_price: { value: '1.00', currency_code: 'USD' } } }],
payment_preferences: { auto_bill_outstanding: true }, status: 'ACTIVE'
```

**Cancel (Pitfall #4) — POST, not DELETE:**
```js
await fetch(`${BASE}/v1/billing/subscriptions/${id}/cancel`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),            // required → else 415
});                                     // 204 → CANCELLED
```

**Grant (Decision A) — return route asks the API, doesn't wait for the webhook:**
```js
const sub = await getSubscription(user.paypal_subscription_id);   // GET …/subscriptions/{id}
if (sub.status === 'ACTIVE' || sub.status === 'TRIALING') {
  activateMembershipFromApi(db, { userId: user.id, subscriptionId: sub.id }); // -> applyMembershipEvent
}
```

**Webhook verify string (Pitfall #7):**
```js
const bodyHash = sha256(rawBody).toString('hex');
const s = `${transmissionId}|${transmissionTime}|${WEBHOOK_ID}|${bodyHash}`;
createVerify('RSA-SHA256').update(s).verify(certPem, signatureHex, 'hex');   // true/false
```
