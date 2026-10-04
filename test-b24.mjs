// B2.4 verification — SELF-CONTAINED (the permanent suite for the whole
// "Content JSON API + multer uploads" surface; Steps 1–6's throwaway scripts
// are deleted, THIS re-covers them).
//
// HOW TO RUN:
//   node test-b24.mjs
//
// Spawns its OWN server on a free port with a controlled environment (a known
// ADMIN_USERNAME — the B2.1 boot-seed creates the admin account — and a raised
// LOGIN_MAX_ATTEMPTS), runs the checks, then kills it and cleans the scratch
// upload. Shares the repo's database.db (A1 house style): every throwaway row
// is created AND deleted within the run, so the net DB change is zero (except
// the idempotent B2.4 column migrations, which are the point).
//
// WHAT IT PROVES:
//   1.  GET /api/admin/content: non-admin 403 JSON / admin 200 (5 arrays + counts)
//   2.  upload: admin + CSRF header + kind=comics + a real file → 200 {file_path},
//       the file GET-able at that URL; non-admin 403 (its own valid token, so
//       the 403 is the admin gate); admin without the header 403 (CSRF block)
//   3.  stories: POST 201 → PUT change persisted → DELETE gone; non-admin 403
//   4.  comics+pages: POST comic → POST 2 pages → REORDER (order flips) →
//       caption set → DELETE a page (B2.5 Step 12: renumbers to clean 1..N)
//       → DELETE comic → CASCADE (0 pages left) → DELETE middle of a 5-page
//       comic → clean 1-4, last page → 1-3, bogus id → 404;
//       B18: theme_colour set/clear/keep via POST+PUT, caption_position
//       defaults to 'top', caption-only ('page') row has NULL file_path, the
//       two POST 400s, position flip + keep-on-omit;
//       non-admin 403 on the write routes
//   5.  images + videos: POST/PUT(caption)/DELETE each; non-admin 403
//   6.  schema: caption on comic_pages + images + videos; updated_at INTEGER
//       on images + videos (the Step 6 type fix — not the TEXT affinity a
//       bare ADD COLUMN would have given); B18: caption_position on
//       comic_pages + theme_colour on comics
//
// NOTE on 403 shapes (A1/Step-1 house note): the admin gate answers JSON
// {"error":"Not admin"}; the CSRF middleware (POST-only, fires BEFORE the
// route) answers an HTML block page. Non-admin POST checks therefore send the
// USER's OWN valid X-CSRF-Token so the 403 comes from isAdmin, not CSRF.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'database.db');
const PUBLIC_ROOT = path.join(__dirname, 'public');
// `connection: close` on every request (A1's note: Windows + abrupt exit + a
// live keep-alive socket trips a libuv assertion that clobbers the exit code).
const CLOSE = { headers: { connection: 'close' } };

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
  if (!ok) failures++;
}

const ts = Date.now();
const ADMIN = `b24admin${ts}`;   // matches the spawned server's ADMIN_USERNAME
const USER = `b24user${ts}`;     // throwaway non-admin
const PASS = 'S3cret!pass';

// Scratch source file for the upload check (deleted at the end).
const SCRATCH = mkdtempSync(path.join(__dirname, '.b24-scratch-'));
const TMP_FILE = path.join(SCRATCH, `b24-upload-${ts}.png`);
// 16 bytes of PNG magic + padding; the content is irrelevant to the route.
writeFileSync(TMP_FILE, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 0),
]));

// --- shared helpers (house style, copied from the A1/A3 suites) --------------
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

function spawnServer(base, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    // stdio 'inherit' (not 'pipe'): the DSH sandbox denies named-pipe stdio to
    // children with EPERM; inherit works everywhere (see the A1 test note).
    env: {
      ...process.env,
      PORT: String(port), // the FREE port we picked — without it Express uses 3000
      SESSION_SECRET: 'b24-test-secret',
      ADMIN_USERNAME: ADMIN,
      ADMIN_PASSWORD: PASS, // the B2.1 boot-seed creates the admin account
      LOGIN_MAX_ATTEMPTS: '1000',
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

// Fresh browser visit: session cookie + the CSRF token from the login page.
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

function jsonBody(sql) { // small DB probe for the schema section
  const d = new DatabaseSync(DB_PATH);
  const r = d.prepare(sql).all();
  d.close();
  return r;
}

// --- main --------------------------------------------------------------------
let uploadedDir = null; // public/uploads/comics/<uuid> — deleted at the end
async function main() {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const s = spawnServer(base, port);
  await waitReady(base, s);
  try {
    // --- sessions -------------------------------------------------------------
    const a = await newSession(base);
    await (await postForm(base, a, '/login', { username: ADMIN, password: PASS })).text();

    const u = await newSession(base);
    await (await postForm(base, u, '/register', { username: USER, password: PASS })).text();
    await (await postForm(base, u, '/login', { username: USER, password: PASS })).text();

    const adminH = { 'content-type': 'application/json', cookie: a.cookie, 'x-csrf-token': a.token, 'connection': 'close' };
    const adminGet = { cookie: a.cookie, 'connection': 'close' };
    // the USER's own valid token — so a POST 403 is the admin gate, not CSRF
    const userCSRF = { 'content-type': 'application/json', cookie: u.cookie, 'x-csrf-token': u.token, 'connection': 'close' };
    const userH = { cookie: u.cookie, 'connection': 'close' };

    const content = async () => {
      const r = await fetch(base + '/api/admin/content', { headers: adminGet });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    // ============ 1. the list endpoint =======================================
    {
      const r = await fetch(base + '/api/admin/content', { headers: userH });
      const text = await r.text();
      check('1a. GET /api/admin/content non-admin → 403 JSON "Not admin"',
        r.status === 403 && /Not admin/.test(text), `got ${r.status}`);
      const { status, body } = await content();
      check('1b. GET /api/admin/content admin → 200 with 5 arrays + matching counts',
        status === 200 && Array.isArray(body.stories) && Array.isArray(body.comics) &&
        Array.isArray(body.pages) && Array.isArray(body.images) && Array.isArray(body.videos) &&
        body.counts && body.counts.stories === body.stories.length &&
        body.counts.comics === body.comics.length && body.counts.pages === body.pages.length &&
        body.counts.images === body.images.length && body.counts.videos === body.videos.length,
        `status ${status}`);
    }
    const baseCounts = (await content()).body.counts || {};

    // ============ 2. the upload route ========================================
    let uploadPath = null;
    {
      // kind FIRST in the multipart body — multer walks the stream in order and
      // destination() reads req.body.kind (Step 1 gotcha).
      const bytes = new Blob([readFileSync(TMP_FILE)]);
      const fd = new FormData();
      fd.append('kind', 'comics');
      fd.append('file', bytes, `b24-upload-${ts}.png`);
      const r = await fetch(base + '/api/admin/upload', {
        method: 'POST',
        headers: { cookie: a.cookie, 'x-csrf-token': a.token, 'connection': 'close' },
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      check('2a. upload: admin + CSRF header + kind=comics → 200 {file_path}',
        r.status === 200 && typeof j.file_path === 'string' && j.file_path.startsWith('/uploads/comics/'),
        `status ${r.status} ${JSON.stringify(j)}`);
      uploadPath = j.file_path || null;
      // file_path = /uploads/{kind}/{uuid}/{name} — slice(0,4) keeps the UUID
      // segment so the cleanup deletes ONLY this test's own upload dir
      // (public/uploads/comics/<uuid>). GOTCHA (2026-10-01, second wipe):
      // slice(0,3) resolved to public/uploads/comics — the ENTIRE kind dir —
      // and the end-of-test rmSync then deleted every comic page on disk
      // (user content + other sessions' uploads). C9: a test may only delete
      // uploads IT created.
      if (uploadPath) uploadedDir = path.join(PUBLIC_ROOT, uploadPath.split('/').slice(0, 4).join(path.sep));

      // the file must be GET-able at exactly that URL (express.static('public'))
      const g = await fetch(base + uploadPath, CLOSE);
      check('2b. the uploaded file is GET-able at its file_path',
        g.status === 200, `got ${g.status}`);
      await g.arrayBuffer();

      // non-admin (own valid token → the 403 is the admin gate, not CSRF)
      const fd3 = new FormData();
      fd3.append('kind', 'comics');
      fd3.append('file', new Blob([1, 2, 3]), 'x.png');
      const r3 = await fetch(base + '/api/admin/upload', {
        method: 'POST',
        headers: { cookie: u.cookie, 'x-csrf-token': u.token, 'connection': 'close' },
        body: fd3,
      });
      const t3 = await r3.text();
      check('2c. upload non-admin → 403 JSON "Not admin"',
        r3.status === 403 && /Not admin/.test(t3), `got ${r3.status}`);

      // admin WITHOUT the CSRF header → the CSRF block (403, HTML shape)
      const fd4 = new FormData();
      fd4.append('kind', 'comics');
      fd4.append('file', new Blob([1, 2, 3]), 'x.png');
      const r4 = await fetch(base + '/api/admin/upload', {
        method: 'POST',
        headers: { cookie: a.cookie, 'connection': 'close' },
        body: fd4,
      });
      check('2d. upload admin without X-CSRF-Token → 403 (CSRF block)',
        r4.status === 403, `got ${r4.status}`);
      await r4.text();
    }

    // ============ 3. stories CRUD ============================================
    let storyId = null;
    {
      let r = await fetch(base + '/api/admin/stories', {
        method: 'POST', headers: adminH,
        body: JSON.stringify({ title: `B24 story ${ts}`, description: 'd', body: 'first body' }),
      });
      let j = await r.json().catch(() => ({}));
      check('3a. POST /api/admin/stories → 201 {id}', r.status === 201 && Number.isInteger(j.id),
        `status ${r.status} ${JSON.stringify(j)}`);
      storyId = j.id;

      r = await fetch(base + `/api/admin/stories/${storyId}`, {
        method: 'PUT', headers: adminH,
        body: JSON.stringify({ title: `B24 story ${ts} (edited)`, body: 'second body' }),
      });
      check('3b. PUT story (title+body) → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      const c = (await content()).body;
      const row = c.stories.find(x => x.id === storyId);
      check('3c. story change persisted (description untouched kept)',
        row?.title === `B24 story ${ts} (edited)` && row?.body === 'second body' && row?.description === 'd');

      r = await fetch(base + `/api/admin/stories/${storyId}`, { method: 'DELETE', headers: adminGet });
      check('3d. DELETE story → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      const c2 = (await content()).body;
      check('3e. story gone; count restored',
        !c2.stories.find(x => x.id === storyId) && c2.counts.stories === baseCounts.stories);

      // non-admin → 403 on the three (POST with the user's own valid token)
      let r2 = await fetch(base + '/api/admin/stories', {
        method: 'POST', headers: userCSRF, body: JSON.stringify({ title: 'x', body: 'y' }),
      });
      let t2 = await r2.text();
      check('3f. POST story non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/stories/1`, { method: 'PUT', headers: userH, body: JSON.stringify({ title: 'x' }) });
      t2 = await r2.text();
      check('3g. PUT story non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/stories/1`, { method: 'DELETE', headers: userH });
      t2 = await r2.text();
      check('3h. DELETE story non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
    }

    // ============ 4. comics + pages (parent/child) ===========================
    {
      let r = await fetch(base + '/api/admin/comics', {
        method: 'POST', headers: adminH,
        body: JSON.stringify({ title: `B24 comic ${ts}`, is_member: 1 }),
      });
      let j = await r.json().catch(() => ({}));
      check('4a. POST /api/admin/comics → 201 {id}', r.status === 201 && Number.isInteger(j.id),
        `status ${r.status} ${JSON.stringify(j)}`);
      const comicId = j.id;

      const mkPage = async (n) => {
        const rp = await fetch(base + '/api/admin/comic-pages', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ comic_id: comicId, page_number: n, file_path: uploadPath || `/uploads/comics/${ts}/p${n}.png` }),
        });
        return { status: rp.status, j: await rp.json().catch(() => ({})) };
      };
      const p1 = await mkPage(1);
      check('4b. POST page 1 → 201 {id}', p1.status === 201 && Number.isInteger(p1.j.id), `status ${p1.status}`);
      const p2 = await mkPage(2);
      check('4c. POST page 2 → 201 {id}', p2.status === 201 && Number.isInteger(p2.j.id), `status ${p2.status}`);

      // REORDER: flip the order — the contract is the FULL page set, in order
      r = await fetch(base + `/api/admin/comics/${comicId}/reorder`, {
        method: 'PATCH', headers: adminH,
        body: JSON.stringify({ page_ids: [p2.j.id, p1.j.id] }),
      });
      check('4d. REORDER [p2, p1] → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      const c = (await content()).body;
      const mine = c.pages.filter(x => x.comic_id === comicId).sort((x, y) => x.page_number - y.page_number);
      check('4e. order flipped (p2 now #1, p1 now #2)',
        mine.length === 2 && mine[0].id === p2.j.id && mine[0].page_number === 1 && mine[1].id === p1.j.id,
        JSON.stringify(mine.map(x => `${x.id}:#${x.page_number}`)));

      // CAPTION on a page → persists
      r = await fetch(base + `/api/admin/comic-pages/${p1.j.id}`, {
        method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: 'page caption' }),
      });
      check('4f. PATCH page caption → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      const c2 = (await content()).body;
      check('4g. page caption persisted',
        c2.pages.find(x => x.id === p1.j.id)?.caption === 'page caption');

      // DELETE one page → count drops
      r = await fetch(base + `/api/admin/comic-pages/${p2.j.id}`, { method: 'DELETE', headers: adminGet });
      check('4h. DELETE a page → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      const c3 = (await content()).body;
      const c3mine = c3.pages.filter(x => x.comic_id === comicId);
      // B2.5 Step 12: delete RENUMBERS — p1 was #2 here (p2, the #1 page, just
      // went), so a clean state is exactly [1] (the old handler left it at #2).
      check('4i. page count dropped to 1 AND renumbered to #1 (no gap)',
        c3mine.length === 1 && c3mine[0].page_number === 1,
        JSON.stringify(c3mine.map(x => `#${x.page_number}`)));

      // DELETE the comic → its pages go with it (ON DELETE CASCADE)
      r = await fetch(base + `/api/admin/comics/${comicId}`, { method: 'DELETE', headers: adminGet });
      check('4j. DELETE comic → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      const c4 = (await content()).body;
      check('4k. CASCADE: 0 pages left for the deleted comic',
        c4.pages.filter(x => x.comic_id === comicId).length === 0 &&
        !c4.comics.find(x => x.id === comicId));

      // B2.5 Step 12 spec-verify: middle of a 5-page comic → clean 1-4 (no
      // gaps); last page → 1-3; bogus id → 404 unchanged. Own comic, deleted
      // at the end → net DB change stays zero.
      let r5 = await fetch(base + '/api/admin/comics', {
        method: 'POST', headers: adminH,
        body: JSON.stringify({ title: `B24 del comic ${ts}` }),
      });
      let j5 = await r5.json().catch(() => ({}));
      const delComic = j5.id;
      const delIds = [];
      for (let n = 1; n <= 5; n++) {
        const rp = await fetch(base + '/api/admin/comic-pages', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ comic_id: delComic, page_number: n, file_path: `/uploads/comics/${ts}/del${n}.png` }),
        });
        const jp = await rp.json().catch(() => ({}));
        if (rp.status !== 201) break;
        delIds.push(jp.id);
      }
      if (delIds.length === 5) {
        r5 = await fetch(base + `/api/admin/comic-pages/${delIds[2]}`, { method: 'DELETE', headers: adminGet });
        check('4o. DELETE the MIDDLE page (of 5) → 200', r5.status === 200, `status ${r5.status}`);
        await r5.text();
        let mine5 = (await content()).body.pages.filter(x => x.comic_id === delComic).sort((x, y) => x.page_number - y.page_number);
        check('4p. renumbered to a clean 1-4 (no gaps)',
          mine5.length === 4 && mine5.every((x, i) => x.page_number === i + 1),
          JSON.stringify(mine5.map(x => `#${x.page_number}`)));
        r5 = await fetch(base + `/api/admin/comic-pages/${delIds[4]}`, { method: 'DELETE', headers: adminGet });
        check('4q. DELETE the LAST page → 200', r5.status === 200, `status ${r5.status}`);
        await r5.text();
        mine5 = (await content()).body.pages.filter(x => x.comic_id === delComic).sort((x, y) => x.page_number - y.page_number);
        check('4r. clean 1-3 after the last-page delete',
          mine5.length === 3 && mine5.every((x, i) => x.page_number === i + 1),
          JSON.stringify(mine5.map(x => `#${x.page_number}`)));
      } else {
        check('4o-4r. 5-page fixture setup', false, `only ${delIds.length}/5 pages created — renumber checks skipped`);
      }
      r5 = await fetch(base + '/api/admin/comic-pages/99999999', { method: 'DELETE', headers: adminGet });
      let t5 = await r5.text();
      check('4s. DELETE bogus page id → 404 "Not found"', r5.status === 404 && /Not found/.test(t5), `got ${r5.status} ${t5}`);
      r5 = await fetch(base + `/api/admin/comics/${delComic}`, { method: 'DELETE', headers: adminGet });
      check('4t. cleanup: DELETE the 5-page comic → 200', r5.status === 200, `status ${r5.status}`);
      await r5.text();

      // ---- B18: the caption POSITION model + caption-only pages + the
      // per-comic theme colour (its own comic, deleted at the end → the run
      // still leaves the DB exactly as it found it). ----
      {
        r5 = await fetch(base + '/api/admin/comics', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ title: `B24 b18 comic ${ts}`, theme_colour: '#ff0000' }),
        });
        const jb = await r5.json().catch(() => ({}));
        const b18Id = jb.id;
        check('4u. POST comic WITH theme_colour → 201 + the colour persists',
          r5.status === 201 && (await content()).body.comics.find(x => x.id === b18Id)?.theme_colour === '#ff0000',
          `status ${r5.status}`);

        // An IMAGE page: caption_position must default to 'top', and the
        // round-4 dual-slot columns must exist and start NULL.
        r5 = await fetch(base + '/api/admin/comic-pages', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ comic_id: b18Id, page_number: 1, file_path: `/uploads/comics/${ts}/b18.png` }),
        });
        const b18img = (await content()).body.pages.find(x => x.comic_id === b18Id);
        check('4v. POST image page → 201, position "top", dual slots NULL',
          r5.status === 201 && b18img && b18img.caption_position === 'top'
          && b18img.caption_top === null && b18img.caption_bottom === null,
          `status ${r5.status} ${JSON.stringify(b18img)}`);

        // A CAPTION-ONLY page (position 'page', NO file_path).
        r5 = await fetch(base + '/api/admin/comic-pages', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ comic_id: b18Id, page_number: 2, caption_position: 'page', caption: 'standalone' }),
        });
        check('4w. POST caption-only page (position "page") → 201', r5.status === 201, `status ${r5.status}`);
        let b18mine = (await content()).body.pages.filter(x => x.comic_id === b18Id).sort((a, b) => a.page_number - b.page_number);
        const b18cap = b18mine.find(x => x.caption_position === 'page');
        check('4x. caption-only page persisted: file_path NULL, caption kept, its own row',
          b18cap && b18cap.file_path === null && b18cap.caption === 'standalone' && b18mine.length === 2,
          JSON.stringify(b18mine));

        // The two 400s: 'page' WITH a file_path; top/bottom WITHOUT one.
        r5 = await fetch(base + '/api/admin/comic-pages', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ comic_id: b18Id, page_number: 3, caption_position: 'page', file_path: '/x.png' }),
        });
        let t5 = await r5.text();
        check('4y. POST "page" WITH file_path → 400', r5.status === 400 && /no file_path/i.test(t5), `got ${r5.status} ${t5}`);
        r5 = await fetch(base + '/api/admin/comic-pages', {
          method: 'POST', headers: adminH,
          body: JSON.stringify({ comic_id: b18Id, page_number: 3, caption_position: 'bottom' }),
        });
        t5 = await r5.text();
        check('4z. POST top/bottom WITHOUT file_path → 400', r5.status === 400, `got ${r5.status} ${t5}`);

        // ---- B18 round 4 — the DUAL-SLOT contract (one page, BOTH slots):
        // `slot:'top'`/`'bottom'` routes the caption into caption_top /
        // caption_bottom; an explicit null clears THAT slot only; `slot`
        // absent = the legacy `caption` column (old clients keep working).
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: 'TOP', slot: 'top' }),
        });
        check('4aa. PATCH {caption,slot:"top"} → 200 + writes caption_top',
          r5.status === 200 && (await content()).body.pages.find(x => x.id === b18img.id)?.caption_top === 'TOP',
          `status ${r5.status}`);
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: 'BOT', slot: 'bottom' }),
        });
        const b18both = (await content()).body.pages.find(x => x.id === b18img.id);
        check('4ab. slot:"bottom" → BOTH slots filled at the same time',
          r5.status === 200 && b18both?.caption_top === 'TOP' && b18both?.caption_bottom === 'BOT',
          JSON.stringify(b18both));
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: null, slot: 'top' }),
        });
        const b18cleared = (await content()).body.pages.find(x => x.id === b18img.id);
        check('4ac. explicit null + slot:"top" clears the top slot ONLY',
          r5.status === 200 && b18cleared?.caption_top === null && b18cleared?.caption_bottom === 'BOT',
          JSON.stringify(b18cleared));
        // `slot` ABSENT = the legacy contract (the `caption` column) — old clients.
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: 'LEG' }),
        });
        const b18legacy = (await content()).body.pages.find(x => x.id === b18img.id);
        check('4ad. no `slot` → the legacy `caption` column (slots untouched)',
          r5.status === 200 && b18legacy?.caption === 'LEG' && b18legacy?.caption_bottom === 'BOT',
          JSON.stringify(b18legacy));
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: null }),
        });
        const b18cleared2 = (await content()).body.pages.find(x => x.id === b18img.id);
        check('4ae. legacy null clears the `caption` column (slots untouched)',
          r5.status === 200 && b18cleared2?.caption === null && b18cleared2?.caption_bottom === 'BOT',
          JSON.stringify(b18cleared2));

        // Flip the image page's position top → bottom → top.
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption_position: 'bottom' }),
        });
        check('4af. PATCH caption_position → "bottom" → 200', r5.status === 200, `status ${r5.status}`);
        await r5.text();
        check('4ag. the position persisted as "bottom"',
          (await content()).body.pages.find(x => x.id === b18img.id)?.caption_position === 'bottom');
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption_position: 'top' }),
        });
        await r5.text();
        check('4ah. flipped back to "top"',
          (await content()).body.pages.find(x => x.id === b18img.id)?.caption_position === 'top');

        // A PATCH that OMITS caption_position keeps the current one.
        r5 = await fetch(base + `/api/admin/comic-pages/${b18img.id}`, {
          method: 'PATCH', headers: adminH, body: JSON.stringify({ caption: 'kept' }),
        });
        await r5.text();
        check('4ai. PATCH caption (no position) keeps "top" + sets the caption',
          (await content()).body.pages.find(x => x.id === b18img.id)?.caption_position === 'top' &&
          (await content()).body.pages.find(x => x.id === b18img.id)?.caption === 'kept');

        // Theme colour: update it, then CLEAR it (explicit null), then confirm
        // an OMITTED field keeps its value (PUT is a partial update).
        r5 = await fetch(base + `/api/admin/comics/${b18Id}`, {
          method: 'PUT', headers: adminH, body: JSON.stringify({ theme_colour: '#00ff00' }),
        });
        check('4aj. PUT theme_colour → 200', r5.status === 200, `status ${r5.status}`);
        await r5.text();
        check('4ak. the colour updated to #00ff00',
          (await content()).body.comics.find(x => x.id === b18Id)?.theme_colour === '#00ff00');
        r5 = await fetch(base + `/api/admin/comics/${b18Id}`, {
          method: 'PUT', headers: adminH, body: JSON.stringify({ theme_colour: null }),
        });
        await r5.text();
        check('4al. PUT theme_colour: null CLEARS it (back to NULL)',
          (await content()).body.comics.find(x => x.id === b18Id)?.theme_colour === null);
        r5 = await fetch(base + `/api/admin/comics/${b18Id}`, {
          method: 'PUT', headers: adminH, body: JSON.stringify({ title: `B24 b18 comic ${ts} (renamed)` }),
        });
        await r5.text();
        check('4am. PUT without theme_colour keeps the value + updates the title',
          (await content()).body.comics.find(x => x.id === b18Id)?.theme_colour === null &&
          (await content()).body.comics.find(x => x.id === b18Id)?.title === `B24 b18 comic ${ts} (renamed)`);

        // Cleanup — the B18 comic (cascades its pages). Net DB change: zero.
        r5 = await fetch(base + `/api/admin/comics/${b18Id}`, { method: 'DELETE', headers: adminGet });
        check('4an. cleanup: DELETE the B18 comic → 200', r5.status === 200, `status ${r5.status}`);
        await r5.text();
        check('4ao. the B18 comic + its pages are gone (net-zero)',
          !(await content()).body.comics.find(x => x.id === b18Id) &&
          (await content()).body.pages.filter(x => x.comic_id === b18Id).length === 0);
      }

      // non-admin → 403 on the write routes (POST with the user's own token)
      let r2 = await fetch(base + '/api/admin/comics', {
        method: 'POST', headers: userCSRF, body: JSON.stringify({ title: 'x' }),
      });
      let t2 = await r2.text();
      check('4l. POST comic non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/comic-pages/1`, { method: 'PATCH', headers: userH, body: JSON.stringify({ caption: 'x' }) });
      t2 = await r2.text();
      check('4m. PATCH page non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/comics/1`, { method: 'DELETE', headers: userH });
      t2 = await r2.text();
      check('4n. DELETE comic non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
    }

    // ============ 5. images + videos =========================================
    {
      let r = await fetch(base + '/api/admin/images', {
        method: 'POST', headers: adminH,
        body: JSON.stringify({ title: `B24 image ${ts}`, caption: 'cap1', file_path: uploadPath || '/uploads/images/x.png', is_member: 1 }),
      });
      let j = await r.json().catch(() => ({}));
      check('5a. POST /api/admin/images → 201 {id}', r.status === 201 && Number.isInteger(j.id),
        `status ${r.status} ${JSON.stringify(j)}`);
      const imgId = j.id;

      r = await fetch(base + `/api/admin/images/${imgId}`, {
        method: 'PUT', headers: adminH, body: JSON.stringify({ caption: 'cap2' }),
      });
      check('5b. PUT image caption → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      let c = (await content()).body;
      check('5c. image caption persisted',
        c.images.find(x => x.id === imgId)?.caption === 'cap2');

      r = await fetch(base + `/api/admin/images/${imgId}`, { method: 'DELETE', headers: adminGet });
      check('5d. DELETE image → 200, then gone',
        r.status === 200 && !(await (await content()).body.images.find(x => x.id === imgId)), `status ${r.status}`);
      await r.text();

      r = await fetch(base + '/api/admin/videos', {
        method: 'POST', headers: adminH,
        body: JSON.stringify({ title: `B24 video ${ts}`, description: 'vd', caption: 'vcap1', file_path: uploadPath || '/uploads/videos/x.mp4' }),
      });
      j = await r.json().catch(() => ({}));
      check('5e. POST /api/admin/videos → 201 {id}', r.status === 201 && Number.isInteger(j.id),
        `status ${r.status} ${JSON.stringify(j)}`);
      const vidId = j.id;

      r = await fetch(base + `/api/admin/videos/${vidId}`, {
        method: 'PUT', headers: adminH, body: JSON.stringify({ caption: 'vcap2' }),
      });
      check('5f. PUT video caption → 200', r.status === 200, `status ${r.status}`);
      await r.text();
      c = (await content()).body;
      check('5g. video caption persisted (description kept)',
        c.videos.find(x => x.id === vidId)?.caption === 'vcap2' &&
        c.videos.find(x => x.id === vidId)?.description === 'vd');

      r = await fetch(base + `/api/admin/videos/${vidId}`, { method: 'DELETE', headers: adminGet });
      check('5h. DELETE video → 200, then gone',
        r.status === 200 && !(await (await content()).body.videos.find(x => x.id === vidId)), `status ${r.status}`);
      await r.text();

      // non-admin → 403 (POST with the user's own token)
      let r2 = await fetch(base + '/api/admin/images', {
        method: 'POST', headers: userCSRF, body: JSON.stringify({ title: 'x', file_path: 'y' }),
      });
      let t2 = await r2.text();
      check('5i. POST image non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/images/1`, { method: 'PUT', headers: userH, body: JSON.stringify({ caption: 'x' }) });
      t2 = await r2.text();
      check('5j. PUT image non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/images/1`, { method: 'DELETE', headers: userH });
      t2 = await r2.text();
      check('5k. DELETE image non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + '/api/admin/videos', {
        method: 'POST', headers: userCSRF, body: JSON.stringify({ title: 'x', file_path: 'y' }),
      });
      t2 = await r2.text();
      check('5l. POST video non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/videos/1`, { method: 'PUT', headers: userH, body: JSON.stringify({ caption: 'x' }) });
      t2 = await r2.text();
      check('5m. PUT video non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
      r2 = await fetch(base + `/api/admin/videos/1`, { method: 'DELETE', headers: userH });
      t2 = await r2.text();
      check('5n. DELETE video non-admin → 403 "Not admin"', r2.status === 403 && /Not admin/.test(t2), `got ${r2.status}`);
    }

    // ============ 6. schema ===================================================
    {
      const cols = (t) => jsonBody(`PRAGMA table_info(${t})`).map(r => `${r.name}:${r.type}`);
      const cp = cols('comic_pages');
      const cm = cols('comics');
      const im = cols('images');
      const vi = cols('videos');
      check('6a. schema: comic_pages has caption (Step 2)', cp.includes('caption:TEXT'), cp.join(', '));
      check('6b. schema: images has caption + updated_at INTEGER (Step 2 + Step 6)',
        im.includes('caption:TEXT') && im.includes('updated_at:INTEGER'), im.join(', '));
      check('6c. schema: videos has caption + updated_at INTEGER (Step 2 + Step 6)',
        vi.includes('caption:TEXT') && vi.includes('updated_at:INTEGER'), vi.join(', '));
      // B18 — the caption position model + the per-comic theme colour.
      check('6d. schema: comic_pages has caption_position (B18)', cp.includes('caption_position:TEXT'), cp.join(', '));
      check('6e. schema: comics has theme_colour (B18)', cm.includes('theme_colour:TEXT'), cm.join(', '));
    }
  } finally {
    try { s.child.kill(); } catch { /* already gone */ }
  }

  // --- cleanup: the scratch file + the uploaded artifact (C3: regenerable) ---
  rmSync(SCRATCH, { recursive: true, force: true });
  if (uploadedDir) rmSync(uploadedDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\nAll B2.4 checks passed ✅' : `\n${failures} check(s) FAILED ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  check('test infrastructure (server boot / ready)', false, e.message);
  // best-effort cleanup on the failure path too
  rmSync(SCRATCH, { recursive: true, force: true });
  if (uploadedDir) rmSync(uploadedDir, { recursive: true, force: true });
});
// Safety net: force-exit if a live socket keeps the loop alive (A1's pattern).
setTimeout(() => process.exit(process.exitCode ?? 0), 8000).unref();
