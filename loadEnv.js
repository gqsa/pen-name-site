// A1 (env-only secrets): a tiny .env loader — no npm package needed.
//
// WHAT: reads a ".env" file (KEY=VALUE lines) from the project root and puts
// the values into process.env, so the rest of the code can read them the same
// way it reads real environment variables.
//
// WHY: secrets (session secret, PayPal keys) must NOT live in the source code.
// On a host like Render, the platform sets real environment variables for you.
// Locally, we don't have that, so .env is our stand-in. It's listed in
// .gitignore, so it never gets committed.
//
// TWO IMPORTANT RULES HERE:
// 1. We NEVER override a variable that's already set. A host's real env var
//    always wins over the local .env file. (This is what "environment
//    variables" means: values injected from OUTSIDE the code.)
// 2. ES MODULE ORDER: this file's code runs the moment it's imported —
//    BEFORE server.js's own body runs, but in the ORDER the imports appear.
//    So server.js must import ./loadEnv.js BEFORE ./paypal-config.js
//    (paypal-config reads process.env at its own import time).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadEnv() {
  const file = path.join(process.cwd(), '.env');
  if (!existsSync(file)) return; // no .env file? fine — rely on real env vars

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // blank lines / comments
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue; // not a KEY=VALUE line — skip
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Allow "KEY=value" and KEY="value" / KEY='value'
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value; // rule 1: never override a real env var
    }
  }
}

// Run it right now, at import time (see rule 2).
loadEnv();
