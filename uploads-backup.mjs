// uploads-backup.mjs — safety net for public/uploads (the admin editors' image files).
//
// WHY: public/uploads is gitignored and treated as regenerable (C3 — Render's
// free-tier disk is wiped on every deploy, and the .gitignore note says "re-upload
// test content each time"). On 2026-10-01 the comics folder was wiped from this
// checkout anyway (56 of 68 comic pages lost; the app code never deletes uploads —
// server.js has no rmSync call, test-b24.mjs only removes ITS OWN uuid dir — and
// the originals survived in the user's D:\Downloads, where 56 were recovered; the
// 11 unrecoverable were test/seed artifacts only). This keeps a workspace-local
// mirror so any future wipe is a one-command restore, not data loss.
//
//   node uploads-backup.mjs backup     # public/uploads -> uploads-backup (merge copy)
//   node uploads-backup.mjs restore    # uploads-backup -> public/uploads (merge copy)
//
// Both directions are plain recursive MERGE copies (node:fs only, no deps):
// files are created/overwritten, directories created, nothing is ever deleted —
// so neither direction can nest or destroy anything. Backup may leave stale
// mirror entries (harmless); restore overwrites same-path files.
// Run `backup` after any batch of uploads — it is idempotent.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

function mergeCopy(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const s = path.join(srcDir, name)
    const d = path.join(dstDir, name)
    if (statSync(s).isDirectory()) mergeCopy(s, d)
    else copyFileSync(s, d)
  }
}

const SRC_REL = 'public/uploads'
const DST_REL = 'uploads-backup'
const mode = process.argv[2]

if (mode !== 'backup' && mode !== 'restore') {
  console.log('usage: node uploads-backup.mjs backup|restore')
  process.exit(1)
}
const src = mode === 'backup' ? SRC_REL : DST_REL
const dst = mode === 'backup' ? DST_REL : SRC_REL
if (!existsSync(src)) {
  console.error(`nothing to do — ${src} does not exist`)
  process.exit(1)
}
mergeCopy(src, dst)
console.log(`${mode}: ${src} -> ${dst} (merge copy done, nothing deleted)`)
