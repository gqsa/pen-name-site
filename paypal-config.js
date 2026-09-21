// PayPal SANDBOX credentials (test mode — no real money ever moves).
//
// A1 (env-only secrets): credentials now live OUTSIDE the code:
//   LOCAL dev:  a .env file next to this one (see .env.example). .env is
//               gitignored, so it never reaches the repo.
//   RENDER:     set in the Render dashboard (and/or render.yaml).
// The fallbacks below are PLACEHOLDERS on purpose: with no credentials
// configured, the join flow shows a friendly "not set up yet" page instead of
// silently failing with a bad API call.
export const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'PASTE_YOUR_SANDBOX_CLIENT_ID';
export const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || 'PASTE_YOUR_SANDBOX_CLIENT_SECRET';

// The "test" PayPal. (The real one, for later, is https://api-m.paypal.com)
export const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

// Where the site lives, used to build the PayPal redirect URLs below.
// For local dev, use localhost. For deployment, set APP_URL with your live URL.
const BASE_URL = process.env.APP_URL || 'http://localhost:3000';
export const RETURN_URL = process.env.PAYPAL_RETURN_URL || `${BASE_URL}/paypal-return`;
export const CANCEL_URL = process.env.PAYPAL_CANCEL_URL || `${BASE_URL}/paypal-cancel`;

// ---------------------------------------------------------------------------
// A2: recurring membership (PayPal Subscriptions).
//
// The membership model is now a MONTHLY-RENEWING subscription — this replaces
// the old one-time $1 model (see progress.md, A2). Membership is granted and
// revoked by signed PayPal webhooks, not by the browser's return page.
//
// These knobs let you change WHAT the subscription sells (name, price, period)
// without touching code. The plan is auto-created on first join and remembered
// in the DB (paypal_meta), so changing SUBSCRIPTION_PRICE only affects NEW
// subscribers — existing ones keep their original plan (that's how PayPal
// subscriptions work).
// ---------------------------------------------------------------------------
export const SUBSCRIPTION_NAME = process.env.SUBSCRIPTION_NAME || 'gqsa membership';
export const SUBSCRIPTION_PRICE = process.env.SUBSCRIPTION_PRICE || '1.00';
export const SUBSCRIPTION_CURRENCY = process.env.SUBSCRIPTION_CURRENCY || 'USD';
// Billing period — PayPal interval units: DAY | WEEK | MONTH.
export const SUBSCRIPTION_PERIOD = process.env.SUBSCRIPTION_PERIOD || 'MONTH';
// The WEBHOOK ID from the PayPal dashboard (Webhooks tab). Our /paypal-webhook
// endpoint trusts nothing without a valid RSA signature tied to this id, so a
// random stranger can't POST fake "you're a member" events.
export const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || 'PASTE_YOUR_WEBHOOK_ID';

// Legacy (one-time model) — kept so older references don't break. A2 supersedes it.
export const MEMBERSHIP_AMOUNT = { currency_code: SUBSCRIPTION_CURRENCY, value: SUBSCRIPTION_PRICE };
