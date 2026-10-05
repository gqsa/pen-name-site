import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ResizableSection from './ResizableSection.jsx'
// B18 round 5 — the text-pane engine (pure, no React): serialize the comic to
// the markdown the owner edits, parse it back to blocks, and build the applyDoc
// target (the reorder + caption + placeholder reconciliation). toPlainText is
// the copy button's "plain text" (the punctuation markup stripped).
import { comicToMarkdown, markdownToBlocks, buildTargetDoc, toPlainText } from './textMode.js'

// B2.5 — the comic editor — shell + dropzone/upload + drag-reorder + caption auto-save.
//
// Built up over the B2.5 steps on the Step-1 shell (read-only list/preview):
//   • Step 2 — a dropzone at the top of the left pane with THREE input paths:
//       drag/drop a batch of images · single-click = paste from the
//       clipboard · double-click = the OS file picker.
//       (A double-click also fires TWO click events, so a single click is
//       deferred behind a 250 ms timer the double-click cancels.)
//     The upload pipeline: each image → POST /api/admin/upload (multipart,
//     `kind` BEFORE `file`, NO Content-Type header) → POST
//     /api/admin/comic-pages { comic_id, page_number = max+1, file_path }
//     — sequential (multer is single-file), optimistic local append so the
//     list + preview update immediately, stop + error line on any failure.
//   • Step 3 — native HTML5 drag-reorder on the page rows (drop on a row =
//     that position, drop on the list body = last), applied optimistically
//     and persisted via PATCH /api/admin/comics/:id/reorder (full exact
//     page set), rolled back on failure.
//   • Step 4 — a caption input above each page thumbnail; every change
//     debounces (~600 ms, per page id) into ONE
//     PATCH /api/admin/comic-pages/:id { caption } — blank → null (an
//     explicit null CLEARS the server-side caption), no save button by design.
//
//   • Step 7 — the preview becomes a BOUNDED, internally-scrolling window;
//     an `activePageId` (a PAGE id — `selectedId` stays the comic) with
//     two-way sync (row click → active + centred in the window; figure
//     click → active + row highlighted) and an all/active toggle
//     (`previewMode` 'all' | 'active', default 'all').
//   • Step 8 — the caption editor MOVED into the preview: the (unchanged)
//     Step-4 caption input now sits above the ACTIVE page's image, centred at
//     the image's width (the figure is fit-content, so input + image share one
//     width), with the save cues; the left-pane rows lost their caption bars
//     (thumbnail + "Page N" only). The debounce / PATCH / save-state code is
//     the SAME Step-4 code — moved, not rewritten.
//   • Step 9 — the left page list is now a grid of fixed SQUARE (1:1) tiles
//     (`.page-grid` / `.page-tile`): many pages visible at once (≥5/row at the
//     editor's width), a "Page N" corner label, the file name as the hover
//     tooltip (title — Step 10's zoomed-out file-name list will reuse it), and
//     the Step-7 active highlight + click-to-activate and the Step-3 reorder
//     DnD all living on the tiles. Step 10 adds wheel zoom on top; Step 14 adds
//     file-insertion — the two paths stay separable (a reorder drag carries
//     `text/plain`, never `Files`; an OS file drag never lifts a tile).
//   • Step 9.5 — the PREVIEW is a second reorder surface: figures are
//     draggable (the SAME onRowDragStart / reorder() as the tiles), a
//     dragover shows the insertion slot as a red bar above/below the target
//     figure (slot = first figure whose vertical midpoint is below the
//     pointer, else last), the window auto-scrolls when the pointer nears
//     its top/bottom edge, and a drop maps the visible slot onto the FULL
//     page list (matters in "active page only" mode, which shows a subset).
//     Cross-pane works for free: a tile drag drops on the preview and a
//     figure drag drops on the tiles — one dragIdRef, one reorder(), so the
//     two panes can never disagree.
//   • Step 12 (+ 12.5a) — delete a page: a hover trash bin on each PREVIEW
//     page (top-right) and on each TILE / zoomed-out list row (each deletes
//     the page it points at) + an always-visible "Delete" pill in the Pages
//     heading row and the Delete key (both delete the ACTIVE page; the key
//     is inert while a text field has focus — a caption being typed must
//     stay editable). Each delete: confirm → DELETE
//     /api/admin/comic-pages/:id (the server renumbers the remaining pages
//     to a clean 1..N — the old handler left gaps) → local splice + renumber
//     (mirror of the server) + a count notice; the active page falls back to
//     the new first page ONLY when the deleted page WAS the active one
//     (or "No pages yet." when the comic is emptied).
//   • Step 12.5b — MULTI-select: a Ctrl/Cmd+click on a tile/row/figure
//     TOGGLES it in `selectedIds` (a plain click = the single page; the last
//     click is the PRIMARY = the active page, which keeps the caption
//     editor). A softer --selected outline marks the other selected pages.
//     The "Delete" pill (label carries the count) + the Delete key delete
//     the WHOLE selection at once — one confirm, a sequential loop of
//     DELETEs (stable ids, no backend change), ONE optimistic splice+renumber,
//     and a whole-batch rollback if any delete fails. Esc collapses the
//     selection back to the primary.
//   • Step 12.5d — arrow-key navigation (simple Windows behaviour): a PLAIN
//     arrow moves the active page to the neighbour in that direction and
//     clears any multi-selection — the neighbour is a true GRID cell (one
//     row/column, clamped at the edges) when the selection was last made on
//     the PAGES window, or the PREVIOUS/NEXT page in page order when it was
//     made in the PREVIEW (page 8 → Up → page 7, not whatever tile sits
//     physically above). SHIFT+arrow grows and SHRINKS the selection as the
//     range from the anchor to the neighbour (moving back to the anchor
//     deselects); Shift+click selects the anchor→page range. Ctrl+click
//     still toggles. All of it is inert while a text field has focus.
//   • Step 11.5b — the TILE WINDOW's drop-position indicator (the Step-9.5
//     concept ported to the 2D grid): ONE dragover handler on the grid <ul>
//     (the old per-tile + per-list pair fought over the same event — the
//     list-level one ran last and cleared the tile's, so the old
//     .page-tile--drop-target ring never actually showed) resolves the hover
//     to the LANDING SLOT (the index the drop handler splices at) and marks
//     that single cell — the grid wraps, so "between two tiles" is a slot
//     index, not a visual gap. The marker and the drop share ONE slot model
//     (resolveGridSlot), so the drop always lands exactly where the marker
//     was. Covers BOTH drag sources (tile→tile + the preview→tile cross-pane
//     drop — one dragIdRef, one reorder()). In the list regime (fully zoomed
//     out) a row drop lands LAST (rows have no per-row drop), so the marker
//     is the last row there.
//   • Step 11.5c — the drop indicator is now the WHITE edge(s) bracketing the
//     drop GAP (not a red ring on a cell): red stays reserved for the
//     selection/active rings, so white = "the drop lands here." Hover→gap is
//     POSITION-AWARE in both regimes — grid: a tile's LEFT half = the gap
//     before it, RIGHT half = the gap after it (the last tile's right half =
//     the end gap; the GUTTER stays the end gap, 11.5b); list: a row's TOP
//     half = before it, BOTTOM half = after it, and the list BODY (the ul) =
//     a row-top scan (above the first row = the start gap, between rows =
//     that gap, below the last = the end gap). ONE resolver (gapFromEvent)
//     feeds the marker AND every grid drop (the 11.5b invariant), and
//     planBlockDrop is UNCHANGED (the 12.5e block model is as-is). The preview
//     bar just recolors to #fff (no logic change). RECORD: Step 14 (file
//     insertion) MUST use this same resolver — its "over a tile → before that
//     page" means the LEFT half; a right-half hover = the gap AFTER the page
//     (the batch-order rule is unchanged).
//
// Still NOT here: B4 marquee / crop selection (a later step).
// Keep the state shape stable.
//
// Data (B2.4 contract — pinned, don't re-derive):
//   • GET /api/admin/content  (GET = CSRF-exempt, no token needed)
//       → { comics, pages, stories, images, videos, counts }
//         comics: [{ id, title, description, publish_date, is_member, tier_id, created_at, updated_at }]
//         pages : [{ id, comic_id, page_number, file_path, caption }]   ← the key is "pages"
//   • POST /api/admin/comics       { title }  (JSON + X-CSRF-Token) → 201 { success, id }
//   • POST /api/admin/upload       multipart kind='comics' + file      → { success, file_path, … }
//   • POST /api/admin/comic-pages  { comic_id, page_number, file_path } → 201 { success, id }
//   • PATCH /api/admin/comics/:id/reorder  { page_ids: [idA, idB, …] }  → { success, … }
//     CONTRACT: page_ids must be EXACTLY the comic's current full page set, in
//     the new order — a partial or duplicate list is a 400 (never a silent
//     patch). The server does the two-phase renumber; we just send the ids.
//   • PATCH /api/admin/comic-pages/:id  { caption }  → { success, id }
//     Caption semantics: an explicit null CLEARS the caption; '' would store
//     an empty string — so the editor maps blank → null.
//   • DELETE /api/admin/comic-pages/:id  → { success, comic_id, count }
//     (B2.5 Step 12) the server RENUMBERS the comic's remaining pages to a
//     clean 1..N (the old handler left gaps); `count` = the remaining length
//     (the server's truth — the editor mirrors it locally + splices).
//
// Layout note: the shell's `.wrap` column is 780px — too narrow for a two-column
// split view. This component therefore renders as a SIBLING of `.wrap` (see the
// ok-branch in App.jsx) and owns its own wider `.comic-editor` container (~1100px).

// --- Upload helpers (module-level, no hooks) ---------------------------------

// The server saves files under their ORIGINALNAME (server.js multer
// `filename`), and express.static infers the MIME type from the extension —
// so a name without an extension (a raw clipboard blob arrives as
// `filename="blob"`) would be served with no image content type. Derive a
// sensible extension from the MIME type when we have to name a blob ourselves.
function extForImageType(mime) {
  const sub = String(mime).split('/')[1] || ''
  if (sub === 'jpeg') return 'jpg'
  if (/^[a-z0-9]+$/.test(sub)) return sub
  return 'img'
}

// Step 9 — the FILE NAME for a tile's hover tooltip (and Step 10's zoomed-out
// file-name list): the last path segment of the server file_path
// (e.g. /uploads/comics/<uuid>/page-2.png → "page-2.png"). The uuid folder is
// opaque, so the owner's own file name is what they can recognise.
function fileNameOf(file_path) {
  const segs = String(file_path || '').split('/').filter(Boolean)
  return segs.length ? segs[segs.length - 1] : 'image'
}

// B18 — the caption TEXT colour that stays legible on a comic's theme colour.
// Relative luminance (the WCAG weights, sRGB 0..255): a light theme gets a
// dark caption, a dark theme gets a light one. null/invalid input → null
// (the caller then leaves the default `color` untouched).
function legibleTextOn(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 150 ? '#1a1a1a' : '#ffffff'
}

// B18 round 4, pt 6 — the ACTUAL default caption background when no theme is
// set: the caption bars are transparent and sit on the preview surface
// (.comic-preview { background: var(--card) }), so a cleared swatch must show
// THAT colour — not the white an empty <input type="color"> defaults to
// (owner: "the theme colour box shows white for some reason instead of
// whatever the actual default is"). The CSS variable is the source of truth;
// this is its JS mirror (the fallback matches index.css's `--card`).
const DEFAULT_CAPTION_BG = (() => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--card').trim().toLowerCase()
    if (/^#[0-9a-f]{3,8}$/.test(v)) return v
  } catch { /* no document (tests/SSR) — fall through to the mirror */ }
  return '#161616'
})()

// B18 round 4 — the ONE shared slot → column map, used by every caption
// read/write in this file: 'top' → caption_top, 'bottom' → caption_bottom,
// 'page' (or anything else) → caption (caption-ONLY pages).
const slotOf = (slot) => (slot === 'top' ? 'caption_top' : slot === 'bottom' ? 'caption_bottom' : 'caption')

// B18 round 6, pt 4 — the round-4 SCREEN-PICK fallback for browsers without
// the EyeDropper API (pickColourFromScreen, a getDisplayMedia full-screen
// capture) was DELETED at the owner's request: "the eyedropper using the
// share screen with the site is very concerning. is there no other way to do
// this?" Where the browser lacks the EyeDropper API the button now opens the
// NATIVE <input type="color"> picker (a hidden input, showPicker()) — no
// screen capture, no permission prompt.

// B18 round 3, pt 5 — does `pageId` have a NEIGHBOURING caption-only page
// (the one right before or the one right after in page_number order)? The
// Merge button folds a caption page into the nearest CAPTION PAGE (the owner:
// "there shouldn't be an option to merge a caption page with an actual page")
// — an image page is NEVER a merge destination — so this drives the Merge
// button's disabled state. (Round 2's `hasImageNeighbor` is superseded.)
function hasCaptionPageNeighbor(pages, pageId) {
  const i = pages.findIndex(x => x.id === pageId)
  if (i === -1) return false
  if (i > 0 && !pages[i - 1].file_path) return true
  if (i < pages.length - 1 && !pages[i + 1].file_path) return true
  return false
}

// B18 round 3, pt 4 — the nearest caption-only page to `pageId` (the closest
// one before it, else the closest one after), or null when there is none.
// The merge BUTTON's destination; the DRAG path uses the exact drop target
// instead, so the two can legitimately differ.
function nearestCaptionPage(pages, pageId) {
  const i = pages.findIndex(x => x.id === pageId)
  if (i === -1) return null
  for (let j = i - 1; j >= 0; j--) if (!pages[j].file_path) return pages[j]
  for (let j = i + 1; j < pages.length; j++) if (!pages[j].file_path) return pages[j]
  return null
}

// Step 10 — wheel-zoom regime bounds (Windows-folder style). `zoom` runs
// 0 (fully OUT = a vertical file-name list) .. 100 (fully IN = one tile fills
// the section); between = the Step-9 grid with a scaled tile size. Shared by
// the component (state + CSS `--tile`) so the numbers live in one place.
const ZOOM_LIST_MAX = 20   // zoom <= this → the file-name list (fully out)
const ZOOM_FILL_MIN = 80   // zoom >= this → one tile fills the section (fully in)
const ZOOM_STEP = 6        // one wheel notch
const GRID_TILE_MIN = 72   // px, the grid regime's low end
const GRID_TILE_MAX = 260  // px, the grid regime's high end

// Step 11.5a — remember the tile zoom level. ONE global value (like a
// folder-view zoom setting — not per-comic): it survives a hard reload AND
// comic switches. localStorage is browser-side, so it also survives
// Render's free-tier disk wipes. try/catch'd: a blocked storage degrades to
// the default mid grid (session-only). Corrupt/absent → default 50.
const ZOOM_STORAGE_KEY = 'gqsa.comicTileZoom'
const ZOOM_DEFAULT = 50
function readStoredZoom() {
  try {
    const raw = window.localStorage.getItem(ZOOM_STORAGE_KEY)
    if (raw == null) return ZOOM_DEFAULT
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 0 || n > 100) return ZOOM_DEFAULT
    return n
  } catch { return ZOOM_DEFAULT }
}
function storeZoom(z) {
  try { window.localStorage.setItem(ZOOM_STORAGE_KEY, String(z)) } catch { /* session-only */ }
}

// 2026-09-28 — remember the SELECTED comic (the one the owner has open).
// ONE global value (not per-comic): it survives a hard reload so the editor
// re-opens the comic the owner was working on, instead of always snapping
// back to the first comic. Same posture as the tile zoom above:
// localStorage is browser-side (survives Render's free-tier disk wipes) and
// try/catch'd — a blocked storage degrades to the default (first comic).
// The id is validated against the live comic list in `load()` (a stale id —
// the comic was deleted — falls back to the first comic and the effect below
// overwrites the stored value with the valid one).
const SELECTED_COMIC_STORAGE_KEY = 'gqsa.comicSelected'
function readStoredSelectedComic() {
  try {
    const raw = window.localStorage.getItem(SELECTED_COMIC_STORAGE_KEY)
    if (raw == null) return null
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 1) return null
    return n
  } catch { return null }
}
function storeSelectedComic(id) {
  try { window.localStorage.setItem(SELECTED_COMIC_STORAGE_KEY, String(id)) } catch { /* session-only */ }
}

// --- B18 round 5 — "was in text mode" REMEMBERED per comic (browser-specific).
// The owner asked the editor to REMEMBER its state per comic and, on return,
// auto-return to text mode. The remembered flag is browser-specific (this
// browser's localStorage); the CROSS-browser signal is the server draft. So:
// this browser auto-returns to text mode for a comic it last left in text mode,
// and (separately) ANY browser sees the red "unsaved" indicators for a comic
// with a server draft. The flag is set when entering text mode and cleared
// when a clean regeneration/update leaves text mode.
const TEXTMODE_REMEMBER_PREFIX = 'gqsa.comicTextMode.'
function readRememberedTextMode(comicId) {
  try {
    return window.localStorage.getItem(TEXTMODE_REMEMBER_PREFIX + comicId) === '1'
  } catch { return false }
}
function storeRememberedTextMode(comicId, on) {
  try {
    if (on) window.localStorage.setItem(TEXTMODE_REMEMBER_PREFIX + comicId, '1')
    else window.localStorage.removeItem(TEXTMODE_REMEMBER_PREFIX + comicId)
  } catch { /* session-only */ }
}

// --- B18 round 5 — the shared text-mode draft envelope ----------------------
// The draft is the owner's un-updated text-mode edits. It is stored SERVER-side
// (the text_drafts table) so it is shared across browsers (any browser that
// opens this comic sees it). The FROZEN number→pageId map is part of what makes
// the edits meaningful (a [media N] marker only resolves to a page with the
// map), so it is persisted IN the draft too. The server stores a single TEXT
// blob; we encode it as a small JSON envelope { v, text, map }. A draft that is
// not a valid envelope (an older/plain-text draft) degrades to { text, map:∅ }.
function draftEncode(text, map) {
  return JSON.stringify({
    v: 1,
    text: String(text ?? ''),
    map: Object.fromEntries(map ? map.entries() : []),
  })
}
function draftDecode(raw) {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  try {
    const o = JSON.parse(raw)
    if (o && typeof o.text === 'string') {
      const m = new Map()
      const src = o.map && typeof o.map === 'object' ? o.map : {}
      for (const [k, v] of Object.entries(src)) m.set(Number(k), v)
      return { text: o.text, map: m }
    }
    return null
  } catch {
    return { text: raw, map: new Map() }
  }
}

// 2026-09-28 follow-up — WINDOW-scoped scroll helpers. The old centre effect
// used `el.scrollIntoView()`, which scrolls EVERY scrollable ancestor up to
// the viewport — including the DOCUMENT itself: with the active page on
// 1–3, toggling "active page only" OFF scrolled the whole page up a little.
// These scroll only the target's OWN window (the nearest overflow-y:
// auto/scroll ancestor) and never touch the document's scroll position.
function scrollerOf(el) {
  let n = el.parentElement
  while (n && n !== document.body) {
    const oy = window.getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
    n = n.parentElement
  }
  return null
}
function scrollWindowTo(el, scroller, mode) {
  if (!scroller) return
  const r = el.getBoundingClientRect()
  const c = scroller.getBoundingClientRect()
  if (mode === 'center') {
    // centre el in the scroller's visible area (clamped at the top — the
    // early pages can't be centred above the content, so they just sit at 0)
    const target = scroller.scrollTop + (r.top - c.top) - (scroller.clientHeight - el.offsetHeight) / 2
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  } else {
    // 'nearest' — reveal at the edge, a no-op when already visible (the old
    // scrollIntoView({ block: 'nearest' }) semantics, minus the document)
    const pad = 8
    if (r.top < c.top + pad) scroller.scrollBy({ top: r.top - c.top - pad, behavior: 'smooth' })
    else if (r.bottom > c.bottom - pad) scroller.scrollBy({ top: r.bottom - c.bottom + pad, behavior: 'smooth' })
  }
}

// THE upload call (the house pattern — copied shape, `kind` BEFORE `file`,
// no Content-Type: the browser sets the multipart boundary).
async function uploadImage(file, csrfToken) {
  const fd = new FormData()
  fd.append('kind', 'comics')
  fd.append('file', file)
  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    body: fd,   // the multipart body itself — without this the request goes out empty → 400 "No file field"
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `upload answered ${res.status}`)
  }
  return res.json()
}

// Step 12.5a — the trash icon (inline SVG, ~14px, currentColor so it follows
// the button's text colour) + the hover BIN button (preview page / tile /
// list row). The hover reveal (invisible until the parent is hovered) lives
// in index.css on `.page-bin`.
function PageBinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function PageBin({ title, disabled, onClick }) {
  return (
    <button
      type="button"
      className="page-bin"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <PageBinIcon />
    </button>
  )
}

// B18 round 3, pt 15 — the FAKE caption page: "I want a + on the preview
// plane and in the position of first tile when there are no pages in the
// editor… a false caption page with the site's theme red that says 'Disrupt
// the narrative...' in white italics, with the '+' sign centralised below
// it." Purely a visual anchor — NO page exists until it is clicked
// (onAdd → insertCaptionPageAt(0) → a real caption page of the default
// colour, slot 0). It vanishes the moment any real page is added — the two
// empty states are plain `selectedPages.length === 0` conditionals, so the
// fake page can never coexist with real pages (noted in progress.md).
function FakeCaptionPage({ onAdd }) {
  return (
    <div
      className="fake-caption-page"
      role="button"
      tabIndex={0}
      title="Add a caption page"
      aria-label="Add a caption page"
      onClick={onAdd}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd() }
      }}
    >
      <span className="fake-caption-text">Disrupt the narrative…</span>
      <span className="fake-caption-plus" aria-hidden="true">+</span>
    </div>
  )
}

// Step 13 — the FILE-vs-REORDER disambiguation. An OS file drag carries the
// 'Files' type on dataTransfer; an internal tile/preview reorder drag never
// does (it only sets 'text/plain', for Firefox's "set something or no drag"
// requirement). The section's file-drop path fires ONLY when this is true; the
// reorder path is separately guarded on dragIdRef !== null (which is null for
// file drags). The two can therefore never cross-fire. Pure + case-insensitive
// (some browsers lowercase the type) so it's safe to keep out of hook deps.
function dragHasFiles(e) {
  const types = e && e.dataTransfer && e.dataTransfer.types
  if (!types) return false
  return Array.from(types).some(t => String(t).toLowerCase() === 'files')
}

export default function ComicEditor({
  csrfToken,
}) {
  // comics: array (null until the first fetch lands) — the full comic list.
  // pages : array — ALL comics' pages from the same fetch (keyed `pages`).
  // selectedId: the id of the comic being edited (a number, matching the DB id).
  const [comics, setComics] = useState(null)
  const [pages, setPages] = useState([])
  // 2026-09-28 — initialised from the remembered selection (the comic the
  // owner last had open) instead of null, so a hard reload re-opens it. `load()`
  // validates the id against the live list (a stale one falls back to the
  // first comic). A fresh browser (no stored value) starts at null, exactly
  // as before, and `load()` picks the first comic.
  const [selectedId, setSelectedId] = useState(() => readStoredSelectedComic())
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)

  // Step 2 — dropzone + pipeline state.
  const [uploading, setUploading] = useState(false)   // UI flag (drives the busy look)
  const [uploadMsg, setUploadMsg] = useState('')      // "Uploading i/N…"
  const [dragActive, setDragActive] = useState(false) // drag-over highlight
  const [notice, setNotice] = useState(null)          // green success line
  // B18 round 6b — the in-page eyedropper (round 6 pt 4 rework): the pick
  // mode the Eyedropper button enters where the browser lacks the EyeDropper
  // API, plus the live hint line shown while picking.
  const [picking, setPicking] = useState(false)       // in-page pick mode armed
  const [pickHint, setPickHint] = useState(null)      // hint line text while picking
  const fileInputRef = useRef(null)                   // hidden <input type="file">
  const clickTimer = useRef(null)                     // single-vs-double-click disambiguation
  // The authoritative in-flight flag. `uploading` (state) lags one render; a
  // ref read is always current, so two quick drops can't start two pipelines.
  const uploadingRef = useRef(false)

  // Step 3 — drag-reorder state.
  const [draggingId, setDraggingId] = useState(null)   // the row being dragged (opacity cue)
  const [reordering, setReordering] = useState(false)  // "Reordering…" cue near the Pages heading
  const reorderingRef = useRef(false)                   // authoritative in-flight guard (ref = always current)
  const dragIdRef = useRef(null)                        // the dragged page id (ref = stable across renders)
  // Step 12.5e — the ids of the BLOCK being dragged: the dragged page alone,
  // or the whole multi-selection when the dragged page is a member. Every
  // member gets the fading --dragging cue ("this group is what's moving").
  const [dragBlockIds, setDragBlockIds] = useState(null)
  const dragBlockRef = useRef(null)                      // the same ids as a ref (read at event time)
  // Step 9.5 — the preview's insertion slot: the index (into the VISIBLE
  // figure list) where a drop would land, or null when no preview dragover
  // is in progress. Drives the red before/after bar on the target figure.
  const [previewDropIdx, setPreviewDropIdx] = useState(null)
  // Step 11.5b → 11.5c — the TILE WINDOW's drop GAP: the insertion index
  // (0..n, into the comic's CURRENT page list; n = the end) where a drop over
  // the grid would land, or null when no grid dragover is in progress / the
  // drop would be a no-op. Drives the WHITE edges facing that gap (a middle
  // gap lights two tiles'/rows' facing edges — which may sit on DIFFERENT
  // rows in a wrapped grid — and a boundary gap lights ONE). The marker and
  // every drop handler share ONE resolver (gapFromEvent) + ONE plan
  // (planBlockDrop — the dragged page, or its whole selection block per
  // Step 12.5e), so the drop lands exactly where the marker was — the grid's
  // answer to the preview's before/after bar.
  const [gridDropSlot, setGridDropSlot] = useState(null)
  // B18 round 3, pt 5 — CAPTION drag state (round 2 substep 6, pulled
  // forward): an independent drag of a caption bar or a caption page (as
  // opposed to a page drag — pt 2's "dragging a caption drags the whole
  // page"). `capDragRef` holds the drag SOURCE at event time:
  //   { kind: 'bar' | 'page', pageId, text, position }
  // — `text`/`position` snapshotted at dragstart (the bar's live text is the
  // state value at that moment). `capDragPageId` (state) drives the fading
  // --dragging cue on the source's bar/frame; `capDrop` (state) drives the
  // target cues: { pageId, pos } (a page half), { pageId, merge } (onto a
  // caption/caption page) or { slot } (a gap index into the comic's page
  // list; in the preview the slot is computed from the VISIBLE index at
  // drop time).
  const capDragRef = useRef(null)
  const [capDragPageId, setCapDragPageId] = useState(null)
  const [capDrop, setCapDrop] = useState(null)
  // applyCaptionDrop is defined further down (it needs the caption functions
  // — saveCaption/insertCaptionPageAt/deletePage/deleteCaption — which
  // are declared later). The drop handlers (declared BEFORE those) read it
  // through this ref, the house pattern (deleteSelectionRef is the
  // precedent). It is bound once, at render, to the latest callback.
  const applyCaptionDropRef = useRef(null)

  // B18 round 7 — the document-level paste handler reads this ref (the house
  // pattern, applyCaptionDropRef is the precedent): the real handler is
  // declared AFTER insertCaptionPageAt/reorder/saveCaption/deletePage (which
  // it calls), so it can't be a direct useCallback dep of the listener that's
  // declared above. It is bound once, at render, to the latest callback.
  const pasteHandlerRef = useRef(null)

  // Step 4 — caption auto-save state.
  const captionTimers = useRef({})                       // page id → pending debounce timeout (per page, so one page's timer can't clobber another's)
  const [captionSave, setCaptionSave] = useState(null)   // null | 'saving' | 'saved' | 'error'
  const [captionError, setCaptionError] = useState(null) // the message behind an 'error' status
  // B18 round 2 — the page whose caption is being EDITED right now (the
  // inline input shows in place of the read-only bar). No default box: the
  // bar exists only where the owner put one — clicking a bar (or the
  // top/bottom '+' on a captionless page) arms this page; blurring an empty
  // one disarms it and the bar disappears again.
  const [captionEditId, setCaptionEditId] = useState(null)

  // Step 7 — active page + the preview window.
  // activePageId is a PAGE id (a number). `selectedId` stays the COMIC — the
  // two must not be conflated (round-2 confirmed UX contract).
  const [activePageId, setActivePageId] = useState(null)
  const activePageIdRef = useRef(activePageId)
  useEffect(() => { activePageIdRef.current = activePageId }, [activePageId])
  // Step 12.5b — the MULTI-SELECTION: an array of page ids in click order
  // (last = newest = the primary). A plain click resets it to [that page];
  // a Ctrl/Cmd+click toggles the page in it. Empty = no multi-selection.
  const [selectedIds, setSelectedIds] = useState([])
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])
  // Step 12.5d — arrow-key navigation context (refs ONLY — nothing in the UI
  // reads them, so no state / re-render): `lastSurfaceRef` = WHERE the last
  // selection action was made ('pages' = a tile/row click → the neighbour is
  // a grid cell; 'preview' = a figure click → the neighbour is the previous /
  // next page in page order); `anchorRef` = the page the Shift+arrow /
  // Shift+click RANGE grows and shrinks around (a plain click or plain arrow
  // re-anchors there; a Ctrl+click leaves it). A stale anchor (page deleted,
  // comic switched) falls back to the active page at use time.
  const lastSurfaceRef = useRef('pages')
  const anchorRef = useRef(null)
  const [previewMode, setPreviewMode] = useState('all')  // 'all' (default) | 'active'
  const previewRef = useRef(null)                        // the .comic-preview window (the scroll target)
  // A list-row click asked for the active figure to be centred in the window.
  // The scroll is deferred to a post-render effect (in 'active' mode the
  // figure only exists after the re-render), so the intent is flagged here.
  const scrollActiveRef = useRef(false)

  // Step 10 — wheel zoom (the ZOOM_* constants above): `zoom` 0..100,
  // fully out = a vertical file-name list, fully in = one tile fills the
  // section, between = the Step-9 grid with a scaled tile size. Default =
  // mid (the grid), so a fresh view looks like Step 9. The wheel listener
  // is bound to this (always-present) section wrapper, not the grid itself
  // (the grid is absent while "No pages yet.").
  // Step 11.5a — initialised from localStorage (the remembered level,
  // ZOOM_DEFAULT when absent/invalid) instead of the fixed default.
  const [zoom, setZoom] = useState(() => readStoredZoom())
  const pagesSectionRef = useRef(null)

  // Step 12 — deleting the ACTIVE page (the server renumbers the rest to a
  // clean 1..N). `deleting` is the in-flight flag (busy look + re-entry guard).
  const [deleting, setDeleting] = useState(false)

  // --- B18 round 5 — the text pane (markdown editing of the comic) ----------
  // `textMode` = the pane is showing the TEXT view (markdown) instead of the
  // page tiles. `textValue` = the textarea contents. `textDirty` = the text
  // has un-updated changes (the red indicators + the draft row). `autoUpdate`
  // = the OFF-by-default toggle: when ON, an edit re-applies the text live
  // (debounced); when OFF, the Update button (or switching back to tiles)
  // applies it. `textUpdating` = an apply is in flight (busy + re-entry guard).
  // `showTextModal` = the Update/Discard prompt (a pending preview reorder that
  // conflicts with un-updated text) — null when not shown.
  const [textMode, setTextMode] = useState(false)
  const [textValue, setTextValue] = useState('')
  const [textDirty, setTextDirty] = useState(false)
  const [autoUpdate, setAutoUpdate] = useState(false)
  const [textUpdating, setTextUpdating] = useState(false)
  const [showTextModal, setShowTextModal] = useState(false)
  // B18 round 5 — the GUARD prompt: shown when the owner attempts a TILES-mode
  // edit (upload / reorder / caption / delete) while unsaved text-mode edits
  // exist (the shared draft). "Review" switches to text mode; "Discard" clears
  // the draft + proceeds with the attempted edit. `guardActionRef` holds the
  // deferred edit (a no-arg thunk) that "Discard" will run.
  const [showGuard, setShowGuard] = useState(false)
  const guardActionRef = useRef(null)
  // B18 round 6, issue 8 — the REUSABLE styled confirm modal (the house
  // replacement for native window.confirm in this editor). `confirmReq` holds
  // { title, message, confirmLabel, cancelLabel?, tone? ('danger'|'primary'),
  // onConfirm, onCancel? } when a confirm is pending, else null. One generic
  // modal (the same .modal-overlay/.modal-card as the text-mode prompts) is
  // rendered from this single state; `showConfirm(opts)` opens it. The
  // destructive action gets the red `.btn--danger`; "Cancel" is the neutral
  // `.btn--neutral`. SITE-WIDE FOLLOW-UP (documented, owner's "option 1 …
  // consistent everywhere + any future dialogues use the styled modal"):
  // convert the remaining native confirm()/prompt() calls elsewhere in the
  // admin app to this same pattern.
  const [confirmReq, setConfirmReq] = useState(null)
  // Transient copy-button cue ("Copied.") that auto-hides after ~2 s.
  const [copyCue, setCopyCue] = useState(null)
  // The textarea contents mirrored to a ref (always current) so a debounced
  // auto-apply reads the LATEST text, not the stale closure value.
  const textValueRef = useRef('')
  useEffect(() => { textValueRef.current = textValue }, [textValue])
  // The FROZEN number→pageId map, captured when text mode was entered (the
  // number of a marker always denotes the page that was that media when the
  // mode was entered — even after a reorder). Refreshed only on regeneration
  // events (entering text mode / a clean preview reorder / a Discard).
  const mediaNumberRef = useRef(new Map())
  // The pending PREVIEW EDIT (a no-arg thunk: a caption commit, a reorder,
  // a delete, an upload, a caption-page insert, ...) the owner is about to
  // commit while un-updated text changes exist. Discarding the modal RUNS it
  // + regenerates the markdown (the preview edit stands); Updating DROPS it
  // (the text wins — applyDoc re-mirrors the local state to the text's
  // version). The thunk is created at the call site (after the underlying
  // action is declared), so it can capture the action directly.
  const pendingActionRef = useRef(null)
  // TRUE when the Update / Discard modal was opened by a TOGGLE-OFF (the owner
  // is leaving text mode with un-updated changes): resolving it also exits to
  // tiles. FALSE when opened by a preview edit (the owner stays in text mode).
  const modalExitRef = useRef(false)
  // The debounced auto-update timer (autoUpdate ON).
  const autoUpdateTimer = useRef(null)
  // The textarea element (scroll-position preservation on regeneration).
  const textPaneRef = useRef(null)
  // The comic id we already auto-restored text mode for (prevents the restore
  // effect from re-firing on every render once it has entered text mode).
  const autoRestoredRef = useRef(null)
  // B18 round 5 — the FROZEN media number for a page (the reverse of
  // mediaNumberRef's number→pageId map), for the preview hover label in text
  // mode ("Media N"). null when the page has no frozen number (a caption page,
  // or before text mode has been entered).
  const mediaNumberFor = (pageId) => {
    for (const [num, pid] of mediaNumberRef.current) if (pid === pageId) return num
    return null
  }

  // Clear the deferred single-click timer if the component unmounts early.
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current) }, [])

  // Clear any pending caption-save timers on unmount (they'd fire into the void).
  useEffect(() => () => {
    const timers = captionTimers.current
    Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k] })
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/content', { headers: { Accept: 'application/json' } })
      if (!res.ok) { setError(`content endpoint answered ${res.status}`); return }
      const data = await res.json()
      const list = Array.isArray(data.comics) ? data.comics : []
      setComics(list)
      setPages(Array.isArray(data.pages) ? data.pages : [])
      // Default selection = the REMEMBERED comic (2026-09-28 — persists across
      // hard reloads) if it is still in the live list; else the first comic;
      // else null if there are none. A stale remembered id (the comic was
      // deleted) falls back to the first comic, and the persistence effect
      // below then overwrites the stored value with the valid one.
      setSelectedId(prev =>
        (prev !== null && list.some(c => c.id === prev))
          ? prev
          : (list.length ? list[0].id : null))
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 2026-09-28 — persist the selected comic so a hard reload re-opens it.
  // Runs on every selection change (picking a comic, the load() fallback, a
  // comic being created). A null selection (no comics yet) is NOT persisted —
  // there is nothing to remember, and the stored value stays as it was.
  useEffect(() => {
    if (selectedId === null) return
    storeSelectedComic(selectedId)
  }, [selectedId])

  // The selected comic's pages, in reading order. Drives BOTH the left list and
  // the right preview, so the two can't drift apart.
  const selectedPages = useMemo(() => {
    if (selectedId === null) return []
    return pages
      .filter(p => p.comic_id === selectedId)
      .sort((a, b) => a.page_number - b.page_number)
  }, [pages, selectedId])
  const selectedPagesRef = useRef(selectedPages)
  useEffect(() => { selectedPagesRef.current = selectedPages }, [selectedPages])

  // Step 9.5 — the pages the preview window SHOWS (all of them, or just the
  // active page in "active page only" mode). One place computes it: the
  // preview map and the drop slot→full-index mapping both read it, so the
  // indicator, the dragover math, and the drop can't drift apart.
  // Step 12.5b — in "active page only" mode the window shows the SELECTION
  // (its 1 member = the active page = today's behaviour); with no selection
  // it falls back to the active page (the validity effect keeps the two
  // consistent).
  const visiblePages = previewMode === 'active'
    ? (selectedIds.length
      ? selectedPages.filter(p => selectedIds.includes(p.id))
      : selectedPages.filter(p => p.id === activePageId))
    : selectedPages
  const visiblePagesRef = useRef(visiblePages)
  useEffect(() => { visiblePagesRef.current = visiblePages }, [visiblePages])

  // Step 7 + Step 12.5b — keep the selection AND the active page VALID against
  // the current comic's pages (one effect, the single source of truth):
  //   1) prune the selection to the comic's pages (a comic switch or a page
  //      delete drops the ids that no longer belong here),
  //   2) with a selection, the active (the last-clicked PRIMARY) must be one
  //      of its members — if it was deleted / is stale, fall back to the LAST
  //      remaining selection member (newest click);
  //   3) with no selection, the active is just the comic's FIRST page (the
  //      Step-7 fallback; null when the comic has none).
  // Caption edits don't trip this (the ids stay in the list), so typing a
  // caption never yanks the active page back to page 1.
  useEffect(() => {
    let ids = selectedIds
    if (ids.length > 0) {
      const valid = ids.filter(id => selectedPages.some(p => p.id === id))
      if (valid.length !== ids.length) {
        ids = valid
        setSelectedIds(valid)
      }
      if (ids.length > 0) {
        if (!ids.includes(activePageId)) {
          setActivePageId(ids[ids.length - 1])   // last remaining = newest click
        }
        return
      }
    }
    if (activePageId === null) {
      if (selectedPages.length) setActivePageId(selectedPages[0].id)
      return
    }
    if (!selectedPages.some(p => p.id === activePageId)) {
      setActivePageId(selectedPages.length ? selectedPages[0].id : null)
    }
  }, [selectedPages, selectedIds, activePageId])

  // --- B18 round 7b — editor undo/redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) ----
  //
  // Contract (editor-overhaul §12; owner cross-comic decision, 2026-10-05):
  //   1. Ctrl+Z undoes; Ctrl+Y / Ctrl+Shift+Z redo. While focus is in a text
  //      field BOTH are ignored — the native text undo/redo stays intact.
  //   2. ONE entry per logical action: a debounced PUT burst is a single
  //      entry, and a FAILED PUT never leaves a phantom (nothing was
  //      committed, so there is nothing to undo).
  //   3. A new action (any comic) clears the redo stack; empty stacks are
  //      no-ops.
  //   4. CROSS-COMIC: the stack is shared and every entry is tagged with
  //      its comicId. Undo/redo switches the editor to the entry's comic
  //      FIRST, then applies. An entry whose comic was deleted in the
  //      meantime is discarded and the next live entry is used (the owner's
  //      call — the stack stays usable, not "punishing").
  //
  // Mechanism — pending / confirm / drain (why not just snapshot on commit?):
  //   • beginAction / beginComposite register a PENDING entry: the comic +
  //     a `before` snapshot taken AT THE ACTION'S START (before any local
  //     state moves — that is why caption typing registers in
  //     onCaptionChange, not in saveCaption, where the text is already in
  //     state and the snapshot would be the AFTER, not the before).
  //   • the commit path calls settleEntry(entry, success) when its request
  //     settles (saveCaption / reorder / deletePage / theme debounce / the
  //     composite's end).
  //   • a post-render effect (the DRAIN) finalizes settled entries reading
  //     the SETTLED local state (refs — never a stale closure): no state
  //     movement → discard (a no-op, or the phantom rule); a single-commit
  //     flow that settled failed → discard (contract 2); otherwise push
  //     { comicId, before, after }. `after` is chain-correct: the NEXT
  //     queued entry's `before` (it started from this action's result),
  //     else the current state — so undo A, undo B, redo A, redo B each
  //     land exactly where the actions left the comic.
  //
  // applyDoc (the undo/redo body) reconciles a snapshot onto its comic
  // using ONLY the editor's existing endpoints — no new server surface:
  //   1. DELETE pages the target dropped (the server renumbers the rest;
  //      the upload FILE stays on disk — a redo re-POSTs the same
  //      file_path, so undo/redo of a delete can never lose the image),
  //   2. POST the pages the target has that are missing, at FRESH numbers
  //      (a deleted row's number may be free AND another row's — never
  //      collide),
  //   3. PATCH the caption fields (slots cannot be set at creation, so
  //      every target page is diffed against its current values),
  //   4. ONE PATCH /reorder with the COMPLETE target set (the server
  //      requires the exact current full set and 400s a partial list),
  //   5. PUT the theme_colour when it differs (an explicit null clears).
  // Then the local mirror (setPages / setComics, other comics untouched) —
  // the validity effect above reconciles selection + active page after a
  // comic switch (auto-heal).
  //
  // Cap: the newest HISTORY_CAP entries are kept (light JSON snapshots —
  // no server traffic until an undo actually applies).

  const HISTORY_CAP = 100

  // Live mirrors (the sync effects below run before the drain's, so the
  // drain always reads the committed state).
  const pagesRef = useRef(pages)
  const comicsRef = useRef(comics)
  const selectedIdRef = useRef(selectedId)
  useEffect(() => { pagesRef.current = pages }, [pages])
  useEffect(() => { comicsRef.current = comics }, [comics])
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  const historyRef = useRef([])      // undo stack: [{ comicId, before, after }]
  const redoRef = useRef([])         // redo stack (same shape)
  const pendingRef = useRef([])      // in-flight: [{ comicId, before, committedOnly, settled? }]
  const compositeRef = useRef(0)     // nested composite depth (upload / paste / drop batches)
  const captionBurstRef = useRef({})// `${pageId}:${slot}` → the typing burst's entry
  const themeBurstRef = useRef(undefined)  // the theme drag burst's entry
  const [historyVersion, setHistoryVersion] = useState(0)  // bumped on every settle → drains
  // Re-entrancy: undo/redo are async (they apply a document over the network).
  // Two rapid Ctrl+Z dispatches would otherwise interleave — the second one
  // reads the SAME top entry while the first is still in flight, and both
  // mutate the stacks (double-consume + corrupt bookkeeping). Every history
  // action therefore runs through ONE promise chain: a second keystroke
  // waits its turn, then reads the stack fresh and pops the NEXT entry —
  // exactly the ordered LIFO sequence the user pressed.
  const historyChainRef = useRef(Promise.resolve())
  const enqueueHistory = (run) => {
    historyChainRef.current = historyChainRef.current.then(run).catch(() => {})
    return historyChainRef.current
  }

  // A comic's document state — exactly the fields the editor's endpoints
  // write (its ordered pages + the theme colour).
  const docSnapshot = useCallback((comicId) => {
    const cid = Number(comicId)
    const pagesSnap = (pagesRef.current || [])
      .filter(p => p.comic_id === cid)
      .sort((a, b) => (Number(a.page_number) || 0) - (Number(b.page_number) || 0))
      .map(p => ({
        id: p.id,
        page_number: p.page_number,
        file_path: p.file_path ?? null,
        caption: p.caption ?? null,
        caption_top: p.caption_top ?? null,
        caption_bottom: p.caption_bottom ?? null,
        caption_position: p.caption_position || 'top',
      }))
    const comic = (comicsRef.current || []).find(c => c.id === cid)
    return { theme: comic ? (comic.theme_colour ?? null) : null, pages: pagesSnap }
  }, [])
  const docsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const comicExists = (comicId) => (comicsRef.current || []).some(c => c.id === Number(comicId))

  // --- pending / confirm / drain ---------------------------------------------
  // Register a pending entry for a SINGLE-COMMIT action. Inside a composite
  // it registers NOTHING (the composite owns the entry).
  const beginAction = () => {
    if (compositeRef.current > 0) return null
    const comicId = selectedIdRef.current
    if (comicId == null) return null
    const entry = { comicId, before: docSnapshot(comicId), committedOnly: true }
    pendingRef.current.push(entry)
    return entry
  }
  // A batch of commits (upload, paste split, drop, merge, multi-delete): its
  // entry survives PARTIAL success (a real action happened — the partial
  // state is undoable), so `committedOnly` is off and "the state moved" is
  // the only rule.
  const beginComposite = () => {
    compositeRef.current += 1
    if (compositeRef.current !== 1) return
    const comicId = selectedIdRef.current
    if (comicId == null) return
    pendingRef.current.push({ comicId, before: docSnapshot(comicId), committedOnly: false })
  }
  const endComposite = () => {
    compositeRef.current = Math.max(0, compositeRef.current - 1)
    if (compositeRef.current === 0) {
      // The composite is finished: settle its entry (the ONLY in-flight
      // non-committedOnly one — at most one is ever pushed, on the depth
      // 0→1 transition) so the drain can finalize it. A fully-failed batch
      // rolled back → zero diff → discarded; a partial batch → a real entry.
      // (Without this the entry would stay unsettled forever and the
      // in-flight guard would block every undo.)
      for (let i = pendingRef.current.length - 1; i >= 0; i -= 1) {
        const e = pendingRef.current[i]
        if (e.settled === undefined && e.committedOnly === false) { e.settled = true; break }
      }
      setHistoryVersion(v => v + 1)
    }
  }
  // The action's commit settled: mark it and let the post-render drain
  // finalize (it reads the settled state — refs, not closures).
  const settleEntry = (entry, success) => {
    if (entry == null) return   // suppressed inside a composite — the composite settles
    entry.settled = success
    setHistoryVersion(v => v + 1)
  }

  // The drain: after every render in which at least one entry settled.
  // Unsettled entries (their commit still in flight) stay queued.
  useEffect(() => {
    const queue = pendingRef.current
    if (queue.length === 0) return
    const drained = []
    const kept = []
    for (const entry of queue) {
      if (entry.settled === undefined) kept.push(entry)
      else drained.push(entry)
    }
    if (drained.length === 0) return
    for (let i = 0; i < drained.length; i += 1) {
      const entry = drained[i]
      const now = docSnapshot(entry.comicId)
      if (docsEqual(entry.before, now)) continue   // nothing moved → nothing to undo (no-op / rolled back)
      if (entry.committedOnly && entry.settled !== true) continue   // failed PUT → no phantom entry
      const next = drained[i + 1]
      const after = (next && next.comicId === entry.comicId) ? next.before : now
      const stack = historyRef.current
      stack.push({ comicId: entry.comicId, before: entry.before, after })
      if (stack.length > HISTORY_CAP) stack.shift()
      redoRef.current = []                        // a new action clears redo (any comic)
    }
    pendingRef.current = kept
  }, [historyVersion, docSnapshot])

  // --- applyDoc: reconcile a snapshot onto its comic (the undo/redo body) ---
  const applyDoc = useCallback(async (comicId, target) => {
    const cid = Number(comicId)
    const cur = docSnapshot(cid)
    const curById = new Map(cur.pages.map(p => [p.id, p]))
    const survivorIds = new Set(target.pages.map(p => p.id))
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
    // 1) Delete what the target dropped (the server renumbers the rest; the
    //    upload files stay on disk — a redo re-POSTs the same file_path).
    for (const p of cur.pages) {
      if (survivorIds.has(p.id)) continue
      const res = await fetch(`/api/admin/comic-pages/${p.id}`, { method: 'DELETE', headers })
      if (!res.ok) throw new Error(`undo delete answered ${res.status}`)
    }
    // 2) Add what the target has that is missing, at FRESH numbers (after
    //    the deletes the server numbers the survivors 1..n — n+1, n+2, …).
    const survivors = cur.pages.filter(p => survivorIds.has(p.id))
    const additions = target.pages.filter(p => !curById.has(p.id))
    const createdMap = new Map()      // target page id → fresh server id
    let freshNumber = survivors.length
    for (const p of additions) {
      freshNumber += 1
      const res = await fetch('/api/admin/comic-pages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          comic_id: cid,
          page_number: freshNumber,
          file_path: p.file_path,
          caption: p.caption,
          caption_position: p.caption_position || 'page',
        }),
      })
      if (!res.ok) throw new Error(`undo add answered ${res.status}`)
      const created = await res.json().catch(() => ({}))
      createdMap.set(p.id, created.id)
    }
    // 3) Caption fields (slots cannot be set at creation) — diff every
    //    target page against its CURRENT server-side value. A page this call
    //    just CREATED has no server-side value yet (base = the target's own),
    //    so it PATCHes nothing — and any PATCH must use the FRESH server id
    //    (createdMap), not the snapshot's original id.
    for (const p of target.pages) {
      const pid = createdMap.get(p.id) || p.id
      const curP = curById.get(p.id)
      const base = curP || { caption: p.caption ?? null, caption_top: null, caption_bottom: null }
      if ((base.caption ?? null) !== (p.caption ?? null)) {
        const res = await fetch(`/api/admin/comic-pages/${pid}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ caption: p.caption ?? null }),
        })
        if (!res.ok) throw new Error(`undo caption answered ${res.status}`)
      }
      if ((base.caption_top ?? null) !== (p.caption_top ?? null)) {
        const res = await fetch(`/api/admin/comic-pages/${pid}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ caption: p.caption_top ?? null, slot: 'top' }),
        })
        if (!res.ok) throw new Error(`undo caption slot answered ${res.status}`)
      }
      if ((base.caption_bottom ?? null) !== (p.caption_bottom ?? null)) {
        const res = await fetch(`/api/admin/comic-pages/${pid}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ caption: p.caption_bottom ?? null, slot: 'bottom' }),
        })
        if (!res.ok) throw new Error(`undo caption slot answered ${res.status}`)
      }
    }
    // 4) Order — ONE reorder with the complete target set (the server
    //    requires the exact current full set; 0 pages → nothing to reorder).
    if (target.pages.length > 0) {
      const orderedIds = target.pages.map(p => (createdMap.get(p.id) || p.id))
      const res = await fetch(`/api/admin/comics/${cid}/reorder`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ page_ids: orderedIds }),
      })
      if (!res.ok) throw new Error(`undo reorder answered ${res.status}`)
    }
    // 5) Theme (partial PUT; an explicit null CLEARS it).
    if ((cur.theme ?? null) !== (target.theme ?? null)) {
      const res = await fetch(`/api/admin/comics/${cid}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ theme_colour: target.theme ?? null }),
      })
      if (!res.ok) throw new Error(`undo theme answered ${res.status}`)
    }
    // 6) Local mirror — the editor's own optimistic shape (other comics
    //    untouched; the validity effect reconciles selection + active page).
    //    Sync the REFS immediately, not just setState: a chained undo/redo
    //    (the shared chain may run it before this render commits) reads the
    //    refs through docSnapshot — with the old effect-only sync it saw the
    //    PRE-APPLY state and no-op'd (the R7B-7 redo that deleted nothing).
    const others = (pagesRef.current || []).filter(p => p.comic_id !== cid)
    const applied = target.pages.map((p, i) => ({
      id: createdMap.get(p.id) || p.id,
      comic_id: cid,
      page_number: i + 1,
      file_path: p.file_path ?? null,
      caption: p.caption ?? null,
      caption_top: p.caption_top ?? null,
      caption_bottom: p.caption_bottom ?? null,
      caption_position: p.caption_position || 'top',
    }))
    const nextPages = [...others, ...applied]
    pagesRef.current = nextPages
    setPages(nextPages)
    if ((cur.theme ?? null) !== (target.theme ?? null)) {
      const nextComics = (comicsRef.current || []).map(c => (c.id === cid ? { ...c, theme_colour: target.theme ?? null } : c))
      comicsRef.current = nextComics
      setComics(nextComics)
    }
  }, [csrfToken, docSnapshot])

  // --- B18 round 5 — the text-pane engine wiring (apply / regenerate / draft) ---
  // loadDraft — fetch the shared draft (the owner's un-updated text-mode edits
  // + the frozen number map) for a comic. Returns { text, map } or null.
  const loadDraft = useCallback(async (comicId) => {
    try {
      const res = await fetch(`/api/admin/comics/${comicId}/text-draft`, { headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const data = await res.json()
      return draftDecode(data.draft)
    } catch { return null }
  }, [])

  // saveDraft — persist the shared draft (text + frozen map) to the server so
  // it is visible across browsers (the red indicators point at it).
  const saveDraft = useCallback(async (text) => {
    if (selectedId === null) return
    try {
      await fetch(`/api/admin/comics/${selectedId}/text-draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ draft: draftEncode(text, mediaNumberRef.current) }),
      })
    } catch { /* best-effort — the textarea already holds the text */ }
  }, [selectedId, csrfToken])

  // clearDraftFn — drop the shared draft (the comic is the source of truth
  // again — after an update / a discard / a clean regeneration).
  const clearDraftFn = useCallback(async () => {
    if (selectedId === null) return
    try {
      await fetch(`/api/admin/comics/${selectedId}/text-draft`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      })
    } catch { /* best-effort */ }
  }, [selectedId, csrfToken])

  // regenerateText — a REGENERATION EVENT (entering text mode / a clean preview
  // reorder / a Discard): rebuild the markdown from the comic's CURRENT order,
  // refresh the frozen number map + the textarea, and clear the dirty flag.
  const regenerateText = useCallback(() => {
    // Preserve the textarea's scroll + caret across the regeneration (spec: a
    // clean preview reorder keeps the textarea's scroll position).
    const pane = textPaneRef.current
    const prevScrollTop = pane ? pane.scrollTop : 0
    const prevSelStart = (pane && typeof pane.selectionStart === 'number') ? pane.selectionStart : null
    const prevSelEnd = (pane && typeof pane.selectionEnd === 'number') ? pane.selectionEnd : null
    const { markdown, numberToPageId } = comicToMarkdown(selectedPages)
    mediaNumberRef.current = numberToPageId
    setTextValue(markdown)
    setTextDirty(false)
    if (pane) {
      requestAnimationFrame(() => {
        if (pane.scrollTop !== prevScrollTop) pane.scrollTop = prevScrollTop
        if (prevSelStart !== null && pane.setSelectionRange) {
          try { pane.setSelectionRange(prevSelStart, prevSelEnd) } catch { /* noop */ }
        }
      })
    }
  }, [selectedPages])

  // applyTextMode — the UPDATE EVENT: parse the text, build the target doc, and
  // reconcile it onto the comic (reorder + captions + placeholders) via
  // applyDoc. On success the comic matches the text; the numbers stay FROZEN
  // (they only refresh on a regeneration event). Clears the dirty flag + the
  // shared draft. `textOverride` lets the debounced auto-apply pass the latest
  // text (the state closure may be a keystroke behind).
  const applyTextMode = useCallback(async (textOverride) => {
    if (selectedId === null || textUpdating) return
    const text = textOverride ?? textValueRef.current
    const sc = (comics || []).find(c => c.id === selectedId) || null
    const blocks = markdownToBlocks(text)
    const target = buildTargetDoc(blocks, mediaNumberRef.current, selectedPages, sc ? sc.theme_colour : null)
    setTextUpdating(true)
    setError(null)
    try {
      await applyDoc(selectedId, target)
      // The comic now matches the text. Keep the owner's text + FROZEN numbers
      // (do NOT re-serialize — that would refresh the numbers, which is a
      // regeneration event, not an update). Clear the dirty flag + the draft.
      setTextDirty(false)
      await clearDraftFn()
    } catch (err) {
      setError(err.message)
    } finally {
      setTextUpdating(false)
    }
  }, [selectedId, textUpdating, comics, selectedPages, applyDoc, clearDraftFn, setError])

  // enterTextMode — toggle ON: restore the shared draft (if any — the owner's
  // un-updated edits + frozen map) or regenerate from the comic's current order
  // (entering text mode is a regeneration event when there is no draft).
  const enterTextMode = useCallback(async () => {
    if (selectedId === null) return
    const draft = await loadDraft(selectedId)
    if (draft && draft.text) {
      setTextValue(draft.text)
      setTextDirty(true)
      if (draft.map && draft.map.size) mediaNumberRef.current = draft.map
    } else {
      regenerateText()
    }
    setTextMode(true)
    storeRememberedTextMode(selectedId, true)
  }, [selectedId, loadDraft, regenerateText])

  // exitTextMode — toggle OFF: switching back to tiles. If there are
  // un-updated text changes, prompt the owner (Update = apply the text,
  // Discard = discard the text's changes) — no silent apply.
  const exitTextMode = useCallback(async () => {
    if (textDirty) {
      modalExitRef.current = true
      setShowTextModal(true)
      return   // the modal resolves the exit (modalUpdate / modalDiscard)
    }
    setTextMode(false)
    // The text-mode work session is over (the comic is the source of truth
    // again), so drop this browser's "remembered text mode" for the comic —
    // the next visit returns to tiles unless the owner re-enters text mode.
    if (selectedId !== null) storeRememberedTextMode(selectedId, false)
  }, [textDirty, selectedId])

  // handleModeToggle — the Tiles ↔ Text toggle (the round-5 primary control).
  const handleModeToggle = useCallback(async () => {
    if (textMode) await exitTextMode()
    else await enterTextMode()
  }, [textMode, enterTextMode, exitTextMode])

  // handleTextChange — the textarea onChange: update the text, mark it dirty,
  // then (debounced) persist the shared draft and — when autoUpdate is ON —
  // apply the text live (the "immediately move a media to its text position").
  const handleTextChange = useCallback((value) => {
    setTextValue(value)
    setTextDirty(true)
    if (autoUpdateTimer.current) clearTimeout(autoUpdateTimer.current)
    autoUpdateTimer.current = setTimeout(() => {
      saveDraft(value)
      if (autoUpdate) applyTextMode(value)
    }, 600)
  }, [saveDraft, autoUpdate, applyTextMode])

  // copyText — the copy button: the text WITHOUT the punctuation markup (the
  // plain prose + captions, in order), to the clipboard.
  const copyText = useCallback(async () => {
    const plain = toPlainText(textValueRef.current)
    try {
      await navigator.clipboard.writeText(plain)
      setCopyCue('Copied.')
      setTimeout(() => setCopyCue(null), 2000)
    } catch {
      setError('Copy failed — the clipboard is blocked here.')
    }
  }, [setError])

  // --- B18 round 5 — the GUARD (tiles edit while unsaved text edits exist) ---
  // guardOrPerform — run a tiles-mode edit, but if there are unsaved text-mode
  // edits (the shared draft) and we are NOT in text mode, prompt first:
  //   "There are unsaved text mode changes. Review in text mode or discard
  //    them?"  — Review → text mode; Discard → clear the draft + proceed.
  const guardOrPerform = useCallback((action) => {
    // The draft state is computed inline — the `hasDraftForSelected` const is
    // declared LATER in the render, and referencing it here (or in the deps)
    // would be a TDZ ReferenceError at mount (a black screen).
    const c = (comics || []).find(x => x.id === selectedId)
    if (c && c.unsavedTextMode && !textMode) {
      guardActionRef.current = action
      setShowGuard(true)
      return
    }
    action()
  }, [comics, selectedId, textMode])

  // guardReview — switch to text mode (the owner reviews/edits the text); the
  // attempted tiles edit is dropped.
  const guardReview = useCallback(() => {
    setShowGuard(false)
    guardActionRef.current = null
    enterTextMode()
  }, [enterTextMode])

  // guardDiscard — clear the shared draft (discard the unsaved text edits),
  // reset the local text state, then run the deferred tiles edit.
  const guardDiscard = useCallback(async () => {
    const action = guardActionRef.current
    guardActionRef.current = null
    setShowGuard(false)
    await clearDraftFn()
    setTextDirty(false)
    setTextValue('')
    mediaNumberRef.current = new Map()
    if (action) action()
  }, [clearDraftFn])

  // --- B18 round 5 — the UPDATE / DISCARD modal (a preview EDIT that
  // conflicts with un-updated text, while in text mode) ---------------------
  // beginTextModal — the owner attempted a preview edit (caption / reorder /
  // delete / upload / caption-page) while in text mode with un-updated text.
  // Park the pending action (a no-arg thunk); show the modal.
  const beginTextModal = useCallback((actionThunk) => {
    pendingActionRef.current = actionThunk
    setShowTextModal(true)
  }, [])

  // modalUpdate — UPDATE: the text's state is applied to the comic (an update
  // event); the pending preview edit is DROPPED (the text wins — applyDoc
  // re-mirrors the local state back to the text's version, so nothing on the
  // text side is lost). If the modal was opened by a toggle-off, exit to tiles.
  const modalUpdate = useCallback(async () => {
    const exit = modalExitRef.current
    pendingActionRef.current = null
    modalExitRef.current = false
    setShowTextModal(false)
    await applyTextMode()
    if (exit) {
      setTextMode(false)
      if (selectedId !== null) storeRememberedTextMode(selectedId, false)
    }
  }, [applyTextMode, selectedId])

  // modalDiscard — DISCARD: the text's changes are discarded (the comic is the
  // source of truth). If a pending preview edit exists, RUN it, then regenerate
  // the markdown from the comic's new state (a regeneration event — numbers
  // refresh). If the modal was opened by a toggle-off, just discard the text
  // (no pending edit to run) and exit to tiles.
  const modalDiscard = useCallback(async () => {
    const pending = pendingActionRef.current
    const exit = modalExitRef.current
    pendingActionRef.current = null
    modalExitRef.current = false
    setShowTextModal(false)
    if (pending) {
      try { await pending() } catch { /* the action's own error path */ }
      await regenerateText()
    } else {
      // Toggle-off case: discard the text's changes (the comic wins).
      clearDraftFn()
      setTextDirty(false)
      setTextValue('')
      mediaNumberRef.current = new Map()
    }
    if (exit) {
      setTextMode(false)
      if (selectedId !== null) storeRememberedTextMode(selectedId, false)
    }
  }, [regenerateText, clearDraftFn, selectedId])

  // --- B18 round 5 — the UNIFIED preview-edit guard ------------------------
  // guardPreviewEdit — the single entry point for a PREVIEW edit (a caption
  // commit, a reorder, a delete, an upload, a caption-page insert):
  //   text mode + dirty text  → the Update / Discard MODAL (the edit is parked)
  //   text mode + clean text  → run the edit + regenerate the markdown
  //                             (a regeneration event — numbers refresh)
  //   tiles + shared draft    → the cross-browser GUARD (Review → text mode;
  //                             Discard → clear the draft + run the edit)
  //   otherwise               → run the edit
  // `actionThunk` is a no-arg closure created at the call site (after the
  // underlying action is declared), so it can capture the action directly.
  const guardPreviewEdit = useCallback(async (actionThunk) => {
    if (textMode) {
      if (textDirty) { beginTextModal(actionThunk); return }
      await actionThunk()
      await regenerateText()
      return
    }
    // tiles: the cross-browser guard (a shared draft exists).
    guardOrPerform(actionThunk)
  }, [textMode, textDirty, beginTextModal, guardOrPerform, regenerateText])

  // B18 round 5 — RESTORE-ON-LOAD: if THIS browser remembers the comic was in
  // text mode (the owner was working there), auto-return to text mode once the
  // comic's data is loaded (restoring the shared draft if one exists). Fires
  // once per comic selection (autoRestoredRef guards re-runs).
  useEffect(() => {
    if (selectedId === null) return
    if (!comics || comics.length === 0) return
    if (textMode) return
    if (autoRestoredRef.current === selectedId) return
    if (!readRememberedTextMode(selectedId)) return
    autoRestoredRef.current = selectedId
    enterTextMode()
  }, [selectedId, comics, textMode, enterTextMode])

  const performUndo = useCallback(() => {
    const run = async () => {
      // In-flight guard (checked at EXECUTION time — the chain may have queued
      // us behind an earlier action, so the state can have changed since the
      // keystroke): never undo while a commit is landing (its pending entry
      // is unsettled — the drain would race).
      if (uploadingRef.current || reorderingRef.current) return
      if (pendingRef.current.some(p => p.settled === undefined)) return
      // Cross-comic: discard entries whose comic no longer exists (discard +
      // continue — the stack stays usable), take the top live one.
      while (historyRef.current.length > 0 && !comicExists(historyRef.current[historyRef.current.length - 1].comicId)) {
        historyRef.current.pop()
      }
      const entry = historyRef.current[historyRef.current.length - 1]
      if (!entry) return                                 // empty stack → no-op
      if (entry.comicId !== selectedIdRef.current) {
        selectedIdRef.current = entry.comicId            // sync the ref NOW (a chained run may read it before this render)
        setSelectedId(entry.comicId)                     // switch FIRST, then apply
      }
      try {
        await applyDoc(entry.comicId, entry.before)
      } catch (err) {
        setError(`Undo failed — ${err.message}`)
        return                                            // the entry stays → retryable
      }
      historyRef.current.pop()
      redoRef.current.push(entry)
    }
    return enqueueHistory(run)
  }, [applyDoc, setError, selectedIdRef])

  const performRedo = useCallback(() => {
    const run = async () => {
      // Same execution-time guards + the same shared chain as performUndo —
      // an in-flight undo must finish (pop + bookkeeping) before a redo runs.
      if (uploadingRef.current || reorderingRef.current) return
      if (pendingRef.current.some(p => p.settled === undefined)) return
      while (redoRef.current.length > 0 && !comicExists(redoRef.current[redoRef.current.length - 1].comicId)) {
        redoRef.current.pop()
      }
      const entry = redoRef.current[redoRef.current.length - 1]
      if (!entry) return                                 // empty redo → no-op
      if (entry.comicId !== selectedIdRef.current) {
        selectedIdRef.current = entry.comicId            // sync the ref NOW (a chained run may read it before this render)
        setSelectedId(entry.comicId)                     // switch FIRST, then apply
      }
      try {
        await applyDoc(entry.comicId, entry.after)
      } catch (err) {
        setError(`Redo failed — ${err.message}`)
        return
      }
      redoRef.current.pop()
      historyRef.current.push(entry)
    }
    return enqueueHistory(run)
  }, [applyDoc, setError, selectedIdRef])

  // Bind the handlers (house pattern — the listener is bound once and reads
  // the freshest handlers through the ref).
  const undoRedoRef = useRef({ undo: null, redo: null })
  useEffect(() => { undoRedoRef.current = { undo: performUndo, redo: performRedo } }, [performUndo, performRedo])

  useEffect(() => {
    const inField = (el) => (el instanceof HTMLElement && (
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = String(e.key || '').toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const wantUndo = (k === 'z' && !e.shiftKey)
      const wantRedo = (k === 'y') || (k === 'z' && e.shiftKey)
      if (!wantUndo && !wantRedo) return
      // Contract 1 — while focus is in a text field the editor's stack is
      // ignored: the field's own (native) undo/redo stays intact.
      if (inField(document.activeElement) || inField(e.target)) return
      e.preventDefault()
      const fn = wantUndo ? undoRedoRef.current.undo : undoRedoRef.current.redo
      if (fn) void fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Step 7 — two-way sync, list → preview: a click makes that page the active
  // one and centres its figure inside the preview window. Step 12.5b adds the
  // MULTI-SELECT (a PLAIN click = the single page; a Ctrl/Cmd+click TOGGLES
  // the page in the selection; the last click is the PRIMARY). Step 12.5d
  // adds the ANCHOR (a plain click re-anchors there; a Ctrl+click leaves it)
  // and records the SURFACE the click happened on (a tile/row = 'pages', a
  // preview figure = 'preview' — passed as the 3rd arg) — that decides what
  // "the neighbour in that direction" means for the arrow keys.
  const onListRowClick = useCallback((e, pageId, surface) => {
    scrollActiveRef.current = true
    lastSurfaceRef.current = surface || 'pages'
    const ctrl = !!(e && (e.ctrlKey || e.metaKey))
    const shift = !!(e && e.shiftKey)
    const pages = selectedPagesRef.current
    if (ctrl && !shift) {
      // CTRL+click — toggle this page in the selection (added at the end =
      // newest = primary); the anchor stays where it is.
      setSelectedIds(prev => (prev.includes(pageId)
        ? prev.filter(id => id !== pageId)     // toggle OFF
        : [...prev, pageId]))                  // toggle ON (end = newest)
    } else if (shift && !ctrl) {
      // SHIFT+click — the page-order range between the anchor (fallback: the
      // active page) and this page, inclusive (Windows Explorer).
      let aIdx = pages.findIndex(p => p.id === anchorRef.current)
      const bIdx = pages.findIndex(p => p.id === pageId)
      if (aIdx === -1) aIdx = pages.findIndex(p => p.id === activePageIdRef.current)
      if (aIdx !== -1 && bIdx !== -1) {
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx]
        setSelectedIds(pages.slice(lo, hi + 1).map(p => p.id))
      }
    } else {
      // plain click — the single page, and the new anchor
      setSelectedIds([pageId])
      anchorRef.current = pageId
    }
    setActivePageId(pageId)                    // last-clicked = primary
  }, [])

  // Runs AFTER React has rendered the (possibly newly visible) active figure —
  // in 'active' mode it only exists post-render — and brings the active page
  // into view: centred in the PREVIEW window, and (Step 12.5d) the active
  // TILE / list row in the pages window scrolled to the edge.
  // 2026-09-28 follow-up — WINDOW-scoped: the old `scrollIntoView` scrolled
  // every ancestor INCLUDING the document (toggling "active page only" off
  // with the active page on 1–3 scrolled the whole page up). Now only the
  // page's OWN window scrolls — the preview window for the figure, the pages
  // window for the tile — the document's scroll position is never touched.
  useEffect(() => {
    if (!scrollActiveRef.current) return
    scrollActiveRef.current = false
    const fig = previewRef.current && previewRef.current.querySelector(`[data-page-id="${activePageId}"]`)
    if (fig) scrollWindowTo(fig, previewRef.current, 'center')
    const tile = gridRef.current && gridRef.current.querySelector(`[data-page-id="${activePageId}"]`)
    if (tile) scrollWindowTo(tile, scrollerOf(tile), 'nearest')
  }, [activePageId, previewMode])

  // Step 10 — the wheel-zoom listener. NOTE: React's `onWheel` is attached
  // PASSIVELY, so a `preventDefault()` inside it is ignored (the page behind
  // would still scroll). A NATIVE non-passive listener is the only way to both
  // zoom AND stop the page scrolling — the native one stuck, `onWheel`
  // couldn't. Bound once the section has rendered (`comics !== null`), so the
  // ref is non-null; re-runs when that flips, cleanup removes the listener.
  // Zoom is gated on Ctrl: Ctrl+scroll and trackpad-pinch (the browser delivers
  // pinch as a ctrl+wheel event) both zoom; a PLAIN scroll passes through and
  // scrolls the page behind normally (no preventDefault, no zoom).
  useEffect(() => {
    if (comics === null) return undefined
    const el = pagesSectionRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      if (!e.ctrlKey) return                      // plain scroll: let the page scroll, don't zoom
      e.preventDefault()                          // ctrl+scroll / pinch: the page behind must NOT scroll
      const dir = e.deltaY > 0 ? -1 : 1           // wheel down = zoom out, up = in
      setZoom(z => Math.max(0, Math.min(100, z + dir * ZOOM_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [comics])

  // Step 11.5a — REMEMBER the zoom level (replaces Step 10's "reset to 50 on
  // comic switch"): the level now survives a hard reload AND comic switches.
  // One global value (like a folder-view zoom setting), not per-comic.
  useEffect(() => { storeZoom(zoom) }, [zoom])

  const createComic = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) { setError('Give the new comic a title first.'); return }
    if (creating) return
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/comics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `create answered ${res.status}`)
      }
      const data = await res.json()
      setComics(prev => (prev === null ? [{ id: data.id, title }] : [...prev, { id: data.id, title }]))
      setSelectedId(data.id)
      setNewTitle('')
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }, [newTitle, creating, csrfToken])

  // --- Step 2: the upload pipeline (all three input paths funnel here) -------
  //
  // Sequential on purpose: the server's multer is single-file. For each image:
  //   1. uploadImage() → { file_path }
  //   2. page_number = (max page_number among this comic's current pages) + 1
  //   3. POST /api/admin/comic-pages { comic_id, page_number, file_path } → 201
  //   4. append the row to local `pages` (list + preview update immediately)
  // Any failure stops the batch — a half-uploaded set is reported, not hidden.
  const addFiles = useCallback(async (files) => {
    if (selectedId === null) {
      setNotice(null)
      setError('Select or create a comic first, then add its pages.')
      return []
    }
    if (uploadingRef.current) {
      setNotice(null)
      setError('An upload is already in progress — wait for it to finish.')
      return []
    }
    const list = Array.from(files).filter(f => f && (f.type || '').startsWith('image/'))
    if (list.length === 0) {
      setNotice(null)
      setError('No image files in that batch — only image files are added as pages.')
      return []
    }
    // round 7b — the whole upload batch is ONE undo entry (a partial batch
    // keeps its entry: the pages that landed are a real, undoable state).
    beginComposite()
    uploadingRef.current = true
    setUploading(true)
    setError(null)
    setNotice(null)
    // Base number from the comic's CURRENT local pages; then increment per
    // success (never reuse a number → a 409 would stop the batch anyway).
    let nextNumber = selectedPages.reduce((m, p) => Math.max(m, Number(p.page_number) || 0), 0) + 1
    let inserted = 0
    const newPages = []   // Step 14 — returned so a caller can splice them at a position
    try {
      for (let i = 0; i < list.length; i += 1) {
        setUploadMsg(`Uploading ${i + 1}/${list.length} — ${list[i].name || 'image'}…`)
        const up = await uploadImage(list[i], csrfToken)
        const res = await fetch('/api/admin/comic-pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ comic_id: selectedId, page_number: nextNumber, file_path: up.file_path }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `add-page answered ${res.status}`)
        }
        const created = await res.json()
        const row = { id: created.id, comic_id: selectedId, page_number: nextNumber, file_path: up.file_path, caption: null }
        setPages(prev => [...prev, row])
        newPages.push(row)
        nextNumber += 1
        inserted += 1
      }
      const title = (comics.find(c => c.id === selectedId) || {}).title || 'the comic'
      setNotice(`Added ${inserted} page${inserted === 1 ? '' : 's'} to “${title}”.`)
    } catch (err) {
      setError(err.message + (inserted > 0
        ? ` — ${inserted}/${list.length} page(s) were saved before the failure; the rest were not added.`
        : ''))
    } finally {
      uploadingRef.current = false
      setUploading(false)
      setUploadMsg('')
    }
    endComposite()
    return newPages
  }, [selectedId, selectedPages, comics, csrfToken])

  // --- Step 2: the three input paths -----------------------------------------

  // Click → PASTE: read the clipboard, keep the image items. A blob has no
  // name, so wrap it in a File with a proper name + extension (see
  // extForImageType — the server saves by originalname).
  const doPaste = useCallback(async () => {
    if (selectedId === null) {
      setNotice(null)
      setError('Select or create a comic first, then paste its pages.')
      return
    }
    if (uploadingRef.current) {
      setError('An upload is already in progress — wait for it to finish.')
      return
    }
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      setNotice(null)
      setError('Clipboard read isn’t available in this browser — drag the images in, or double-click the dropzone to pick files.')
      return
    }
    try {
      const items = await navigator.clipboard.read()
      const files = []
      for (let i = 0; i < items.length; i += 1) {
        const type = Array.from(items[i].types).find(t => t.startsWith('image/'))
        if (!type) continue
        const blob = await items[i].getType(type)
        files.push(new File([blob], `pasted-${Date.now()}-${i + 1}.${extForImageType(type)}`, { type }))
      }
      if (files.length === 0) {
        setNotice(null)
        setError('No image on the clipboard — copy an image first, then Ctrl+V in the editor, or drag one in / double-click to pick files.')
        return
      }
      guardPreviewEdit(async () => { await addFiles(files) })
    } catch (err) {
      setNotice(null)
      setError('Couldn’t read the clipboard (permission denied or empty) — drag the images in, or double-click the dropzone to pick files.')
    }
  }, [selectedId, addFiles, guardPreviewEdit])

  // Paste (Ctrl+V / right-click → Paste) — the RELIABLE clipboard path.
  //
  // The async `navigator.clipboard.read()` used by click-to-paste (doPaste)
  // does NOT surface images copied from the OS — e.g. an image FILE copied in
  // File Explorer. It resolves with zero image items, which is why that path
  // can report "No image on the clipboard" even though one is on the
  // clipboard. The DOM `paste` event's `clipboardData.items` DOES expose them
  // (each item's `getAsFile()`), so this is the primary paste path.
  //
  // Attached to `document` (not the section): the dropzone is a plain <div>,
  // so clicking it leaves focus on <body> — a section-scoped onPaste would
  // never see a subsequent Ctrl+V. Document-level catches it no matter where
  // focus is. B18 round 7 — the real handler (see below, after
  // insertCaptionPageAt) now does three things: a TEXT paste (focus NOT in a
  // text field) → a caption page with that text after the active page; an
  // IMAGE/MEDIA paste → a media page placed after the active page; and an
  // IMAGE paste with the caret inside a caption page's text → that caption
  // page splits at the caret with the media BETWEEN the two halves. A text
  // paste with focus in a text field is left to that field (no preventDefault).
  //
  // B18 round 7 — THIN WRAPPER (stable, deps [pasteHandlerRef]): dispatches to the real
  // handler through pasteHandlerRef (bound at render to the latest callback,
  // declared after insertCaptionPageAt — the house ref pattern). The listener
  // below re-attaches only when this wrapper's identity changes (it never
  // will), so the handler it calls is always the freshest one.
  const onPasteEvent = useCallback((e) => {
    const handler = pasteHandlerRef.current
    if (typeof handler === 'function') handler(e)
  }, [pasteHandlerRef])

  // Register the document-level paste listener (re-attaches when the deps
  // change; the disposer removes it on unmount).
  useEffect(() => {
    document.addEventListener('paste', onPasteEvent)
    return () => document.removeEventListener('paste', onPasteEvent)
  }, [onPasteEvent])

  // Single click: defer behind a timer; a double-click cancels it and opens
  // the picker instead. (A double-click also fires two `click` events — the
  // `if (clickTimer.current) return` guard swallows the second one.)
  const onZoneClick = useCallback(() => {
    if (clickTimer.current) return
    clickTimer.current = setTimeout(() => { clickTimer.current = null; doPaste() }, 250)
  }, [doPaste])

  const onZoneDoubleClick = useCallback(() => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null }
    fileInputRef.current?.click()
  }, [])

  // Step 13 — the SECTION is the file-drop catch-all: a file dragged from the
  // OS over ANYWHERE in it (preview, tiles, empty space, the drop zone) appends
  // it as the last page(s); the drop zone stays the visual anchor and still
  // lights up via dragActive. These HOIST the drop zone's own dragover/leave/
  // drop (now removed from it — the section is the single file-drop handler, so
  // a drop on the drop zone can't double-append). Disambiguation: dragHasFiles
  // is true only for OS file drags (internal reorder drags carry text/plain,
  // not Files) → these ignore internal drags; the reorder handlers are guarded
  // on dragIdRef !== null (null for file drags) → they ignore file drags. The
  // two paths never cross-fire. preventDefault on dragover is REQUIRED to allow
  // the drop.
  const onSectionDragOver = useCallback((e) => {
    if (!dragHasFiles(e)) return            // internal reorder drag → its own handlers own it
    e.preventDefault()                       // REQUIRED to allow the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)                      // light the section ring + the drop zone anchor
    // Step 14 — the section fires LAST in the bubble chain, so a file
    // dragover anywhere in it reaches here. When the pointer is NOT over the
    // grid or the preview (drop zone, the padding, anywhere outside the
    // pages list), the EMPTY SPACE is the drop target → append at the end:
    // clear both slots. (Some browsers leave relatedTarget null on
    // dragleave, so a stale slot from the last surface hovered could
    // otherwise survive — and onSectionDrop's grid-first read would let it
    // hijack the drop position, plus leave a phantom marker behind.)
    const t = e.target
    const overGrid = !!(gridRef.current && t && gridRef.current.contains(t))
    const overPreview = !!(previewRef.current && t && previewRef.current.contains(t))
    if (!overGrid && !overPreview) {
      setGridDropSlot(null)
      setPreviewDropIdx(null)
    }
  }, [])

  const onSectionDragLeave = useCallback((e) => {
    if (!dragHasFiles(e)) return
    // dragleave fires when the pointer moves onto a child — ignore that.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setDragActive(false)
  }, [])

  // Double-click → the OS picker (hidden input; the same pipeline as the rest).
  const onFilePicked = useCallback((e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // let the same file be re-picked later
    if (files.length) guardPreviewEdit(async () => { await addFiles(files) })
  }, [addFiles, guardPreviewEdit])

  // --- Step 3: drag-reorder ----------------------------------------------------
  //
  // Native HTML5 DnD (no dependency). Each left-pane tile is draggable (a row
  // before Step 9 — the same handlers, tile markup):
  //   • dragstart on a tile records the dragged id,
  //   • drop ON A TILE → the dragged page lands at that tile's position,
  //   • drop ON THE GRID BODY (a gap / the ul itself) → it lands last,
  //   • dragend (any drop, or Escape) just clears the drag styling.
  // The new order is applied OPTIMISTICALLY (renumbered 1..n locally) and
  // persisted with the B2.4 reorder endpoint — which demands the FULL exact
  // page set — then rolled back + error line on failure. "Reorder doubles as
  // planning": the owner arranges pages here before they're published.
  //
  // Forward-compat: onRowDragStart refuses to start a drag from any
  // interactive child element — so a control inside a row (a caption input
  // before Step 8, any future one) can be used without lifting the row.

  const clearDrag = useCallback(() => {
    dragIdRef.current = null
    setDraggingId(null)
    dragBlockRef.current = null
    setDragBlockIds(null)
    setGridDropSlot(null)
    setPreviewDropIdx(null)
    // B18 round 3, pt 5 — the caption drag ends the same way (dragend fires
    // on the caption source's own element, not the figure — clearDrag is the
    // shared cleanup either way).
    capDragRef.current = null
    setCapDragPageId(null)
    setCapDrop(null)
  }, [])

  const onRowDragStart = useCallback((e, page) => {
    if (reorderingRef.current) { e.preventDefault(); return }
    // B18 round 3, pt 2 — a drag that STARTED on a caption node (a bar or a
    // caption page's frame) is the CAPTION's own drag, never the page's:
    // "when i try to drag a caption, it drags the whole page with the
    // caption." The caption source calls stopPropagation (startCaptionDrag);
    // this refusal is the second line of defence against any leak through.
    if (e.target && e.target.closest && e.target.closest('[data-caption-drag]')) {
      e.preventDefault()
      return
    }
    // Never lift the row when the drag started inside an interactive child
    // (a control inside the row must not start a page drag).
    if (e.target && e.target.closest && e.target.closest('input, textarea, button, a, select')) {
      e.preventDefault()
      return
    }
    dragIdRef.current = page.id
    setDraggingId(page.id)
    // Step 12.5e — a drag moves a BLOCK: the dragged page alone, or (when it
    // is a member of the multi-selection) the WHOLE selection. The member
    // ids drive the fading cue on every block tile.
    const block = resolveDragBlock(page.id)
    dragBlockRef.current = block.map(p => p.id)
    setDragBlockIds(dragBlockRef.current)
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // Firefox will not start a drag at all unless something is set on the
      // transfer — the value itself is ignored (we track the id in a ref).
      e.dataTransfer.setData('text/plain', String(page.id))
    }
  }, [])

  // --- B18 round 3, pt 5 — the CAPTION drag (a bar / a caption page) --------
  //
  // The read-only caption bar and the read-only caption-page frame are
  // DRAGGABLE in their own right (the `data-caption-drag` attribute marks
  // them). A dragstart there is the CAPTION's drag, not the page's:
  //   • stopPropagation — the figure/row's React onDragStart (bubbling)
  //     must not lift the whole page (pt 2),
  //   • the [data-caption-drag] refusal in onRowDragStart — belt and
  //     braces against the same leak,
  //   • the source (kind + pageId + text + position) is snapshotted into
  //     capDragRef — the drop handlers read it at event time.
  // Drop targets (applied in applyCaptionDrop, defined below with the
  // caption logic): a page's TOP/BOTTOM half → that caption slot (merging
  // if the slot already has text — pt 4, source on top); ONTO a
  // caption/caption page → merge there; a GAP (between pages / outside —
  // right/below = after, left/above = before) → a caption page lands
  // there (a bar becomes one, carrying its text; a caption page moves).
  const startCaptionDrag = useCallback((e, kind, page, slot) => {
    e.stopPropagation()
    if (reorderingRef.current) { e.preventDefault(); return }
    // B18 round 4 — the SLOTTED source: a bar drag carries its slot ('top' |
    // 'bottom' → caption_top / caption_bottom); a caption-page drag carries
    // 'page' (the `caption` column). `slotOf()` is the shared field map.
    const field = slotOf(slot)
    capDragRef.current = {
      kind,                                  // 'bar' | 'page'
      pageId: page.id,
      slot: slot || 'page',
      text: page[field] ?? '',
      position: page.caption_position || 'top',
    }
    setCapDragPageId(page.id)
    setCapDrop(null)
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // Firefox will not start a drag at all unless something is set on the
      // transfer — the value is ignored (the source lives in capDragRef).
      e.dataTransfer.setData('text/plain', 'caption:' + page.id)
    }
  }, [reorderingRef])

  const endCaptionDrag = useCallback(() => {
    capDragRef.current = null
    setCapDragPageId(null)
    setCapDrop(null)
  }, [])

  // --- Step 12.5e — the block-drop model (single page = a block of one) ----
  // A drag moves a BLOCK: the dragged page alone, or — if the dragged page
  // is a member of the multi-selection — the WHOLE selection, as one block
  // (internal order = the pages' current order, so a group keeps its
  // arrangement). The dragged page is the HANDLE: the marker (grid: the red
  // slot cell, preview: the before/after bar) predicts the drop by tracking
  // the cell the HANDLE will occupy. ONE plan function computes the drop's
  // result + the handle's landing cell — the marker and EVERY drop handler
  // (grid tile, grid gap, preview) read it, so they can't disagree:
  //   • drop on a page P (not in the block) → the block goes before P,
  //   • drop on the gap / the list body / after the last preview figure →
  //     the block goes last,
  //   • drop on a block member, or where the block already sits → a no-op
  //     (no marker, no reorder — "no marker" ⇔ "nothing would happen").
  // The k=1 case reproduces the user-verified Step 11.5b model exactly
  // (h < d → h, h > d → h − 1, the no-op suppressions, gap → last) — the
  // 476-case equivalence + group invariants (every subset/handle/target) that
  // guard it were proven at close. The 2026-09-28 inversion
  // bug (h > d ? h : h − 1 — marker one cell off everywhere, slot −1 = no
  // marker when hovering page 1 with a later page dragged) stays documented
  // in b2-5-appendix.md §[step-11.5b].
  const resolveDragBlock = useCallback((draggedId) => {
    const sel = selectedIdsRef.current
    const pages = selectedPagesRef.current
    const ids = (sel.length > 1 && sel.includes(draggedId)) ? sel : [draggedId]
    return pages.filter(p => ids.includes(p.id))   // in PAGE order (stable)
  }, [])

  // The drop's plan: the new full page order + the index the HANDLE will
  // occupy in it. targetId = the page the block goes BEFORE (null = last).
  // null = a no-op / invalid drop (a block member, already there, unknown
  // target) — the same null the marker uses, so the indicator is suppressed
  // exactly when the drop would do nothing.
  const planBlockDrop = useCallback((draggedId, targetId) => {
    const pages = selectedPagesRef.current
    if (!pages.length) return null
    const blockIds = dragBlockRef.current || [draggedId]
    const block = pages.filter(p => blockIds.includes(p.id))
    if (!block.length) return null
    if (targetId != null && block.some(b => b.id === targetId)) return null
    const without = pages.filter(p => !block.some(b => b.id === p.id))
    const idx = targetId == null
      ? without.length
      : without.findIndex(p => p.id === targetId)
    if (idx === -1) return null
    const next = [...without.slice(0, idx), ...block, ...without.slice(idx)]
    if (pages.every((p, i) => p.id === next[i].id)) return null   // no-op
    const pos = block.findIndex(b => b.id === draggedId)
    return { next, handleLanding: idx + pos }
  }, [])

  // A successful drop commits the drag's intent: the dragged page becomes
  // the ACTIVE page (the caption editor follows the drag), and a lone drag
  // (not a member of the multi-selection) normalizes the selection to
  // itself — exactly what a plain click does. A group drag keeps its
  // selection (the handle is a member, so the validity effect holds).
  const commitDragActive = useCallback((draggedId) => {
    const sel = selectedIdsRef.current
    if (!(sel.length > 1 && sel.includes(draggedId))) setSelectedIds([draggedId])
    setActivePageId(draggedId)
  }, [])

  // Step 11.5c — ONE hover→gap resolver shared by the marker AND every grid
  // drop (the 11.5b invariant, carried over: marker ⇔ drop can't disagree).
  // Returns the target page id the block goes BEFORE (null = the end gap).
  //   • over a page (grid tile / list row): the NEAR half decides — a tile's
  //     LEFT half / a row's TOP half = before it; a tile's RIGHT half / a row's
  //     BOTTOM half = after it (the next page in PAGE order, or the end).
  //   • over the list BODY (the ul, not a row): a row-top scan — the first
  //     row whose TOP is below the pointer gets the gap before it; none → end.
  //   • over the grid GUTTER: UNCHANGED from 11.5b — the end gap.
  // `li.dataset.pageId` is the DB id — map to the index via findIndex (never
  // assume id == index). The fill regime uses the same tile markup + rule.
  const gapFromEvent = useCallback((e) => {
    const pages = selectedPagesRef.current
    if (!pages.length) return null
    const isList = zoom <= ZOOM_LIST_MAX
    const t = e.target
    const li = (t && t.closest) ? t.closest('li[data-page-id]') : null
    if (li) {
      const id = Number(li.dataset.pageId)
      const i = pages.findIndex(p => p.id === id)
      if (i === -1) return null
      const r = li.getBoundingClientRect()
      const after = isList
        ? (e.clientY > r.top + r.height / 2)      // list: bottom half → after
        : (e.clientX > r.left + r.width / 2)      // grid: right half → after
      if (!after) return id                       // the gap BEFORE this page
      return i + 1 < pages.length ? pages[i + 1].id : null  // AFTER → next page, or END
    }
    if (isList) {
      // List BODY: the first row whose TOP is below the pointer gets the gap
      // before it; none below → the END gap. (The same scan the preview uses.)
      const rows = gridRef.current ? Array.from(gridRef.current.querySelectorAll('li[data-page-id]')) : []
      for (let i = 0; i < rows.length; i++) {
        if (e.clientY < rows[i].getBoundingClientRect().top) return pages[i].id
      }
      return null
    }
    return null   // grid GUTTER: the END gap (11.5b, unchanged)
  }, [zoom])

  // Step 11.5c — the marker: map the resolver's target to the GAP's insertion
  // index (0..n, n = the end). null = suppressed (the drop would be a no-op —
  // the same null planBlockDrop returns, so the indicator shows exactly when
  // the drop would do something).
  const resolveGridSlot = useCallback((targetId) => {
    const draggedId = dragIdRef.current
    if (draggedId == null) return null
    const plan = planBlockDrop(draggedId, targetId)
    if (!plan) return null                       // suppressed: the drop is a no-op
    const pages = selectedPagesRef.current
    if (targetId == null) return pages.length    // the END gap (index n)
    const i = pages.findIndex(p => p.id === targetId)
    return i === -1 ? null : i                   // the gap BEFORE that page
  }, [planBlockDrop])
  // Step 14 — the FILE-drop variant of resolveGridSlot: no dragged block, so
  // no no-op check; the insertion index is purely the pointer's gap.
  const resolveFileSlot = useCallback((targetId) => {
    const pages = selectedPagesRef.current
    if (targetId == null) return pages.length    // the END gap (index n)
    const i = pages.findIndex(p => p.id === targetId)
    return i === -1 ? null : i                   // the gap BEFORE that page
  }, [])

  // B18 round 3, pt 5 — resolve a CAPTION drag's drop target from the
  // pointer, shared by the grid's AND the preview's dragover/drop so the
  // cue and the drop can never disagree:
  //   { pageId, pos }    — over a page's TOP/BOTTOM half → that caption slot,
  //   { pageId, merge }  — onto a caption/caption page → MERGE there (pt 4),
  //   { slot }           — a GAP in the GRID (index 0..n into the comic's
  //                        page list; n = the end),
  //   { slotVisible }    — a GAP in the PREVIEW (index 0..n into the VISIBLE
  //                        figure list — normalized onto the full list at
  //                        apply time, the way onSectionDrop does).
  const resolveCaptionTarget = useCallback((e) => {
    const pages = selectedPagesRef.current
    const t = e.target
    const inPreview = !!(t && t.closest && t.closest('.comic-preview'))
    if (inPreview) {
      const scroller = previewRef.current
      const figures = scroller ? Array.from(scroller.querySelectorAll('.preview-figure')) : []
      // A figure directly under the pointer → its half (or merge).
      let fig = null
      for (let i = 0; i < figures.length; i++) {
        const r = figures[i].getBoundingClientRect()
        if (e.clientY >= r.top && e.clientY <= r.bottom) { fig = figures[i]; break }
      }
      if (fig) {
        const id = Number(fig.dataset.pageId)
        const page = pages.find(p => p.id === id)
        if (page) {
          if (!page.file_path) {
            // B18 round 4 — the HALF of the caption page the pointer is in
            // decides where the dragged text lands (top half → dragged text
            // ON TOP; bottom half → BELOW — the owner's pt 3/4 order fix).
            const r0 = fig.getBoundingClientRect()
            return { pageId: id, merge: true, half: (e.clientY < r0.top + r0.height / 2) ? 'top' : 'bottom' }
          }
          // B18 round 6, pt 3 — the pointer is over the page's caption BAR:
          // the destination is that BAR's own slot (data-cap-slot), and the
          // BAR's own top/bottom half — not the figure's — dictates the merge
          // order (the same half mechanic the caption pages already use; the
          // owner: "even if i hovered over the bottom half of the destination
          // caption"). Read-only bars only (an ARMED bar is the page being
          // edited — it keeps the round-4 figure-half rule), found by pointer
          // geometry so a dragover dispatched on the figure (the headless
          // harness) resolves the same bar a real cursor over it would.
          let bar = null
          const figBars = Array.from(fig.querySelectorAll('.cap-bar--bar'))
          for (const b of figBars) {
            const rb = b.getBoundingClientRect()
            if (e.clientY >= rb.top && e.clientY <= rb.bottom) { bar = b; break }
          }
          if (bar) {
            const rb = bar.getBoundingClientRect()
            return {
              pageId: id,
              pos: bar.dataset.capSlot || 'top',
              half: (e.clientY < rb.top + rb.height / 2) ? 'top' : 'bottom',
            }
          }
          const r = fig.getBoundingClientRect()
          return { pageId: id, pos: (e.clientY < r.top + r.height / 2) ? 'top' : 'bottom' }
        }
      }
      // A gap = the first figure whose vertical midpoint is below the
      // pointer (the same scan the page drag uses); none → after the last.
      let idx = figures.length
      for (let i = 0; i < figures.length; i++) {
        const r = figures[i].getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) { idx = i; break }
      }
      return { slotVisible: idx }
    }
    // Grid (tile or list row): the cell under the pointer, else the gap.
    const cell = (t && t.closest) ? t.closest('li[data-page-id]') : null
    if (cell) {
      const id = Number(cell.dataset.pageId)
      const page = pages.find(p => p.id === id)
      if (page) {
        if (!page.file_path) {
          // B18 round 4 — merge half (grid path): pointer half of the caption
          // cell decides the dragged text's order (same rule as the preview).
          const r0 = cell.getBoundingClientRect()
          return { pageId: id, merge: true, half: (e.clientY < r0.top + r0.height / 2) ? 'top' : 'bottom' }
        }
        const r = cell.getBoundingClientRect()
        return { pageId: id, pos: (e.clientY < r.top + r.height / 2) ? 'top' : 'bottom' }
      }
    }
    const targetId = gapFromEvent(e)
    const slot = targetId == null ? pages.length : pages.findIndex(p => p.id === targetId)
    return { slot: slot === -1 ? pages.length : slot }
  }, [gapFromEvent])

  const onGridDragOver = useCallback((e) => {
    const isFile = dragHasFiles(e)
    const isCap = capDragRef.current !== null
    if (!isFile && !isCap && dragIdRef.current === null) return   // not our drag (no Files, no internal drag)
    e.preventDefault()                        // REQUIRED for the drop to be allowed
    if (e.dataTransfer) e.dataTransfer.dropEffect = isFile ? 'copy' : 'move'
    // B18 round 3, pt 5 — a CAPTION drag shows its own cue (half / merge /
    // gap — resolveCaptionTarget) and never the page-drag slot marker.
    if (isCap) {
      setPreviewDropIdx(null)
      setGridDropSlot(null)
      setCapDrop(resolveCaptionTarget(e))
      return
    }
    // Step 11.5c — ONE resolver (gapFromEvent) for the marker AND every grid
    // drop; it handles the grid halves, the list halves, the list-body scan,
    // and the grid gutter (→ the end gap, 11.5b). resolveGridSlot maps it to
    // the gap's insertion index (or null when suppressed).
    // Step 14 — a FILE drag uses resolveFileSlot (no dragged block → no no-op
    // check): the marker shows where the new page(s) will land. Claiming the
    // grid also drops the preview's slot (the inverse is onPreviewDragLeave's
    // job — see there): at any moment at most ONE slot is live, so
    // onSectionDrop can never read a stale one.
    setPreviewDropIdx(null)
    setGridDropSlot(isFile ? resolveFileSlot(gapFromEvent(e)) : resolveGridSlot(gapFromEvent(e)))
  }, [resolveFileSlot, resolveGridSlot, gapFromEvent, resolveCaptionTarget, setCapDrop])
  const onGridDragLeave = useCallback((e) => {
    // Did the pointer actually LEAVE the grid <ul>? Two signals, in order:
    //   1. relatedTarget (when the browser sets it on the dragleave): if it
    //      is NOT inside the ul, the pointer is gone → clear. (Same guard the
    //      user-verified preview indicator uses.)
    //   2. relatedTarget is null (many browsers don't set it on drag events)
    //      AND the element being left IS the ul itself → the pointer is gone
    //      → clear.
    // If neither applies (leaving a child, destination unknown), do NOT clear:
    // the next dragover re-resolves the slot, and drop / dragend (clearDrag)
    // clears definitively — so a stale marker can only persist until then,
    // the same lifetime as the preview's insertion bar. This is robust to
    // either relatedTarget behaviour instead of betting on one.
    const rt = e.relatedTarget
    if (rt) {
      if (!e.currentTarget.contains(rt)) { setGridDropSlot(null); setCapDrop(null) }
      return
    }
    if (e.target === e.currentTarget) { setGridDropSlot(null); setCapDrop(null) }
  }, [setCapDrop])

  // The ONE place a new order is computed + persisted. `next` must be the
  // comic's COMPLETE page set in the new order (the server 400s a partial list).
  const reorder = useCallback(async (next) => {
    if (selectedId === null) return
    if (reorderingRef.current) return
    const newOrder = next.map(p => p.id)
    const currentOrder = selectedPages.map(p => p.id)
    // No-op guard: same length + same sequence = nothing to persist.
    // (Fixed: was `!==` + `||`, which wrongly no-op'd whenever the length
    // differed — e.g. Step 14's insert-after-upload. Now matches the comment.)
    if (newOrder.length === currentOrder.length && currentOrder.every((id, i) => id === newOrder[i])) return
    // round 7b — the reorder is ONE action (suppressed inside a composite,
    // which then owns the entry).
    const hist = beginAction()
    const prevPages = pages                     // the rollback snapshot (pre-optimistic)
    // Optimistic apply: renumber this comic's pages 1..n in the new order.
    // The rest of `pages` (other comics) is untouched.
    const renumbered = next.map((p, i) => ({ ...p, page_number: i + 1 }))
    const others = prevPages.filter(p => p.comic_id !== selectedId)
    setPages([...others, ...renumbered])
    reorderingRef.current = true
    setReordering(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/comics/${selectedId}/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ page_ids: newOrder }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `reorder answered ${res.status}`)
      }
      setNotice('Pages reordered.')
      settleEntry(hist, true)
    } catch (err) {
      setPages(prevPages)                       // roll the optimistic order back
      setError(err.message)
      settleEntry(hist, false)
    } finally {
      reorderingRef.current = false
      setReordering(false)
    }
  }, [selectedId, selectedPages, pages, csrfToken])

  // B18 round 5 — REORDER WITH the unified preview-edit guard. A reorder is
  // one of the preview edits routed through guardPreviewEdit (the modal /
  // regenerate / cross-browser logic lives there).
  const reorderWithGuard = useCallback(async (next) => {
    guardPreviewEdit(() => reorder(next))
  }, [guardPreviewEdit, reorder])

  // Step 13 — the SECTION is the file-drop catch-all: a file dropped anywhere
  // in it appends at the end (Step 14: at the resolved slot). Defined AFTER
  // reorder (it calls it) — a forward reference in the deps array would be a
  // TDZ ReferenceError at mount and unmount the whole tree (black screen).
  const onSectionDrop = useCallback(async (e) => {
    if (!dragHasFiles(e)) return            // an internal reorder drop → its handler already did it
    e.preventDefault()
    setDragActive(false)
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (files.length === 0) return
    // Step 14 — positional insert: the insertion index is the grid slot (if
    // the pointer was over the grid) or the preview slot (if over the
    // preview); otherwise append at the end (drop zone / empty space).
    let insertIndex = null
    if (typeof gridDropSlot === 'number') {
      insertIndex = gridDropSlot
    } else if (typeof previewDropIdx === 'number') {
      const visible = visiblePagesRef.current
      if (previewDropIdx < visible.length) {
        const idx = selectedPages.findIndex(p => p.id === visible[previewDropIdx].id)
        insertIndex = idx === -1 ? null : idx
      } else {
        insertIndex = selectedPages.length   // after the last visible figure → end
      }
    }
    // The upload + reorder is ONE composite (the owner's preview edit): guard
    // it as a single thunk (either it stands (Discard) or it's dropped
    // (Update) or the text is regenerated around it (clean)).
    guardPreviewEdit(async () => {
      const newPages = await addFiles(files)
      if (newPages.length === 0) return
      if (insertIndex === null) return
      // `selectedPages` here is the STALE closure value (length N, before
      // addFiles) — exactly the list the slot was resolved against.
      const newOrder = [
        ...selectedPages.slice(0, insertIndex),
        ...newPages,
        ...selectedPages.slice(insertIndex),
      ]
      reorder(newOrder)
    })
  }, [gridDropSlot, previewDropIdx, selectedPages, visiblePagesRef, addFiles, reorder, guardPreviewEdit])

  // Step 11.5c — the drop resolves the gap with the SAME resolver the marker
  // uses (gapFromEvent), so it lands exactly where the indicator showed. The
  // `page` argument is gone: the event's position decides the gap.
  const onRowDrop = useCallback((e) => {
    const draggedId = dragIdRef.current
    // Step 13 — a FILE drop (no internal drag) is NOT a reorder: don't claim
    // it (no preventDefault / no stopPropagation) so it bubbles on to the
    // section's file-drop handler (onSectionDrop → append at the end). Only an
    // internal block drag is handled here — and it stops propagation so the
    // list-body handler doesn't also fire.
    if (draggedId === null || reorderingRef.current) return
    e.preventDefault()
    e.stopPropagation()                          // keep the list-level handler out
    const targetId = gapFromEvent(e)
    const plan = planBlockDrop(draggedId, targetId)
    clearDrag()
    if (!plan) return                            // self / block member / already there
    reorderWithGuard(plan.next)
    commitDragActive(draggedId)                  // the dragged page becomes active
  }, [clearDrag, reorderWithGuard, planBlockDrop, commitDragActive, gapFromEvent])

  // Step 11.5c — drop on the list body / a row / a row's half: the SAME
  // resolver (gapFromEvent) decides the gap (a row's top/bottom half, the
  // list-body scan, or the gutter → the end gap). Same flow as onRowDrop.
  const onListDrop = useCallback((e) => {
    e.preventDefault()
    // B18 round 3, pt 5 — a CAPTION drop (bar / caption page) applies where
    // the cue was (resolveCaptionTarget — the same half/merge/gap logic the
    // dragover used), then the page-drop machinery is skipped entirely.
    // applyCaptionDrop is defined further down (it needs the caption
    // functions) — read it through the house ref pattern (deleteSelectionRef
    // is the precedent).
    const capSrc = capDragRef.current
    if (capSrc) {
      const target = resolveCaptionTarget(e)
      clearDrag()
      endCaptionDrag()
      if (applyCaptionDropRef.current) applyCaptionDropRef.current(capSrc, target)
      return
    }
    const draggedId = dragIdRef.current
    if (draggedId === null || reorderingRef.current) return
    const targetId = gapFromEvent(e)
    const plan = planBlockDrop(draggedId, targetId)
    clearDrag()
    if (!plan) return                            // the drop would be a no-op
    reorderWithGuard(plan.next)
    commitDragActive(draggedId)
  }, [clearDrag, reorderWithGuard, planBlockDrop, commitDragActive, gapFromEvent, resolveCaptionTarget, endCaptionDrag])

  // --- Step 9.5: drag-reorder on the PREVIEW ----------------------------------
  //
  // The preview window is a SECOND reorder surface (and a cross-pane drop
  // target for tile drags, and vice versa — see the onRowDragStart/onRowDrop
  // above: one dragIdRef + one reorder() means the panes can't disagree):
  //   • each figure is draggable via the SAME onRowDragStart as the tiles
  //     (a drag started on a caption input is still refused — the closest()
  //     guard covers it),
  //   • dragover ANYWHERE in the window → the insertion slot = the first
  //     figure whose vertical midpoint sits BELOW the pointer (else: last),
  //     rendered as a red bar on that figure (before = above, after = below),
  //   • pointer within EDGE px of the window's top/bottom edge → the window
  //     auto-scrolls. dragover fires repeatedly while hovering, so a fixed
  //     step per event reads as a steady scroll,
  //   • drop → reorder() with the FULL page list: the slot is an index into
  //     the VISIBLE list (visiblePages), mapped onto selectedPages — in
  //     "all" mode that's 1:1, in "active page only" mode it's a subset.

  const onPreviewDragOver = useCallback((e) => {
    const isFile = dragHasFiles(e)
    const isCap = capDragRef.current !== null
    if (!isFile && !isCap && dragIdRef.current === null) return   // not our drag
    e.preventDefault()                        // REQUIRED for the drop to be allowed
    if (e.dataTransfer) e.dataTransfer.dropEffect = isFile ? 'copy' : 'move'
    // B18 round 3, pt 5 — a CAPTION drag shows its own cue (half / merge /
    // gap — resolveCaptionTarget) and never the page-drag insertion bar.
    if (isCap) {
      setGridDropSlot(null)
      setPreviewDropIdx(null)
      setCapDrop(resolveCaptionTarget(e))
      return
    }
    // Step 14 — file drags also show the insertion bar (the slot is an index
    // into the VISIBLE list; onSectionDrop maps it onto the full page set).
    const scroller = previewRef.current
    if (!scroller) return
    // Auto-scroll near the window's top/bottom edge (14px per event).
    const rect = scroller.getBoundingClientRect()
    const EDGE = 70
    if (e.clientY < rect.top + EDGE) scroller.scrollTop -= 14
    else if (e.clientY > rect.bottom - EDGE) scroller.scrollTop += 14
    // Insertion slot = the first figure whose vertical midpoint is below the
    // pointer (else: after the last figure).
    const figures = Array.from(scroller.querySelectorAll('.preview-figure'))
    let idx = figures.length
    for (let i = 0; i < figures.length; i++) {
      const r = figures[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) { idx = i; break }
    }
    // Claiming the preview drops the grid's slot (the inverse is
    // onGridDragOver's job): at most ONE slot is live at any moment, so
    // onSectionDrop can never read a stale one — even on browsers that leave
    // relatedTarget null on dragleave (where onPreviewDragLeave's clear may
    // have already fired, but the slot could still be a number).
    setGridDropSlot(null)
    setPreviewDropIdx(idx)
  }, [resolveCaptionTarget, setCapDrop])

  const onPreviewDragLeave = useCallback((e) => {
    // dragleave fires when the pointer moves onto a child — ignore that.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setPreviewDropIdx(null)
    setCapDrop(null)
  }, [setCapDrop])

  const onPreviewDrop = useCallback((e) => {
    e.preventDefault()
    // B18 round 3, pt 5 — a CAPTION drop applies where the cue was
    // (resolveCaptionTarget — the same half/merge/gap logic the dragover
    // used), then the page-drop machinery is skipped.
    const capSrc = capDragRef.current
    if (capSrc) {
      const target = resolveCaptionTarget(e)
      clearDrag()
      endCaptionDrag()
      if (applyCaptionDropRef.current) applyCaptionDropRef.current(capSrc, target)
      return
    }
    const draggedId = dragIdRef.current
    const slot = previewDropIdx
    if (draggedId === null || reorderingRef.current || slot === null) return
    const visible = visiblePagesRef.current
    if (visible.length === 0) return
    // Map the VISIBLE-list slot onto the block-drop target: the bar on
    // figure i = insert before it; after the last figure = last. (The plan
    // then splices the block at exactly that point in the FULL list — "all"
    // mode is 1:1, "active page only" a subset.)
    const targetId = slot < visible.length ? visible[slot].id : null
    const plan = planBlockDrop(draggedId, targetId)
    clearDrag()
    if (!plan) return
    reorderWithGuard(plan.next)
    commitDragActive(draggedId)
  }, [previewDropIdx, clearDrag, reorderWithGuard, planBlockDrop, commitDragActive, resolveCaptionTarget, endCaptionDrag])

  // --- Step 4: caption auto-save ------------------------------------------------
  //
  // B18 round 4 — SLOTTED: every caption editor has its own key
  // `${pageId}:${slot}` (a caption page's slot is 'page'; a media page's
  // bars are 'top' and 'bottom') — a page's two bars are two independent
  // text stores, each with its own debounce timer and armed state, so a
  // top and a bottom caption can exist AT THE SAME TIME (the owner's
  // round-4 requirement). Each editor is controlled by its own field
  // (slotOf()), typing updates local state + the preview immediately, and a
  // per-slot debounce (~600 ms) fires ONE PATCH per edit burst — no save
  // button by design. Blank maps to null (an explicit null CLEARS that slot
  // on the server; '' would store an empty string). On failure the typed
  // value stays (no rollback) and the status line reports the error.

  const saveCaption = useCallback(async (pageId, slot, value) => {
    const next = (value == null || String(value).trim() === '') ? null : value
    // round 7b — consume this burst's undo entry (registered in
    // onCaptionChange, on the FIRST keystroke — the `before` snapshot is
    // still the pre-typing state there). For a programmatic save without a
    // burst, register one now. Inside a composite both are null — the
    // composite owns the entry (settleEntry(null, …) is a no-op).
    const histKey = `${pageId}:${slot}`
    let histEntry
    const hadBurst = histKey in captionBurstRef.current
    if (hadBurst) {
      histEntry = captionBurstRef.current[histKey]
      delete captionBurstRef.current[histKey]
    } else {
      histEntry = beginAction()
    }
    setCaptionSave('saving')
    setCaptionError(null)
    try {
      // B18 round 4 — the slot routes the write: 'top'/'bottom' → that slot
      // column (the other slot stays untouched); 'page' → the legacy
      // `caption` column (caption-ONLY pages).
      const body = { caption: next }
      if (slot !== 'page') body.slot = slot
      const res = await fetch(`/api/admin/comic-pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `save caption answered ${res.status}`)
      }
      setCaptionSave('saved')
      settleEntry(histEntry, true)
      return true
    } catch (err) {
      setCaptionSave('error')
      setCaptionError(err.message)
      settleEntry(histEntry, false)
      return false
    }
  }, [csrfToken])

  const onCaptionChange = useCallback((page, slot, value) => {
    const field = slotOf(slot)
    const next = value.trim() === '' ? null : value
    const current = page[field] ?? null
    // Update the local state instantly (input + preview are driven by it).
    setPages(prev => prev.map(p => (p.id === page.id ? { ...p, [field]: next } : p)))
    if (next === current) return   // nothing changed → nothing to persist
    if (captionSave === 'error') setCaptionSave(null)  // re-typing clears the stale error status
    const timers = captionTimers.current
    const key = `${page.id}:${slot}`
    // round 7b — register the burst's undo entry ONCE, on the FIRST
    // keystroke: the snapshot taken here is still the pre-typing state (the
    // correct `before` — by saveCaption time the text is already in state).
    // Later keystrokes reuse it; saveCaption consumes it. Suppressed inside
    // a composite (the composite owns the entry).
    if (!(key in captionBurstRef.current)) captionBurstRef.current[key] = beginAction()
    if (timers[key]) { clearTimeout(timers[key]); delete timers[key] }
    timers[key] = setTimeout(() => {
      delete timers[key]
      guardPreviewEdit(() => saveCaption(page.id, slot, value))
    }, 600)
  }, [saveCaption, captionSave, guardPreviewEdit])

  // B18 round 3, pts 3/4/12 — flush ONE page's pending debounce timer (the
  // house pattern from round 2 substep 9, generalized): a programmatic
  // save/delete must never race a stale timer armed by typing.
  // B18 round 4 — a page may now hold TWO slots (top + bottom) plus a
  // 'page' store, so "one page's timer" means ALL of its slot keys: clear
  // every `${pageId}:*` entry, not just one.
  const flushCaptionTimer = useCallback((pageId) => {
    const timers = captionTimers.current
    const prefix = `${pageId}:`
    for (const k of Object.keys(timers)) {
      if (k.startsWith(prefix)) { clearTimeout(timers[k]); delete timers[k] }
    }
  }, [])

  // B18 round 3, pt 12 — Enter COMMITS and closes out the caption: flush the
  // pending debounce, disarm (the read-only form returns), and save the
  // current text now (saveCaption normalizes empty → null, the same as
  // blur-empty). No navigation — the owner just wants the box closed.
  // B18 round 4 — per SLOT (commit this editor only; the sibling slot — if
  // any — is untouched).
  const commitCaption = useCallback((page, slot) => {
    const key = `${page.id}:${slot}`
    const timers = captionTimers.current
    if (timers[key]) { clearTimeout(timers[key]); delete timers[key] }
    setCaptionEditId(null)
    guardPreviewEdit(() => saveCaption(page.id, slot, page[slotOf(slot)] ?? ''))
  }, [saveCaption, guardPreviewEdit])

  // B18 round 3, pt 12 — the caption keydown contract, shared by the caption
  // page's textarea and the regular caption's (now multi-line) input:
  //   Enter        → commit + close (above)
  //   Ctrl+Enter   → insert a NEWLINE at the caret (stay in the caption)
  //   Shift+Enter  → newline (the browser's native behaviour — left alone)
  const onCaptionKeyDown = useCallback((e, page, slot) => {
    if (e.key !== 'Enter') return
    if (e.shiftKey) return                      // native newline
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const ta = e.target
      const s = ta.selectionStart ?? ta.value.length
      const en = ta.selectionEnd ?? ta.value.length
      // setRangeText mutates the live value + caret (no React state write —
      // the controlled re-render skips the DOM write when the value is
      // unchanged, so the caret survives).
      ta.setRangeText('\n', s, en, 'end')
      onCaptionChange(page, slot, ta.value)
      return
    }
    e.preventDefault()
    commitCaption(page, slot)
  }, [commitCaption, onCaptionChange])

  // 2026-09-27 user tweak — the "Caption saved" cue is a MOMENT, not a state:
  // it shows in the preview toolbar (next to the active-page toggle) and fades
  // out after ~3 s. Previously it was pinned under the active page's caption
  // box and STUCK there — the state is per-editor, not per-page, so it even
  // followed the active page onto pages that had never been saved.
  useEffect(() => {
    if (captionSave !== 'saved') return undefined
    const t = setTimeout(() => setCaptionSave(null), 3000)
    return () => clearTimeout(t)
  }, [captionSave])

  // --- Step 12 (+ 12.5a + 12.5b): delete a page (the server renumbers) ------
  //
  // TWO pipelines now:
  //   • deletePage(pageId) — the SURGICAL single delete, used by the hover
  //     BIN on a PREVIEW page / TILE / list row (each deletes the page it
  //     points at),
  //   • deletePages(ids) (below) — the BATCH delete, used by the "Delete"
  //     pill in the Pages heading row + the Delete key (the whole
  //     MULTI-selection, or the active page alone when there is none).
  // Both call the same DELETE endpoint (which renumbers the comic's remaining
  // pages to a clean 1..N — Step 12's server change) and both splice +
  // renumber LOCALLY (mirroring the server) instead of a full re-fetch; the
  // response's `count` (server's truth) goes in the notice. The active page
  // + the selection reconcile through the validity effect above. Deleting the
  // LAST page leaves the comic empty ("No pages yet.") — legal, and the
  // validity effect tolerates activePageId = null.
  // B18 round 3, pt 5 — `opts.skipConfirm` lets a flow that ALREADY asked
  // (the merge/drag-drop confirm) delete without a second dialog; the
  // function now also RETURNS a boolean (true = deleted, false = cancelled
  // or failed) so callers can react to a refused confirm (the existing
  // hover-bin callers simply ignore the return).
  const deletePage = useCallback(async (pageId, opts = {}) => {
    // The hover BIN always passes the page it points at. (Step 12.5a also
    // allowed a no-arg call defaulting to the active page — kept as a
    // harmless fallback; the heading pill + Delete key now go through
    // deletePages/deleteSelection below.)
    if (deleting) return false
    if (pageId == null) pageId = activePageId
    if (pageId == null) return false
    const page = selectedPages.find(p => p.id === pageId)
    if (!page) return false
    if (!opts.skipConfirm) {
      // B18 round 6, issue 8 — a STYLED confirm (the reusable modal) instead of
      // the native window.confirm: the destructive "Delete" is the red action,
      // "Cancel" is neutral. It re-enters deletePage with skipConfirm so the
      // actual delete runs exactly once.
      setConfirmReq({
        title: `Delete page ${page.page_number}?`,
        message: `Delete page ${page.page_number} (${fileNameOf(page.file_path)}). The remaining pages renumber — you can undo with Ctrl+Z.`,
        confirmLabel: 'Delete',
        tone: 'danger',
        onConfirm: () => { deletePage(pageId, { skipConfirm: true }) },
      })
      return
    }
    // round 7b — the delete is ONE action (suppressed inside a composite,
    // which owns the entry).
    const hist = beginAction()
    // round 7b — a caption burst registered for THIS page (typed text whose
    // save hasn't landed) dies with the page: settle it as failed so it
    // leaves no phantom entry and can't linger unsettled and block undo.
    // (Composite case: the burst value is null → settleEntry is a no-op.)
    for (const bk of Object.keys(captionBurstRef.current)) {
      if (bk.startsWith(`${pageId}:`)) {
        settleEntry(captionBurstRef.current[bk], false)
        delete captionBurstRef.current[bk]
      }
    }
    setDeleting(true)
    setError(null)
    const prevPages = pages
    try {
      const res = await fetch(`/api/admin/comic-pages/${pageId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `delete answered ${res.status}`)
      }
      const data = await res.json().catch(() => ({}))
      // Splice + renumber this comic's remaining pages (mirror of the server
      // renumber); other comics untouched — same shape as the reorder apply.
      // B18 round 4, pt 3b — FUNCTIONAL update (the old code rebuilt from
      // the CLOSURE's `selectedPages`/`pages` snapshots): the merge/drag
      // paths save the merged text into state and THEN delete the source —
      // and this closure is the instance from BEFORE that save, so the old
      // rebuild clobbered the merge (the owner saw the merged text flash,
      // then snap back to the destination's old text). Reading the LATEST
      // prev instead keeps every in-flight caption write intact; only the
      // deleted row is spliced out.
      setPages(prev => {
        const remaining = prev.filter(p => p.comic_id === selectedId && p.id !== pageId)
        const renumbered = remaining.map((p, i) => ({ ...p, page_number: i + 1 }))
        const others = prev.filter(p => p.comic_id !== selectedId)
        return [...others, ...renumbered]
      })
      // Step 12.5b — remove the deleted page from the MULTI-SELECTION (the
      // validity effect above reconciles the active page: last remaining
      // selected member, else the comic's first page). Deleting a
      // non-selected page leaves the selection untouched.
      setSelectedIds(prev => prev.filter(id => id !== pageId))
      setNotice(data.count !== undefined
        ? `Deleted page ${page.page_number} — ${data.count} page${data.count === 1 ? '' : 's'} left.`
        : `Deleted page ${page.page_number}.`)
      settleEntry(hist, true)
      return true
    } catch (err) {
      setPages(prevPages)
      setError(err.message)
      settleEntry(hist, false)
      return false
    } finally {
      setDeleting(false)
    }
  }, [activePageId, deleting, selectedPages, pages, selectedId, csrfToken])

  // --- B18: caption-only pages + per-comic theme colour ---------------------
  //
  // B18 round 4 — the caption POSITION is no longer a flipped field: a media
  // page's two slots (caption_top / caption_bottom) ARE the positions, and a
  // page may hold both at once — so the old setCaptionPosition flip is gone
  // (rounds 1–3 wrote caption_position 'top'|'bottom' for the single caption;
  // the round-4 slot model supersedes it). A caption page is REVERSIBLE:
  // "merge" folds its text into a neighbouring caption page and deletes the
  // page.

  // B18 round 2, substep 4 — the hover BIN on a caption bar: delete the
  // caption (clear the text → the bar disappears). B18 round 3, pt 3 — now
  // ASKS first (the owner: "regular captions are getting deleted without a
  // verification check. caption pages are correctly asking… it should be
  // asking the same for regular captions as well"): the same house confirm
  // pattern as deletePage. Flushes that page's pending debounce first,
  // clears the text optimistically, then PATCHes null (an explicit null
  // CLEARS the server value). B18 round 4 — per SLOT: the bin deletes its
  // own slot's caption only (the sibling slot — if filled — stays).
  const deleteCaption = useCallback(async (pageId, slot, opts = {}) => {
    const page = selectedPages.find(x => x.id === pageId)
    if (!page) return false
    // B18 round 6, issue 8 — a STYLED confirm (the reusable modal) instead of
    // the native window.confirm; re-enters with skipConfirm to proceed.
    if (!opts.skipConfirm) {
      setConfirmReq({
        title: 'Delete caption?',
        message: `Delete the caption on page ${page.page_number}? You can undo with Ctrl+Z.`,
        confirmLabel: 'Delete',
        tone: 'danger',
        onConfirm: () => { deleteCaption(pageId, slot, { skipConfirm: true }) },
      })
      return
    }
    const field = slotOf(slot)
    const key = `${pageId}:${slot}`
    // round 7b — register the burst's entry BEFORE the local state moves
    // (the text must still be in state for the `before` snapshot); the save
    // below consumes it (suppressed → null inside a composite).
    if (!(key in captionBurstRef.current)) captionBurstRef.current[key] = beginAction()
    const timers = captionTimers.current
    if (timers[key]) { clearTimeout(timers[key]); delete timers[key] }
    setPages(prev => prev.map(x => (x.id === pageId ? { ...x, [field]: null } : x)))
    setCaptionEditId(prev => (prev === key ? null : prev))
    await saveCaption(pageId, slot, null)
    return true
  }, [selectedPages, saveCaption, setPages, setCaptionEditId])

  // B18 round 3, pt 5/15 — insert a BLANK caption-only page at ANY slot
  // (index 0..N into the comic's page list; N = the end). Generalizes round
  // 2's before/after (slot = idx | idx + 1). Flow unchanged: POST the row
  // (no file_path), then persist the NEW ORDER through the one
  // order-persistence point (reorder() — it needs the comic's COMPLETE page
  // set). On a reorder failure the already-created row is kept locally
  // (server truth) so the two never drift — the owner can retry or delete
  // it. `srcPageId`/`srcText` optionally CARRY a source caption's text into
  // the new page (a bar dropped on a gap → the bar is cleared afterwards);
  // the destination is saved BEFORE the source is cleared so a failure can
  // never lose the text.
  const insertCaptionPageAt = useCallback(async (slot, srcPageId = null, srcText = null, srcSlot = null) => {
    if (selectedId === null) { setError('Select a comic first.'); return null }
    if (reorderingRef.current) return null
    // round 7b — POST + reorder (+ carry-over save/clear) is ONE action.
    beginComposite()
    const mine = selectedPages
    const nextNumber = mine.reduce((m, p) => Math.max(m, Number(p.page_number) || 0), 0) + 1
    let newPage = null
    try {
      const res = await fetch('/api/admin/comic-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ comic_id: selectedId, page_number: nextNumber, caption_position: 'page' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `insert caption page answered ${res.status}`)
      }
      const created = await res.json().catch(() => ({}))
      newPage = { id: created.id, comic_id: selectedId, page_number: nextNumber, file_path: null, caption: null, caption_position: 'page' }
    } catch (err) {
      setError(err.message)
      endComposite()
      return null
    }
    // New order: the comic's complete page set with the caption page spliced
    // at the clamped slot. reorder() renumbers 1..n + PATCHes it.
    const at = Math.max(0, Math.min(Number.isFinite(Number(slot)) ? Number(slot) : 0, mine.length))
    const ordered = [...mine]
    ordered.splice(at, 0, newPage)
    await reorder(ordered)
    // reorder() rolled back (its snapshot pre-dates the new row) → restore the
    // row locally; it exists on the server (the POST succeeded).
    setPages(prev => (prev.some(p => p.id === newPage.id) ? prev : [...prev, { ...newPage }]))
    // Optional carry-over: the source bar's text MOVES into the new page, then
    // the bar is cleared (its timer flushed first — the house pattern).
    // B18 round 4 — the source may be a SLOT (top/bottom bar): the text moves
    // out of THAT slot only (the sibling slot — if filled — stays), and the
    // clear targets the same slot.
    if (srcPageId != null && String(srcText ?? '').trim() !== '') {
      const srcField = slotOf(srcSlot || 'page')
      const srcKey = `${srcPageId}:${srcSlot || 'page'}`
      const ok = await saveCaption(newPage.id, 'page', srcText)
      if (ok) {
        // saveCaption persists but never touches the local state — seed the
        // NEW page's row so the preview shows the carried text (the same
        // setPages the paste path does for its pasted text). Without it the
        // new page renders empty even though the server has the text, and
        // the next edit/merge overwrites it (reading the stale null).
        setPages(prev => prev.map(x => (x.id === newPage.id ? { ...x, caption: srcText } : x)))
        const timers = captionTimers.current
        if (timers[srcKey]) { clearTimeout(timers[srcKey]); delete timers[srcKey] }
        setPages(prev => prev.map(x => (x.id === srcPageId ? { ...x, [srcField]: null } : x)))
        setCaptionEditId(prev => (prev === srcKey ? null : prev))
        await saveCaption(srcPageId, srcSlot || 'page', null)
        setNotice('Caption moved to a new caption page.')
      }
    }
    // The new caption page becomes active + selected. scrollActiveRef lets the
    // existing post-render effect (the one user clicks use) centre it — no
    // manual scroll, no double scroll.
    scrollActiveRef.current = true
    setActivePageId(newPage.id)
    setSelectedIds([newPage.id])
    endComposite()
    return newPage
  }, [selectedId, selectedPages, csrfToken, reorder, setError, setPages, setNotice, saveCaption, setActivePageId, setSelectedIds, scrollActiveRef, reorderingRef, captionTimers, setCaptionEditId])

  // Round 2's before/after entry point (the four '+' buttons): the slot is
  // the target page's index, or index + 1.
  const insertCaptionPage = useCallback(async (side, pageId) => {
    // B18 round 2, substep 13 — the '+' targets the page it sits on (ANY
    // page, not just the active one); the active-page fallback keeps the old
    // call shape working.
    const pid = pageId != null ? pageId : activePageId
    if (pid == null) { setError('Select a page first.'); return null }
    const idx = selectedPages.findIndex(p => p.id === pid)
    if (idx === -1) { setError('Select a page first.'); return null }
    return insertCaptionPageAt(side === 'before' ? idx : idx + 1)
  }, [activePageId, selectedPages, setError, insertCaptionPageAt])

  // --- B18 round 7: paste from the clipboard (the real handler) ------------
  //
  // Wired to the document-level `paste` listener (onPasteEvent, above) through
  // pasteHandlerRef — it's declared HERE (after insertCaptionPageAt / reorder /
  // saveCaption / deletePage, which it calls) so the house ref pattern lets the
  // early-declared listener reach it without a TDZ dep. Implements the three
  // paste cases from editor-overhaul.md §10. The file-picker + drag-drop paths
  // are UNCHANGED (append-at-end); only this paste path changes placement.
  //
  // Two small create-at-a-number primitives: the server enforces
  // UNIQUE(comic_id, page_number) (a 409 aborts the create), and the split
  // needs SEVERAL creates before a single reorder — so each create must take a
  // fresh, caller-assigned number rather than insertCaptionPageAt's
  // per-call max+1 (whose stale closure would collide on the second create).

  // A BLANK caption-only page at a SPECIFIC page_number (POST + append locally,
  // no reorder — the caller reorders once at the end).
  const createCaptionPageAtNumber = useCallback(async (pageNumber) => {
    if (selectedId === null) return null
    // round 7b — the create is ONE action (suppressed inside a composite).
    const hist = beginAction()
    try {
      const res = await fetch('/api/admin/comic-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ comic_id: selectedId, page_number: pageNumber, caption_position: 'page' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `create caption page answered ${res.status}`)
      }
      const created = await res.json().catch(() => ({}))
      const row = { id: created.id, comic_id: selectedId, page_number: pageNumber, file_path: null, caption: null, caption_position: 'page' }
      setPages(prev => [...prev, row])
      settleEntry(hist, true)
      return row
    } catch (err) {
      setError(err.message)
      settleEntry(hist, false)
      return null
    }
  }, [selectedId, csrfToken, setPages, setError])

  // A MEDIA page (one uploaded image) at a SPECIFIC page_number.
  const createMediaPageAt = useCallback(async (file, pageNumber) => {
    if (selectedId === null) return null
    // round 7b — the create is ONE action (suppressed inside a composite).
    const hist = beginAction()
    try {
      const up = await uploadImage(file, csrfToken)
      const res = await fetch('/api/admin/comic-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ comic_id: selectedId, page_number: pageNumber, file_path: up.file_path }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `add media page answered ${res.status}`)
      }
      const created = await res.json()
      const row = { id: created.id, comic_id: selectedId, page_number: pageNumber, file_path: up.file_path, caption: null }
      setPages(prev => [...prev, row])
      settleEntry(hist, true)
      return row
    } catch (err) {
      setError(err.message)
      settleEntry(hist, false)
      return null
    }
  }, [selectedId, csrfToken, uploadImage, setPages, setError])

  // The IMAGE/MEDIA paste (non-split): the addFiles pipeline (append-at-end) +
  // a reorder to put the new page(s) AFTER THE ACTIVE PAGE. When there is no
  // active page, or the active page is already the last, the append IS the
  // target position — no reorder needed (the file-picker's behaviour).
  const addPasteImageAfterActive = useCallback(async (files) => {
    // round 7b — upload + reorder is ONE action (the inner addFiles/reorder
    // are composites/actions that suppress themselves inside this one).
    beginComposite()
    const original = selectedPagesRef.current   // the set BEFORE addFiles creates
    const newPages = await addFiles(files)
    if (!newPages || newPages.length === 0) { endComposite(); return }
    const activeId = activePageIdRef.current
    const idx = (activeId != null) ? original.findIndex(p => p.id === activeId) : -1
    // "After the active page" — when there's no active page, or the active page
    // is already the last, the append-at-end addFiles did is exactly that.
    if (idx !== -1 && idx + 1 < original.length) {
      const newOrder = [...original.slice(0, idx + 1), ...newPages, ...original.slice(idx + 1)]
      await reorder(newOrder)
    }
    scrollActiveRef.current = true
    setActivePageId(newPages[0].id)
    setSelectedIds([newPages[0].id])
    endComposite()
  }, [addFiles, reorder, activePageIdRef, selectedPagesRef, scrollActiveRef, setActivePageId, setSelectedIds])

  const handlePaste = useCallback((e) => {
    if (selectedId === null) return
    if (uploadingRef.current || reorderingRef.current) return

    const dt = (e && e.clipboardData) ? e.clipboardData : null
    if (!dt) return
    const items = Array.from(dt.items || [])
    const files = []
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      if (it.kind !== 'file') continue
      const f = (typeof it.getAsFile === 'function') ? it.getAsFile() : null
      if (f && (f.type || '').startsWith('image/')) files.push(f)
    }
    const text = (typeof dt.getData === 'function' ? dt.getData('text/plain') : '') || ''

    // Empty clipboard (no image files, no text) → no-op, no error.
    if (files.length === 0 && text.trim() === '') return

    const activeEl = (typeof document !== 'undefined' && document.activeElement) || null
    const isCapPageInput = (el) => (el instanceof HTMLElement && el.classList.contains('caption-page-input'))
    const capInputEl = isCapPageInput(activeEl) ? activeEl : (e.target && isCapPageInput(e.target) ? e.target : null)
    const inTextField = (activeEl instanceof HTMLTextAreaElement) || (activeEl instanceof HTMLInputElement)

    // --- Case 3: IMAGE paste, caret inside a CAPTION PAGE's text → SPLIT ----
    // A regular caption BAR never splits (it belongs to its image page) — only
    // a caption PAGE's textarea (.caption-page-input) triggers the split.
    if (files.length > 0 && capInputEl) {
      e.preventDefault()
      const attr = capInputEl.getAttribute('data-page-id')
      let capPageId = (attr != null) ? Number(attr) : null
      if (capPageId == null && captionEditId && captionEditId.endsWith(':page')) {
        capPageId = Number(String(captionEditId).slice(0, -':page'.length))
      }
      if (capPageId == null) { setError('Paste target not found.'); return }
      // round 7b — the whole split (creates + reorder + delete + seeds) is
      // ONE action; every exit settles it below.
      beginComposite()
      void (async () => {
        // Flush any pending caption debounce on that page (house pattern) so a
        // stale save can't race the split.
        flushCaptionTimer(capPageId)
        const capPage = selectedPagesRef.current.find(p => p.id === capPageId)
        if (!capPage) { endComposite(); return }
        const fullText = capPage.caption ?? ''
        const caret = (capInputEl.selectionStart != null) ? capInputEl.selectionStart : fullText.length
        const caretPos = Math.max(0, Math.min(caret, fullText.length))
        const before = fullText.slice(0, caretPos)
        const after = fullText.slice(caretPos)
        const hasBefore = before.trim() !== ''
        const hasAfter = after.trim() !== ''
        if (!hasBefore && !hasAfter) {
          // Empty caption — nothing to split; just add the media after the
          // active page (the plain image-paste case). Its own composite
          // nests inside this one (suppressed — the outer entry owns it).
          await addPasteImageAfterActive(files)
          endComposite()
          return
        }
        // Fresh, collision-free numbers (UNIQUE(comic_id,page_number)).
        const mine = selectedPagesRef.current
        const n = mine.reduce((m, p) => Math.max(m, Number(p.page_number) || 0), 0)
        const numMedia = n + 1
        const numBefore = hasBefore ? n + 2 : null
        const numAfter = hasAfter ? (numBefore != null ? n + 3 : n + 2) : null
        // 1. The media page (upload + POST at a reserved number).
        const mediaPage = await createMediaPageAt(files[0], numMedia)
        if (!mediaPage) { endComposite(); return }
        // 2. "before" caption page (created blank — the text is seeded below).
        let beforePage = null
        if (hasBefore) beforePage = await createCaptionPageAtNumber(numBefore)
        // 3. "after" caption page (created blank — the text is seeded below).
        let afterPage = null
        if (hasAfter) afterPage = await createCaptionPageAtNumber(numAfter)
        // 4. ONE reorder: the complete page set with the split in place, the
        //    original caption page pushed to the end (deleted next). reorder()
        //    needs the comic's COMPLETE set (the server 400s a partial list).
        //    `mine` was captured BEFORE the creates above — deterministic, and
        //    already the full original set (capPage is among it).
        const capIdxNow = mine.findIndex(p => p.id === capPageId)
        const newOrder = [
          ...mine.slice(0, capIdxNow),
          ...(beforePage ? [beforePage] : []),
          mediaPage,
          ...(afterPage ? [afterPage] : []),
          ...mine.slice(capIdxNow + 1),
          capPage,
        ]
        await reorder(newOrder)
        // 5. Delete the original caption page (no confirm — its text is about
        //    to be seeded onto the two new pages).
        await deletePage(capPageId, { skipConfirm: true })
        // 6. Seed the split texts (saveCaption persists but never touches the
        //    local state — setPages it so the preview shows the text), then
        //    persist. Done AFTER the reorder/delete so their setPages can't
        //    clobber the seed.
        if (beforePage) {
          setPages(prev => prev.map(p => (p.id === beforePage.id ? { ...p, caption: before } : p)))
          await saveCaption(beforePage.id, 'page', before)
        }
        if (afterPage) {
          setPages(prev => prev.map(p => (p.id === afterPage.id ? { ...p, caption: after } : p)))
          await saveCaption(afterPage.id, 'page', after)
        }
        // 7. The media page becomes active + centred.
        scrollActiveRef.current = true
        setActivePageId(mediaPage.id)
        setSelectedIds([mediaPage.id])
        endComposite()
      })()
      return
    }

    // --- Case 2: IMAGE/MEDIA paste (not in a caption page's text) -----------
    if (files.length > 0) {
      e.preventDefault()
      void addPasteImageAfterActive(files)
      return
    }

    // --- Case 1: TEXT paste --------------------------------------------------
    // Focus in a text field → leave it native (the browser pastes into the
    // field). Only when focus is NOT in a text field do we intercept.
    if (inTextField) return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    // round 7b — the new caption page + its pasted text is ONE action
    // (insertCaptionPageAt's composite nests inside this one — suppressed).
    beginComposite()
    void (async () => {
      const activeId = activePageIdRef.current
      const mine = selectedPagesRef.current
      const idx = (activeId != null) ? mine.findIndex(p => p.id === activeId) : -1
      const slot = (idx === -1) ? mine.length : idx + 1
      const newPage = await insertCaptionPageAt(slot)
      if (newPage) {
        // saveCaption persists but never touches the local state — setPages it
        // so the preview shows the pasted text.
        setPages(prev => prev.map(p => (p.id === newPage.id ? { ...p, caption: text } : p)))
        await saveCaption(newPage.id, 'page', text)
      }
      endComposite()
    })()
  }, [selectedId, uploadingRef, reorderingRef, captionEditId, activePageIdRef, selectedPagesRef, scrollActiveRef,
      createCaptionPageAtNumber, createMediaPageAt, addPasteImageAfterActive, insertCaptionPageAt,
      saveCaption, deletePage, flushCaptionTimer, reorder, setPages, setActivePageId, setSelectedIds, setError])

  // Bind the ref the paste listener reads (declared above, this below — the
  // house pattern, applyCaptionDropRef is the precedent). Runs every render.
  useEffect(() => { pasteHandlerRef.current = handlePaste }, [handlePaste])

  // B18 round 3, pt 5 — the CAPTION-drop applier (the one function every
  // caption drop funnels into, so the cue and the result can't disagree):
  //   • { pageId, pos }  — a page's top/bottom half → that caption slot. The
  //     destination's existing caption (if any) and the dragged one MERGE
  //     (source on TOP, one line break — pt 4); the slot's position flips
  //     to `pos`. Then the source: a bar is cleared (its text moved), a
  //     caption page is deleted (no second confirm — the drop is the
  //     explicit act; pt 5: "…then you can delete the dragged page").
  //   • { pageId, merge }— onto a caption/caption page → merge there (same
  //     join, pt 4) + delete/clear the source. Dropping a page onto ITSELF
  //     is a no-op.
  //   • { slot }         — a gap in the GRID: a bar becomes a caption page
  //     AT that slot (carrying its text — insertCaptionPageAt), a caption
  //     page MOVES there (reorder; no-op when it is already at / directly
  //     before that slot).
  //   • { slotVisible }  — a gap in the PREVIEW: same as { slot } but the
  //     index is into the VISIBLE list → normalized onto the comic's page
  //     list here (the way onSectionDrop does).
  const applyCaptionDrop = useCallback(async (src, target) => {
    const pages = selectedPagesRef.current
    const srcPage = pages.find(p => p.id === src.pageId)
    if (!srcPage) return
    // round 7b — the WHOLE drop (merge + clear/delete, or the slot
    // insert/move) is ONE action; the try/finally settles it on EVERY exit
    // (11 of them — none can be missed).
    beginComposite()
    try {
    const srcText = String(src.text ?? '').trim()

    // --- { slotVisible } → { slot } (normalize onto the full list) ---------
    if (target.slotVisible != null && target.slot == null) {
      const visible = visiblePagesRef.current
      const slot = target.slotVisible >= visible.length
        ? pages.length
        : (() => { const i = pages.findIndex(p => p.id === visible[target.slotVisible].id); return i === -1 ? pages.length : i })()
      target = { slot }
    }

    // --- MERGE onto a caption/caption page ---------------------------------
    // B18 round 4 — the HALF of the destination the pointer was in dictates
    // the ORDER (the owner's pt 3/4 fix): top half → the dragged text lands
    // ON TOP; bottom half → BELOW. (Round 3 always put the dragged text on
    // top, regardless of the half.) Source after the save: a bar's text
    // moved (or was merged in) → its slot clears; a caption page is consumed
    // → deleted (the drop is the explicit act).
    if (target.pageId != null && target.merge) {
      const dst = pages.find(p => p.id === target.pageId)
      if (!dst || dst.id === srcPage.id) return               // onto itself → no-op
      const half = target.half === 'bottom' ? 'bottom' : 'top'
      const dstText = String(dst.caption || '').trim()
      const parts = half === 'top' ? [srcText, dstText] : [dstText, srcText]
      const merged = parts.filter(Boolean).join('\n')
      if (merged !== (dst.caption ?? null)) {
        flushCaptionTimer(dst.id)
        flushCaptionTimer(srcPage.id)
        const ok = await saveCaption(dst.id, 'page', merged)
        if (!ok) { setError('The merged caption could not be saved — nothing was moved.'); return }
        setPages(prev => prev.map(p => (p.id === dst.id ? { ...p, caption: merged } : p)))
      }
      if (src.kind === 'bar') {
        const srcField = slotOf(src.slot || 'page')
        const srcKey = `${srcPage.id}:${src.slot || 'page'}`
        const timers = captionTimers.current
        if (timers[srcKey]) { clearTimeout(timers[srcKey]); delete timers[srcKey] }
        setPages(prev => prev.map(p => (p.id === srcPage.id ? { ...p, [srcField]: null } : p)))
        setCaptionEditId(prev => (prev === srcKey ? null : prev))
        await saveCaption(srcPage.id, src.slot || 'page', null)
      } else {
        await deletePage(srcPage.id, { skipConfirm: true })
      }
      setNotice('Captions merged.')
      return
    }

    // --- A PAGE HALF (a media page's top/bottom SLOT) ------------------------
    // B18 round 4 — the half IS the destination slot (no position flip any
    // more — the slots ARE the positions, and both can be filled at once):
    // an EMPTY slot just receives the text (plain placement — the owner's
    // "ripped from its position" complaint is gone); a FILLED slot merges in
    // the half's ORDER (top half → dragged text on top; bottom half →
    // below). Dropping a bar on ITS OWN page's other half moves the text
    // between that page's slots (the source slot then clears).
    if (target.pageId != null && target.pos) {
      const dst = pages.find(p => p.id === target.pageId)
      if (!dst || dst.file_path === null) return              // media pages only
      const dstField = target.pos === 'bottom' ? 'caption_bottom' : 'caption_top'
      const samePageBar = src.kind === 'bar' && dst.id === srcPage.id
      if (samePageBar && (src.slot || 'page') === target.pos) return   // onto its own half → no-op
      if (srcText !== '') {
        const dstText = String(dst[dstField] || '').trim()
        // B18 round 6, pt 3 — a bar destination carries its OWN half (where
        // the pointer was inside the bar): the merge ORDER follows `half`;
        // the destination slot stays `pos`. A plain figure-half drop has no
        // `half` → the old rule (pos = the order).
        const half = target.half || target.pos
        const parts = half === 'top' ? [srcText, dstText] : [dstText, srcText]
        const merged = parts.filter(Boolean).join('\n')
        if (merged !== (dst[dstField] ?? null)) {
          flushCaptionTimer(dst.id)
          if (!samePageBar) flushCaptionTimer(srcPage.id)
          const ok = await saveCaption(dst.id, target.pos, merged)
          if (!ok) { setError('The caption could not be saved — nothing was moved.'); return }
          setPages(prev => prev.map(p => (p.id === dst.id ? { ...p, [dstField]: merged } : p)))
        }
      }
      // Now the source: a bar's slot clears (its text moved or was merged
      // in); a caption page is consumed → deleted (the drop is the explicit
      // act).
      if (src.kind === 'bar') {
        const srcField = slotOf(src.slot || 'page')
        const srcKey = `${srcPage.id}:${src.slot || 'page'}`
        const timers = captionTimers.current
        if (timers[srcKey]) { clearTimeout(timers[srcKey]); delete timers[srcKey] }
        setPages(prev => prev.map(p => (p.id === srcPage.id ? { ...p, [srcField]: null } : p)))
        setCaptionEditId(prev => (prev === srcKey ? null : prev))
        await saveCaption(srcPage.id, src.slot || 'page', null)
      } else {
        await deletePage(srcPage.id, { skipConfirm: true })
      }
      return
    }

    // --- A GAP (grid slot, or preview slot normalized above) ----------------
    if (target.slot != null) {
      if (src.kind === 'bar') {
        // A bar becomes a caption page AT that slot (carrying its text out
        // of its own SLOT; the slot clears on success).
        if (captionEditId === `${srcPage.id}:${src.slot || 'page'}`) setCaptionEditId(null)
        await insertCaptionPageAt(target.slot, srcPage.id, srcText, src.slot || 'page')
        return
      }
      // A caption page MOVES to that slot (reorder — the one persistence
      // point). No-op when it is already at that slot or directly before it.
      const cur = pages.findIndex(p => p.id === srcPage.id)
      if (cur === -1) return
      if (target.slot === cur || target.slot === cur + 1) return
      if (reorderingRef.current) return
      const ordered = pages.filter(p => p.id !== srcPage.id)
      const at = target.slot > cur ? target.slot - 1 : target.slot
      ordered.splice(Math.max(0, Math.min(at, ordered.length)), 0, pages[cur])
      await reorder(ordered)
      return
    }
    } finally {
      endComposite()
    }
  }, [selectedPagesRef, visiblePagesRef, flushCaptionTimer, saveCaption, setPages, setCaptionEditId, deletePage, insertCaptionPageAt, reorder, reorderingRef, setError, setNotice, captionTimers, captionEditId])

  // Bind the ref the drop handlers read (they're declared above, this below —
  // see the applyCaptionDropRef declaration). Runs every render.
  useEffect(() => { applyCaptionDropRef.current = applyCaptionDrop }, [applyCaptionDrop])

  // B18 round 3, pts 4/5 — "Merge" on a caption-only page: fold its text
  // into the NEAREST CAPTION PAGE (the closest one before it, else the
  // closest one after — `nearestCaptionPage`). NEVER into an actual page
  // (the owner: "honestly think there shouldn't be an option to merge a
  // caption page with an actual page below it" — round 2's image-page
  // target is superseded; the button is disabled when there is no caption
  // page neighbour). The SOURCE text is the upper part, the destination's
  // text the lower part, one line break between (pt 4: "…with a line break
  // between them"); the destination keeps its format/position; the source
  // page is deleted after the save succeeds.
  const mergeCaptionPage = useCallback(async (pageId) => {
    const mine = selectedPages
    const idx = mine.findIndex(p => p.id === pageId)
    if (idx === -1) return
    const target = nearestCaptionPage(mine, pageId)
    if (!target) { setError('No adjacent caption page to merge into.'); return }
    // round 7b — the merge (save + delete) is ONE action; both exits below
    // settle it.
    beginComposite()
    const srcText = String(mine[idx].caption || '').trim()
    const dstText = String(target.caption || '').trim()
    const merged = [srcText, dstText].filter(Boolean).join('\n')
    const changed = merged !== (target.caption ?? null)
    if (changed) {
      // Flush the pending debounced caption saves on BOTH pages first (the
      // round-2 substep-9 pattern): a stale timer armed by typing would
      // otherwise fire AFTER the merge's PATCH and overwrite the merged text.
      flushCaptionTimer(target.id)
      flushCaptionTimer(pageId)
      const ok = await saveCaption(target.id, 'page', merged)
      if (!ok) {
        // The save FAILED — the caption page is KEPT (deleting it would lose
        // its text, and the target never received the merged text either).
        setError('The merged caption could not be saved — the caption page was kept.')
        endComposite()
        return
      }
      // saveCaption PATCHes the server; mirror the merged text locally so
      // the target's box shows it before the splice below.
      setPages(prev => prev.map(p2 => (p2.id === target.id ? { ...p2, caption: merged } : p2)))
    }
    // The source page is deleted (the house confirm still applies — page
    // deletes always ask). B18 round 6, issue 8 — the async STYLED confirm:
    // the composite (save + delete) is ONE action, settled when the owner
    // resolves the modal (the modal only closes via its two buttons). Confirm
    // → the delete runs (the server renumbers 1..N); Cancel → the merge stands
    // (the destination has the text) and the source stays too — say so, so the
    // duplicate is understood, not "stuck".
    if (captionEditId === `${pageId}:page`) setCaptionEditId(null)
    const srcNumber = mine[idx].page_number
    setConfirmReq({
      title: `Delete page ${srcNumber}?`,
      message: `The caption was merged into page ${target.page_number}. Delete the source page ${srcNumber}? You can undo with Ctrl+Z.`,
      confirmLabel: 'Delete',
      tone: 'danger',
      onConfirm: async () => {
        await deletePage(pageId, { skipConfirm: true })   // the server renumbers 1..N
        endComposite()
      },
      onCancel: () => {
        if (changed) {
          setError(`The caption was merged into page ${target.page_number} — the caption page was kept (its delete was cancelled). Delete it from its bin if you want it gone.`)
        }
        endComposite()
      },
    })
  }, [selectedPages, nearestCaptionPage, flushCaptionTimer, saveCaption, deletePage, setError, setPages, captionEditId, setCaptionEditId])

  // B2.5 Step 15 (folded into B18), reworked in B18 round 2 substep 7: the
  // per-comic theme colour. The <input type="color"> fires an `input` event
  // for EVERY tick of a drag-pick, so a PUT-per-event made the swatch lag —
  // now the local value updates OPTIMISTICALLY (instant while picking) and
  // ONE debounced PUT (~400 ms) persists it. The PUT is a partial update
  // (absent fields keep their row values), so sending only theme_colour is
  // safe; null clears it.
  const themeTimer = useRef(null)                  // pending debounced theme PUT
  const themeDropperRef = useRef(null)             // the hidden <input type="color"> (the no-EyeDropper fallback — round 6 pt 4)
  const setThemeColour = useCallback((value) => {
    if (selectedId === null) return
    // round 7b — register the theme burst's undo entry ONCE (undefined =
    // unregistered; suppressed → null inside a composite). The debounced PUT
    // settles it — the `before` snapshot here is still the pre-pick colour.
    if (themeBurstRef.current === undefined) themeBurstRef.current = beginAction()
    setError(null)
    setComics(prev => prev.map(c => (c.id === selectedId ? { ...c, theme_colour: value } : c)))
    if (themeTimer.current) { clearTimeout(themeTimer.current); themeTimer.current = null }
    themeTimer.current = setTimeout(async () => {
      themeTimer.current = null
      try {
        const res = await fetch(`/api/admin/comics/${selectedId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ theme_colour: value }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `set theme colour answered ${res.status}`)
        }
        // round 7b — the PUT landed: settle the theme burst as successful.
        const entry = themeBurstRef.current
        themeBurstRef.current = undefined
        settleEntry(entry, true)
      } catch (err) {
        // round 7b — the PUT failed: settle the burst as failed (discarded —
        // no phantom entry). The optimistic value stays (retry/clear to fix).
        const entry = themeBurstRef.current
        themeBurstRef.current = undefined
        settleEntry(entry, false)
        setError(err.message)   // the optimistic value stays (retry/clear to fix)
      }
    }, 400)
  }, [selectedId, csrfToken, setComics, setError, themeTimer])

  // B18 round 6b — the in-page eyedropper (the owner: "everything seems
  // functional except the eyedropper. It's pretty important so let's find a
  // workaround. would it be easy if we did just eyedropper from within the
  // browser window? … let's try one more time to get the eyedropper working
  // before moving on").
  //
  // The owner's browser lacks the EyeDropper API, and round 6 DELETED the
  // getDisplayMedia screen-share fallback ("very concerning") — and the
  // "tiny screenshot of a few pixels" workaround can't exist: no browser can
  // capture even a few pixels without the SAME full screen/window consent
  // the owner rejected. But this app's own content needs none of that: the
  // comic images are SAME-ORIGIN uploads, so the EXACT pixel under the cursor
  // can be read with zero permissions — draw that 1×1 source rect of the
  // <img> onto a 1×1 <canvas> and getImageData it. No prompt, no capture,
  // every browser. (A cross-origin image would taint the canvas and throw;
  // that's caught and reported as the "use the swatch picker" hint.)
  //
  // The flow: Eyedropper button (no EyeDropper API) → picking=true → the
  // scroller goes crosshair + a hint line → a CAPTURE-phase click (fires
  // before any child's onClick — caption arming, the PageBin page-delete,
  // the fake "Disrupt the narrative" page — and the stopPropagation kills
  // them: picking must never arm a caption or delete a page) resolves the
  // click: an img.preview-thumb under the pointer → that pixel; else the
  // element's computed background-color when it's a real (non-transparent)
  // colour; else the hint line. A success runs the SAME debounced
  // setThemeColour PUT, notes it, and exits the mode; Esc cancels.
  const samplePixel = (imgEl, clientX, clientY) => {
    const r = imgEl.getBoundingClientRect()
    if (!r.width || !r.height || !imgEl.naturalWidth || !imgEl.naturalHeight) return null
    // .preview-thumb is width/height:auto (no object-fit crop) — the rendered
    // box maps 1:1 onto image content, so the scale is exact.
    const x = Math.floor((clientX - r.left) * (imgEl.naturalWidth / r.width))
    const y = Math.floor((clientY - r.top) * (imgEl.naturalHeight / r.height))
    if (x < 0 || y < 0 || x >= imgEl.naturalWidth || y >= imgEl.naturalHeight) return null
    try {
      const c = document.createElement('canvas')
      c.width = 1; c.height = 1
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(imgEl, x, y, 1, 1, 0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('')
    } catch {
      return null   // tainted canvas (cross-origin image) → the hint line
    }
  }

  // "rgb(r, g, b)" / "rgba(r, g, b, a)" → "#rrggbb"; null when absent or
  // transparent (alpha 0 is NO colour — don't sample it).
  const rgbaToHex = (s) => {
    const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\s*\)$/.exec((s || '').trim())
    if (!m) return null
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null
    return '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('')
  }

  const handlePickClick = useCallback((e) => {
    // CAPTURE phase: this fires before ANY child onClick (caption arming, the
    // PageBin delete, the fake page) — and the stopPropagation below kills
    // those, so a pick click can never arm a caption or delete a page.
    e.stopPropagation()
    const t = e.target
    const img = t && t.closest ? t.closest('img.preview-thumb') : null
    if (img) {
      const hex = samplePixel(img, e.clientX, e.clientY)
      if (hex) {
        setThemeColour(hex)
        setPickHint(null)
        setPicking(false)
        setNotice(`Theme colour set to ${hex} (sampled from the image).`)
        return
      }
      setPickHint('That image can’t be sampled in this browser — use the small swatch button for a manual colour.')
      return
    }
    const hex = t && t.nodeType === 1 ? rgbaToHex(getComputedStyle(t).backgroundColor) : null
    if (hex) {
      setThemeColour(hex)
      setPickHint(null)
      setPicking(false)
      setNotice(`Theme colour set to ${hex} (sampled from the element).`)
      return
    }
    setPickHint('Click on a comic image to sample its colour.')
  }, [setThemeColour])

  const startInPagePick = useCallback(() => {
    setPickHint(null)
    setPicking(true)
  }, [])

  // Esc cancels pick mode (the theme is untouched — no PUT has fired yet).
  useEffect(() => {
    if (!picking) return undefined
    const onKey = (ev) => { if (ev.key === 'Escape') { setPicking(false); setPickHint(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking])

  // A comic switch mid-pick must cancel the mode — setThemeColour targets the
  // CURRENT selectedId at PUT time, and a sample taken for the old comic must
  // never land on the new one.
  useEffect(() => { setPicking(false); setPickHint(null) }, [selectedId])

  // --- Step 12.5b: MULTI-delete (the heading pill + the Delete key) ---------
  //
  // ONE confirm names the count + the page numbers, then a SEQUENTIAL loop of
  // DELETE /api/admin/comic-pages/:id. The ids are STABLE primary keys — the
  // server renumbers the remaining pages after each delete, but the other
  // targets' ids stay valid, so the loop order doesn't matter and NO backend
  // change is needed. Local state: splice ALL the deleted ids out of `pages`
  // + renumber the rest in ONE update (the net effect of the server's
  // per-delete renumbers), applied optimistically BEFORE the loop. ANY failed
  // request rolls the batch back to the pre-batch snapshot — the selection +
  // active page reconcile through the validity effect above (success: the
  // deleted ids prune themselves out of the selection; failure: the pages are
  // back, so the selection stays valid and the batch can be retried).
  const deletePages = useCallback(async (ids, opts = {}) => {
    if (deleting) return
    if (!Array.isArray(ids) || ids.length === 0) return
    // Resolve to the current comic's pages (reading order); ignore ids that
    // aren't pages of this comic (a stale selection from another comic).
    const targets = selectedPages.filter(p => ids.includes(p.id))
    if (targets.length === 0) return
    const numbers = targets.map(p => p.page_number)
    // B18 round 6, issue 8 — a STYLED confirm (the reusable modal) instead of
    // the native window.confirm; re-enters with skipConfirm to proceed.
    if (!opts.skipConfirm) {
      setConfirmReq({
        title: `Delete ${targets.length} page${targets.length === 1 ? '' : 's'}?`,
        message: `Delete ${targets.length} page${targets.length === 1 ? '' : 's'} (pages ${numbers.join(', ')}). The remaining pages renumber — you can undo with Ctrl+Z.`,
        confirmLabel: 'Delete',
        tone: 'danger',
        onConfirm: () => { deletePages(ids, { skipConfirm: true }) },
      })
      return
    }
    // round 7b — the whole batch is ONE action (a partial batch keeps its
    // entry: the pages that landed are a real, undoable state).
    const hist = beginAction()
    // round 7b — caption bursts registered for ANY deleted page die with the
    // page: settle them as failed (no phantom entry, no unsettled block).
    for (const t of targets) {
      for (const bk of Object.keys(captionBurstRef.current)) {
        if (bk.startsWith(`${t.id}:`)) {
          settleEntry(captionBurstRef.current[bk], false)
          delete captionBurstRef.current[bk]
        }
      }
    }
    setDeleting(true)
    setError(null)
    const prevPages = pages                    // pre-batch snapshot (the rollback target)
    const removed = new Set(targets.map(p => p.id))
    // Splice ALL deleted pages out of this comic + renumber the remainder —
    // other comics untouched (same shape as the single-delete apply).
    const remaining = selectedPages.filter(p => !removed.has(p.id))
    const renumbered = remaining.map((p, i) => ({ ...p, page_number: i + 1 }))
    const others = prevPages.filter(p => p.comic_id !== selectedId)
    setPages([...others, ...renumbered])
    try {
      let finalCount = undefined
      for (const target of targets) {
        const res = await fetch(`/api/admin/comic-pages/${target.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `delete answered ${res.status}`)
        }
        finalCount = (await res.json().catch(() => ({}))).count
      }
      setNotice(finalCount !== undefined
        ? `Deleted ${targets.length} page${targets.length === 1 ? '' : 's'} — ${finalCount} page${finalCount === 1 ? '' : 's'} left.`
        : `Deleted ${targets.length} page${targets.length === 1 ? '' : 's'}.`)
      settleEntry(hist, true)
    } catch (err) {
      setPages(prevPages)                      // roll the whole batch back
      setError(err.message)
      settleEntry(hist, false)
    } finally {
      setDeleting(false)
    }
  }, [deleting, selectedPages, pages, selectedId, csrfToken])

  // Step 12.5b — the "delete the selection" entry point (heading pill + the
  // Delete key): the whole multi-selection, or the ACTIVE page alone (1 page)
  // when there is no selection.
  const deleteSelection = useCallback(() => {
    const ids = selectedIds.length ? selectedIds : (activePageId != null ? [activePageId] : [])
    if (ids.length === 0) return
    guardPreviewEdit(() => deletePages(ids))
  }, [selectedIds, activePageId, deletePages, guardPreviewEdit])

  // Step 12.5a + 12.5b — keyboard delete + Esc. The Delete key deletes the
  // SELECTION (falling back to the active page — 1 page) instead of the
  // active page alone. GUARD (mandatory, since 12.5a): the key is inert
  // while an INPUT/TEXTAREA/SELECT/contentEditable element has focus — a
  // caption (or the new-comic title) being typed must stay editable. Esc
  // collapses the selection to just the primary (active) page. Both listeners
  // bind ONCE (house pattern: the Step-10 wheel effect) and read the LATEST
  // callback / state from refs, so they never go stale.
  const deleteSelectionRef = useRef(deleteSelection)
  useEffect(() => { deleteSelectionRef.current = deleteSelection }, [deleteSelection])
  // Step 12.5d — arrow-key navigation (simple Windows behaviour). From the
  // ACTIVE (primary) page, the NEIGHBOUR in the arrow's direction — where
  // "neighbour" is decided by WHERE the selection was last MADE
  // (lastSurfaceRef):
  //   • on the PAGES window (a tile/row) → a true GRID cell: Up/Down = one
  //     row, Left/Right = one column, clamped at the grid's edges (no wrap,
  //     no crossing a row boundary);
  //   • in the PREVIEW → the page-ORDER neighbour: Up = the previous page
  //     (page 8 → Up → page 7 — NOT whatever tile sits physically above the
  //     active one), Down = the next page; Left/Right are inert.
  // The column count is measured from the RENDERED grid (auto-fill is
  // responsive, so it can't be a constant); in the list/fill regimes it is 1,
  // which collapses everything to page order. `gridRef` points at the pages
  // `<ul>` (bound in the JSX below).
  //   • PLAIN arrow  — MOVE: the neighbour becomes active, any multi-selection
  //     is CLEARED (selection = [active]), and the anchor re-anchors there.
  //   • SHIFT+arrow  — RANGE: the selection becomes the page-order range from
  //     the anchor to the neighbour — it GROWS as you move away from the
  //     anchor and SHRINKS as you move back (back to the anchor = just the
  //     anchor). The anchor itself never moves on a Shift+arrow.
  const gridRef = useRef(null)
  const onArrowNav = useCallback((dir, withShift) => {
    const pages = selectedPagesRef.current
    const len = pages.length
    if (len === 0) return false
    const i = pages.findIndex(p => p.id === activePageIdRef.current)
    if (i === -1) return false
    let C = 1
    const el = gridRef.current
    if (el) {
      const cols = getComputedStyle(el).gridTemplateColumns
      if (cols && cols !== 'none') C = cols.split(' ').filter(Boolean).length
    }
    const grid = lastSurfaceRef.current === 'pages' && C > 1
    let target = null
    if (grid) {
      const col = i % C
      if (dir === 'up' && i >= C) target = i - C
      else if (dir === 'down' && i < len - C) target = i + C
      else if (dir === 'left' && col > 0) target = i - 1
      else if (dir === 'right' && col < C - 1) target = i + 1
    } else {
      if (dir === 'up') target = i - 1
      else if (dir === 'down') target = i + 1
      // Left/Right: a single column has no lateral neighbour
    }
    if (target === null) return false              // no neighbour that way
    target = Math.max(0, Math.min(len - 1, target))
    if (target === i) return false                 // already at the edge
    const pageId = pages[target].id
    if (withShift) {
      // Range from the anchor (a stale anchor falls back to the active page)
      // to the neighbour, inclusive — in page order.
      let aIdx = pages.findIndex(p => p.id === anchorRef.current)
      if (aIdx === -1) aIdx = i
      const [lo, hi] = aIdx < target ? [aIdx, target] : [target, aIdx]
      setSelectedIds(pages.slice(lo, hi + 1).map(p => p.id))
    } else {
      setSelectedIds([pageId])                     // plain arrow = move + clear
      anchorRef.current = pageId                   // …and re-anchor there
    }
    setActivePageId(pageId)                        // neighbour = new primary
    scrollActiveRef.current = true                 // bring it into view (preview + tile)
    return true
  }, [])
  const onArrowNavRef = useRef(onArrowNav)
  useEffect(() => { onArrowNavRef.current = onArrowNav }, [onArrowNav])
  useEffect(() => {
    const onKeyDown = (e) => {
      const t = e.target
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (inField) return                       // typing must stay editable (all keys)
      if (e.key === 'Delete') {
        deleteSelectionRef.current()
      } else if (e.key === 'Escape') {
        // Collapse a multi-selection to the primary (the active page) and
        // re-anchor there. Nothing to collapse when the selection has ≤ 1
        // member (the re-anchor is harmless either way).
        setSelectedIds(prev => (prev.length > 1 ? [activePageIdRef.current] : prev))
        anchorRef.current = activePageIdRef.current
      } else if (e.key && e.key.indexOf('Arrow') === 0 && !e.altKey && !e.ctrlKey && !e.metaKey) {
        // Step 12.5d — PLAIN arrow = move (clearing any multi-selection);
        // SHIFT+arrow = grow/shrink the selection around the anchor. Inert in
        // text fields (the guard above); preventDefault only when we handled
        // it, so an unhandled direction doesn't eat a legitimate default.
        const handled = onArrowNavRef.current(e.key.slice(5).toLowerCase(), e.shiftKey)
        if (handled) e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // --- Loading / error (before the first fetch lands) -------------------------
  if (comics === null) {
    if (error) {
      return (
        <section className="comic-editor">
          <h2>Comic editor</h2>
          <div className="panel panel--warn">
            <p className="error" style={{ marginTop: 0 }}>Couldn't load the comic editor.</p>
            <p className="muted">{error}</p>
            <p><button onClick={() => load()}>Try again</button></p>
          </div>
        </section>
      )
    }
    return (
      <section className="comic-editor">
        <h2>Comic editor</h2>
        <p className="muted">Loading comics…</p>
      </section>
    )
  }

  const selectedComic = comics.find(c => c.id === selectedId) || null

  // B18 round 5 — the shared-draft signal for the selected comic (the server
  // says "unsaved text mode edits" exist). Drives the RED toggle, the "Unsaved
  // text mode edits." badge, and the RED comic-list entry — in ANY browser
  // (the draft is server-side, not this session's local textDirty).
  const hasDraftForSelected = !!(selectedComic && selectedComic.unsavedTextMode)

  // Step 10 — derive the zoom regime + the grid tile size for THIS render:
  // low = a file-name list, mid = the grid (tile = `--tile` px), high = one
  // full-width tile. `tilePx` is linear across the grid regime (20..80 →
  // 72..260px).
  const zoomRegime = zoom <= ZOOM_LIST_MAX ? 'list'
    : zoom >= ZOOM_FILL_MIN ? 'fill'
    : 'grid'
  const zoomT = Math.max(0, Math.min(1, (zoom - ZOOM_LIST_MAX) / (ZOOM_FILL_MIN - ZOOM_LIST_MAX)))
  const tilePx = Math.round(GRID_TILE_MIN + zoomT * (GRID_TILE_MAX - GRID_TILE_MIN))

  // Step 12.5b — the heading pill carries the COUNT it will delete: the whole
  // multi-selection, or the active page alone (1) when there is no selection.
  const deleteCount = selectedIds.length
    ? selectedIds.length
    : (activePageId != null ? 1 : 0)

  // Step 11 — the section is the generic RESIZABLE section (plain pattern,
  // reusable by the story / media sections + B2.8): fixed height (state) + grips
  // on both edges that drag-resize it; the two windows inside flex-fill +
  // scroll internally. The loading / error branches above stay plain <section>s.
  // Step 11.5a (FIFTH revision — the current one) — two deltas, both grow the
  // section's height (the bottom grip at the bottom edge, the top grip with a
  // parallel page scroll so the growth is visible). No content-above shift —
  // ResizableSection owns both deltas + the grips + persistence; this
  // component just mounts it.
  return (
    <ResizableSection
      className={'comic-editor' + (dragActive ? ' comic-editor--file-drag' : '')}
      storageKey="comicEditor"
      // B2.8 — the minimise affordance (title shown on the collapsed bar).
      title="Comic editor"
      // Step 13 — the section is the file-drop catch-all (a file dropped
      // anywhere in it appends at the end). The drop zone stays the bright
      // anchor (dragActive lights both the section ring and .dropzone--active).
      onDragOver={onSectionDragOver}
      onDrop={onSectionDrop}
      onDragLeave={onSectionDragLeave}
    >
      <h2>Comic editor</h2>
      <p className="muted">
        Split view — pick or create a comic on the left, add its pages with the
        dropzone (drag a batch · Ctrl+V / click to paste · double-click to pick files),
        drag a page to reorder (it persists), and edit the active page's caption
        above its image in the preview (it auto-saves — no save button).
      </p>

      {error && (
        <p className="error">
          {error}{' '}
          <button style={{ padding: '4px 10px' }} onClick={() => load()}>Reload</button>
        </p>
      )}
      {notice && <p className="success">{notice}</p>}

      <div className="comic-split">
        {/* LEFT — the editor pane: comic select + create form + dropzone + page list. */}
        <div className="comic-left">
          <label htmlFor="comic-select">Comic</label>
          {/* B18 round 6, issue 7 — the unsaved comic is RED the moment it
              shows, not only on hover. Native <select> dropdowns largely
              ignore option CSS, so the signal is layered three ways: (a) the
              CLOSED control (always visible) turns red when the SELECTED comic
              has unsaved edits; (b) an inline colour on the <option> (works in
              Chromium's list); (c) the leading "● " marker, which survives
              OS-drawn dropdowns that ignore both. */}
          <select
            id="comic-select"
            className={selectedComic && selectedComic.unsavedTextMode ? 'comic-select comic-select--unsaved' : 'comic-select'}
            value={selectedId ?? ''}
            onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : null)}
          >
            {comics.length === 0 && <option value="">(no comics yet — create one below)</option>}
            {comics.map(c => (
              <option
                key={c.id}
                value={c.id}
                className={c.unsavedTextMode ? 'comic-option comic-option--unsaved' : 'comic-option'}
                style={c.unsavedTextMode ? { color: 'var(--accent)', fontWeight: 700 } : undefined}
              >
                {c.unsavedTextMode ? '● ' : ''}{c.title}
              </option>
            ))}
          </select>

          {/* B2.5 Step 15 (folded into B18) — the per-comic theme colour. It
              tints the caption backgrounds (the text auto-contrasts via
              legibleTextOn). The swatch always shows a valid colour input;
              "Clear" sends null (an explicit null CLEARS the server value). */}
          {selectedComic && (
            <div className="row theme-row" style={{ marginTop: '12px' }}>
              <label htmlFor="theme-colour" className="theme-label">Theme colour</label>
              {/* B18 round 4, pt 6 — with NO theme colour the captions
                  render on DEFAULT_CAPTION_BG (the --card surface), so the
                  swatch shows THAT — never white (the owner: "the theme
                  colour box shows white … instead of whatever the actual
                  default is"). */}
              <input
                id="theme-colour"
                className="theme-input"
                type="color"
                value={selectedComic.theme_colour || DEFAULT_CAPTION_BG}
                title={selectedComic.theme_colour
                  ? `Theme colour ${selectedComic.theme_colour} — change it, or Clear`
                  : `Optional — tints this comic's captions (default ${DEFAULT_CAPTION_BG})`}
                onChange={e => setThemeColour(e.target.value)}
              />
              {/* B18 round 2, substep 8 — one-click pick (the EyeDropper
                  API, Chrome/Edge 105+). B18 round 3, pt 11 — the owner
                  "don't see [it] anywhere": the button is ALWAYS rendered
                  (never vanishing with no hint). B18 round 4, pt 5 — the
                  owner: "the eyedropper tool is always greyed out and
                  there's no way to activate it." It is ALWAYS enabled.
                  B18 round 6, pt 4 — the owner: "the eyedropper using the
                  share screen with the site is very concerning. is there no
                  other way to do this?" — the round-4 getDisplayMedia
                  screen-pick is GONE (no screen capture, no permission
                  prompt). B18 round 6b — where the browser lacks the
                  EyeDropper API the button enters IN-PAGE pick mode (the
                  exact pixel of the app's own same-origin comic images, via
                  a 1×1 canvas — see handlePickClick); THIS hidden input is
                  now opened only by the small .theme-picker swatch button
                  (a manual colour). Cancelling any path (a throw, or a
                  dismissed dialog) is swallowed. */}
              <input
                ref={themeDropperRef}
                type="color"
                className="theme-dropper-input"
                aria-hidden="true"
                tabIndex={-1}
                value={selectedComic.theme_colour || DEFAULT_CAPTION_BG}
                onChange={e => { if (e.target.value) setThemeColour(e.target.value) }}
              />
              <button
                type="button"
                className="theme-dropper"
                title={'EyeDropper' in window
                  ? 'Pick a colour from anywhere on screen'
                  : 'Pick a colour from the pages — click a comic image (in-page eyedropper); Esc cancels'}
                onClick={() => {
                  // B18 round 6b — window.__noEyeDropper (test seam) forces
                  // the in-page path even where the API exists (the CDP
                  // harness' Chrome has the EyeDropper API).
                  if ('EyeDropper' in window && !window.__noEyeDropper) {
                    new window.EyeDropper().open()
                      .then(res => { if (res && res.sRGBHex) setThemeColour(res.sRGBHex) })
                      .catch(() => {})             // the user cancelled the picker
                    return
                  }
                  // No EyeDropper API (the owner's browser) — the IN-PAGE
                  // eyedropper (round 6b): the preview goes crosshair and a
                  // click on a comic image samples its EXACT pixel (1×1
                  // canvas over a same-origin upload — no screen capture, no
                  // permission prompt at all). Esc cancels.
                  startInPagePick()
                }}
              >
                Eyedropper
              </button>
              {/* B18 round 6b — the native <input type="color"> picker, KEPT
                  as a small secondary control (a manual colour) now that the
                  Eyedropper button's no-API fallback is the in-page eyedropper. */}
              <button
                type="button"
                className="theme-picker"
                title="Open the colour picker (a manual colour)"
                onClick={() => {
                  const el = themeDropperRef.current
                  if (!el) return
                  try { el.showPicker() } catch { el.click() }
                }}
              >
                <span
                  className="theme-picker-swatch"
                  aria-hidden="true"
                  style={{ background: selectedComic.theme_colour || DEFAULT_CAPTION_BG }}
                />
              </button>
              <button
                type="button"
                className="theme-clear"
                title="Clear the theme colour"
                disabled={!selectedComic.theme_colour}
                onClick={() => setThemeColour(null)}
              >
                Clear
              </button>
            </div>
          )}

          <div className="row" style={{ marginTop: '12px' }}>
            <input
              type="text"
              value={newTitle}
              placeholder="New comic title…"
              style={{ flex: '1 1 160px' }}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createComic() }}
            />
            <button onClick={createComic} disabled={creating}>
              {creating ? 'Creating…' : 'New comic'}
            </button>
          </div>

          {/* Step 2 — the live dropzone (the VISUAL ANCHOR). THREE input paths:
              single click = paste · double click = picker · and Step 13 — drag
              a file anywhere in the SECTION. This box is just the bright anchor
              (it still lights up via dragActive); the section is the actual drop
              target, so its dragover/drop handlers live on the section
              (onSectionDragOver/Leave/Drop) — NOT here — and a drop on the drop
              zone therefore can't double-append. */}
          <div
            className={
              'dropzone'
              + (dragActive ? ' dropzone--active' : '')
              + (uploading ? ' dropzone--busy' : '')
            }
            onClick={onZoneClick}
            onDoubleClick={onZoneDoubleClick}
            title="Drag an image anywhere in the section to add it · Ctrl+V (or click) to paste · double-click to pick files"
          >
            {uploading ? (
              <span>{uploadMsg || 'Uploading…'}</span>
            ) : (
              <span className="muted">
                Drop a batch of images here · Ctrl+V or click to paste · double-click to pick files
              </span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onFilePicked}
          />

          {/* Step 10 — the pages SECTION (wheel-zoom target; the native
              non-passive `wheel` listener is bound to this wrapper). Inside:
              the Pages heading + the pages surface, whose regime follows
              `zoom` — fully out = a file-name list, between = the Step-9
              grid (tile size = `--tile`, set inline), fully in = one tile
              filling the section width. */}
          <div className="pages-section" ref={pagesSectionRef}>
            {/* B18 round 6 — the UNIFIED heading row (BOTH modes). Replaces the
                old mode-bar + text-pane-toolbar + pages-heading (issues 1/4/5):
                LEFT   — the "Text Mode" toggle, pill-styled like "active page
                         only" (always says "Text Mode"; greyed off / highlighted
                         on) + the unsaved badge (ONE consistent spot, issue 4).
                CENTRE — "Media — Comic Name" (tiles) / "Text — Comic Name"
                         (text), centred over the surface (issue 5).
                RIGHT  — the text-mode controls (Update · Auto · Copy), in-line
                         with the heading (issue 5); hidden in tiles mode.
                Delete moved to the PREVIEW heading (issue 6a). */}
            <div className="editor-heading">
              <div className="heading-left">
                <button
                  type="button"
                  className={
                    'preview-toggle mode-toggle'
                    + (textMode ? ' preview-toggle--on' : '')
                    + (textDirty || hasDraftForSelected ? ' mode-toggle--unsaved' : '')
                  }
                  aria-pressed={textMode}
                  title={textDirty || hasDraftForSelected
                    ? 'Unsaved text mode edits. Update applies them (the text wins); Discard keeps the comic (the edits are lost).'
                    : (textMode ? 'Switch back to the tile view.' : 'Edit this comic as text.')}
                  onClick={handleModeToggle}
                >
                  Text Mode
                </button>
                {(textDirty || hasDraftForSelected) ? (
                  <span className="unsaved-badge" title="This comic has unsaved text-mode edits (shared across browsers).">Unsaved text mode edits.</span>
                ) : null}
              </div>
              <h3 className="heading-title">
                {(textMode ? 'Text' : 'Media') + ' — ' + (selectedComic ? selectedComic.title : 'Untitled')}
                {reordering ? <span className="muted" style={{ fontWeight: 400 }}> — reordering…</span> : null}
              </h3>
              <div className="heading-right">
                {textMode ? (
                  <>
                    <button
                      type="button"
                      className="text-btn text-btn--primary"
                      disabled={textUpdating || !textDirty}
                      title="Apply the text to the comic (reorder the media, set the captions, create/delete caption pages)."
                      onClick={() => applyTextMode()}
                    >
                      {textUpdating ? 'Updating…' : 'Update'}
                    </button>
                    <label className="auto-update" title="When ON, moving a marker in the text immediately reorders the preview (live).">
                      <input
                        type="checkbox"
                        checked={autoUpdate}
                        onChange={e => setAutoUpdate(e.target.checked)}
                      />
                      Auto
                    </label>
                    <button
                      type="button"
                      className="text-btn"
                      title="Copy the text WITHOUT the punctuation markup (the plain prose + captions, in order)."
                      onClick={copyText}
                    >
                      {copyCue || 'Copy'}
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            {textMode ? (
              /* B18 round 6 — the TEXT PANE: the comic as editable markdown.
                 The Update · Auto · Copy toolbar now lives in the heading row
                 above. Markers [media N] are the numbered media, ">" lines are
                 captions, "---" fences are caption pages, and everything else
                 is prose. */
              <textarea
                ref={textPaneRef}
                className="text-pane"
                value={textValue}
                onChange={e => handleTextChange(e.target.value)}
                spellCheck={false}
                placeholder={'Describe the comic…\n\n[media 1]\n> A caption above or below the image.\n\n---\nA caption-only page.\n---'}
              />
            ) : (
              <>
            {/* B18 round 6 — the heading moved to the shared editor-heading
                above (both modes), and the Delete pill moved to the PREVIEW
                heading (issue 6a). The grid (or the fake first-tile caption
                page) renders directly under the heading row. */}
            {selectedPages.length === 0 ? (
              /* B18 round 3, pt 15 — the FAKE caption page in the position
                 of the FIRST TILE (a real grid cell, so it sits exactly
                 where page 1 would): theme red (var(--accent)), white
                 italic "Disrupt the narrative…", the '+' centred below.
                 Click → a real caption page of the DEFAULT colour at slot 0.
                 Vanishes the moment any page exists (this conditional). */
              <ul
                className={'page-grid page-grid--' + zoomRegime}
                style={zoomRegime === 'grid' ? { '--tile': tilePx + 'px' } : undefined}
              >
                <li className={'page-tile fake-tile' + (zoomRegime === 'list' ? ' fake-tile--list' : '')}>
                  {/* B18 round 4, pt 7 — opening a caption page lands it
                      IMMEDIATELY in the typable state: create it, then arm
                      its 'page' editor (the armed textarea already autofocuses). */}
                  <FakeCaptionPage onAdd={async () => { guardPreviewEdit(async () => { const created = await insertCaptionPageAt(0); if (created) setCaptionEditId(`${created.id}:page`) }) }} />
                </li>
              </ul>
            ) : (
              <ul
                ref={gridRef}
                className={'page-grid page-grid--' + zoomRegime}
                style={zoomRegime === 'grid' ? { '--tile': tilePx + 'px' } : undefined}
                onDragOver={onGridDragOver}
                onDragLeave={onGridDragLeave}
                onDrop={onListDrop}
              >
                {selectedPages.map((p, i) => {
                  const isActive = activePageId === p.id
                  // Step 12.5b — the multi-selection membership (the ACTIVE
                  // page takes the full --active treatment; the other selected
                  // pages get the softer --selected outline).
                  const isSelected = !isActive && selectedIds.includes(p.id)
                  if (zoomRegime === 'list') {
                    // Step 10 — fully zoomed OUT: a vertical file-name list
                    // (no thumbnails). Click still activates + centres the
                    // page in the preview.
                    // Step 11.5c — the rows are now DRAGGABLE too (the grid
                    // tiles' drag handlers, verbatim): a row drag moves that
                    // page / the whole selection; the ul's onDragOver + onDrop
                    // (onGridDragOver / onListDrop) resolve the row's half +
                    // the body with the SAME resolver the marker uses.
                    return (
                      <li
                        key={p.id}
                        data-page-id={p.id}
                        className={
                          'page-list-item'
                          + (isActive ? ' page-list-item--active' : '')
                          + (isSelected ? ' page-list-item--selected' : '')
                          // Step 12.5e — every member of the dragged BLOCK gets
                          // the fading cue (a lone drag = just that row).
                          + (dragBlockIds && dragBlockIds.includes(p.id) ? ' page-list-item--dragging' : '')
                          // Step 11.5c — the WHITE edges facing the drop GAP:
                          // the row's TOP edge when the gap is before it
                          // (gridDropSlot === i), its BOTTOM edge when the gap
                          // is after it (gridDropSlot === i + 1). A middle gap
                          // lights this row's bottom + the next row's top.
                          + (gridDropSlot === i ? ' page-list-item--drop-edge-top' : '')
                          + (gridDropSlot === i + 1 ? ' page-list-item--drop-edge-bottom' : '')
                          // B18 round 3, pt 5 — the CAPTION-drag cue (red =
                          // a caption lands here; the white edges = a page
                          // lands there): the half edge, the merge ring, or
                          // the gap edges.
                          + (capDrop && capDrop.pageId === p.id && capDrop.pos === 'top' ? ' page-list-item--cap-edge-top' : '')
                          + (capDrop && capDrop.pageId === p.id && capDrop.pos === 'bottom' ? ' page-list-item--cap-edge-bottom' : '')
                          + (capDrop && capDrop.pageId === p.id && capDrop.merge ? ' page-list-item--cap-merge' : '')
                          + (capDrop && capDrop.slot === i ? ' page-list-item--cap-edge-top' : '')
                          + (capDrop && capDrop.slot === i + 1 ? ' page-list-item--cap-edge-bottom' : '')
                        }
                        title={`${fileNameOf(p.file_path)} — click to activate · Ctrl+click to multi-select · arrows to move · Shift+arrow to extend · Shift+click to range-select · drag to reorder`}
                        draggable
                        onDragStart={e => onRowDragStart(e, p)}
                        onDragEnd={clearDrag}
                        onClick={e => onListRowClick(e, p.id)}
                      >
                        <span className="page-list-num">Page {p.page_number}</span>
                        <span className="page-list-name">{p.file_path ? fileNameOf(p.file_path) : 'Caption page'}</span>
                        {/* Step 12.5a — hover bin at the row's right edge
                            (consistency across zoom regimes); surgical:
                            deletes THIS page, never the active one. */}
                        <PageBin
                          title={`Delete page ${p.page_number} (${fileNameOf(p.file_path)})`}
                          disabled={deleting}
                          onClick={e => { e.stopPropagation(); deletePage(p.id) }}
                        />
                      </li>
                    )
                  }
                  // grid + fill — the Step-9 tile (square 1:1, image
                  // object-fit contain, "Page N" corner label, active
                  // highlight + click-to-activate, Step-3 reorder DnD;
                  // fill regime = one full-width tile via the CSS class).
                  return (
                    <li
                      key={p.id}
                      data-page-id={p.id}
                      className={
                        'page-tile'
                        + (isActive ? ' page-tile--active' : '')
                        + (isSelected ? ' page-tile--selected' : '')
                        // Step 12.5e — every member of the dragged BLOCK gets the
                        // fading cue (a lone drag = just that tile, as before).
                        + (dragBlockIds && dragBlockIds.includes(p.id) ? ' page-tile--dragging' : '')
                        // Step 11.5c — the WHITE edges facing the drop GAP:
                        // the tile's LEFT edge when the gap is before it
                        // (gridDropSlot === i), its RIGHT edge when the gap is
                        // after it (gridDropSlot === i + 1). A middle gap lights
                        // two tiles' facing edges — which may sit on DIFFERENT
                        // rows in a wrapped grid (it marks the page-order gap).
                        + (gridDropSlot === i ? ' page-tile--drop-edge-left' : '')
                        + (gridDropSlot === i + 1 ? ' page-tile--drop-edge-right' : '')
                        // B18 round 3, pt 5 — the CAPTION-drag cue (red = a
                        // caption lands here; the white edges = a page lands
                        // there): the half edge, the merge ring, or the gap
                        // edges (left/right in the tile grid).
                        + (capDrop && capDrop.pageId === p.id && capDrop.pos === 'top' ? ' page-tile--cap-edge-top' : '')
                        + (capDrop && capDrop.pageId === p.id && capDrop.pos === 'bottom' ? ' page-tile--cap-edge-bottom' : '')
                        + (capDrop && capDrop.pageId === p.id && capDrop.merge ? ' page-tile--cap-merge' : '')
                        + (capDrop && capDrop.slot === i ? ' page-tile--cap-edge-left' : '')
                        + (capDrop && capDrop.slot === i + 1 ? ' page-tile--cap-edge-right' : '')
                      }
                      draggable
                      title={`${fileNameOf(p.file_path)} — click to activate · Ctrl+click to multi-select · arrows to move (grid) · Shift+arrow to extend · drag to reorder · drag a selected page to move the whole selection`}
                      onClick={e => onListRowClick(e, p.id)}
                      onDragStart={e => onRowDragStart(e, p)}
                      onDragEnd={clearDrag}
                      onDrop={e => onRowDrop(e)}
                    >
                      {p.file_path
                        ? <img src={p.file_path} alt={`Page ${p.page_number}`} draggable={false} />
                        : (
                          /* B18 round 2, substep 2 — the caption tile carries
                             the comic's theme colour (inline, so it can't be
                             overridden) + a bit of the caption text. */
                          <div
                            className="page-tile-caption"
                            aria-hidden="true"
                            style={selectedComic && selectedComic.theme_colour
                              ? { background: selectedComic.theme_colour, color: legibleTextOn(selectedComic.theme_colour) }
                              : undefined}
                          >
                            {p.caption
                              ? <span className="page-tile-caption-text">{p.caption}</span>
                              : 'Caption page'}
                          </div>
                        )}
                      <span className="page-tile-label">Page {p.page_number}</span>
                      {/* Step 12.5a — semi-transparent hover bin, top-right;
                          surgical: deletes THIS page (stopPropagation keeps
                          it from activating the page under the cursor). */}
                      <PageBin
                        title={`Delete page ${p.page_number} (${fileNameOf(p.file_path)})`}
                        disabled={deleting}
                        onClick={e => { e.stopPropagation(); deletePage(p.id) }}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
              </>
            )}
          </div>
        </div>

        {/* RIGHT — the live preview (Step 7): a BOUNDED window that scrolls
            internally (the page doesn't grow), caption ABOVE each image
            (spec), reading order. Two-way sync: a row click activates +
            centres a page; a figure click activates + highlights its row.
            The toggle switches between ALL pages and the ACTIVE page only. */}
        <div className="comic-right">
          <h3 className="preview-heading" style={{ margin: '18px 0 8px' }}>
            Preview
            <button
              type="button"
              className={'preview-toggle' + (previewMode === 'active' ? ' preview-toggle--on' : '')}
              aria-pressed={previewMode === 'active'}
              title="Show only the active page (off = all pages, scrollable)"
              onClick={() => {
                const next = previewMode === 'all' ? 'active' : 'all'
                // Coming back to ALL pages: keep the active page in focus — the
                // post-render effect (deps include previewMode) centres it once
                // every figure is back in the window. Without this flag the
                // window would reopen at the top (page 1).
                if (next === 'all') scrollActiveRef.current = true
                setPreviewMode(next)
              }}
            >
              active page only
            </button>
            {/* 2026-09-27 user tweak — the transient save cues (Saving… /
                Caption saved) live here, next to the toggle, instead of under
                the caption box; 'Caption saved' auto-hides after ~3 s (the
                effect sits with the caption-save state). Only a FAILED save
                stays under the box. */}
            {captionSave === 'saving' ? (
              <span className="caption-status muted" role="status">
                Saving caption…
              </span>
            ) : null}
            {captionSave === 'saved' ? (
              <span className="caption-status muted" role="status">
                Caption saved
              </span>
            ) : null}
            {/* B18 round 6, issue 6a — the Delete pill, moved from the old
                pages heading to the PREVIEW heading's top-right, on the SAME
                line as "active page only". Visible in BOTH modes; deletes the
                whole selection (the active page alone when there is none).
                The Delete key does the same. */}
            <button
              type="button"
              className="pages-delete-btn preview-delete-btn"
              title={deleteCount > 1
                ? `Delete the ${deleteCount} selected pages (the Delete key does the same)`
                : 'Delete the active page (the Delete key does the same)'}
              disabled={selectedPages.length === 0 || deleting}
              onClick={() => deleteSelection()}
            >
              <PageBinIcon />
              {deleteCount > 1 ? `Delete ${deleteCount}` : 'Delete'}
            </button>
          </h3>
          {selectedPages.length === 0 ? (
            /* B18 round 3, pt 15 — the FAKE caption page ON THE PREVIEW
               PLANE (same component as the first-tile one): theme red,
               white italic "Disrupt the narrative…", the '+' centred below.
               Click → a real caption page of the DEFAULT colour at slot 0.
               Vanishes the moment any page exists (this conditional). */
            <div
              className={picking ? 'comic-preview comic-preview--empty comic-preview--picking' : 'comic-preview comic-preview--empty'}
              onClickCapture={picking ? handlePickClick : undefined}
            >
              {picking && (
                <div className="pick-hint" role="status">
                  {pickHint || 'No pages yet — nothing to sample (click a comic image once one exists).'}
                </div>
              )}
              {/* B18 round 4, pt 7 — opening the "Disrupt the narrative" page
                  lands it IMMEDIATELY in the typable state: create it, then
                  arm its 'page' editor (the armed textarea autofocuses).
                  B18 round 6b — while picking, the capture-phase handler
                  intercepts this click (a pick must never create a page). */}
              <FakeCaptionPage onAdd={async () => { guardPreviewEdit(async () => { const created = await insertCaptionPageAt(0); if (created) setCaptionEditId(`${created.id}:page`) }) }} />
            </div>
          ) : (
            <div
              className={picking ? 'comic-preview comic-preview--picking' : 'comic-preview'}
              ref={previewRef}
              onDragOver={onPreviewDragOver}
              onDragLeave={onPreviewDragLeave}
              onDrop={onPreviewDrop}
              // B18 round 6b — in-page eyedropper: while picking, the
              // capture-phase handler resolves every click in this scroller
              // (and its stopPropagation blocks caption arming / page delete /
              // any other child handler for that click).
              onClickCapture={picking ? handlePickClick : undefined}
            >
              {picking && (
                <div className="pick-hint" role="status">
                  {pickHint || 'Click a comic image to sample its colour — Esc cancels.'}
                </div>
              )}
              {visiblePages.map((p, i) => {
                const isActive = activePageId === p.id
                // Step 12.5b — multi-select outline on the selected (non-active)
                // figures; the active one keeps the full --active treatment.
                const isSelected = !isActive && selectedIds.includes(p.id)
                // Step 9.5 bar + Step 12.5e — never shown at a no-op slot:
                // the SAME plan the drop uses is null there (the group's own
                // span, a page already in place, or the tail when the block
                // already sits last — the old per-figure check missed that
                // last case and showed a phantom bar).
                // Step 14 — file drags have no no-op (the new page is always
                // added), so the bar always shows at a valid slot.
                const planAt = (slot) => {
                  if (slot < 0 || slot > visiblePages.length) return null
                  if (draggingId !== null) {
                    return planBlockDrop(draggingId, slot < visiblePages.length ? visiblePages[slot].id : null)
                  }
                  return true   // file drag: always a valid insertion point
                }
                const showBefore = previewDropIdx === i && !!planAt(i)
                const showAfter = previewDropIdx === i + 1 && !!planAt(i + 1)
                // B18 round 5 — the hover label's number: the FROZEN media
                // number in text mode (so the owner sees which [media x] a page
                // is), else the plain page number (the general hover label).
                const mediaNum = textMode ? mediaNumberFor(p.id) : null
                // B18 round 4, pt 1 — while THIS page's caption editor is
                // armed (captionEditId = `${p.id}:top|bottom|page`), the
                // figure must NOT be a native drag source: the browser would
                // start the page-reorder drag on mousedown over the caption
                // text and the caret could never be placed (the owner: "i
                // still can't click and place a cursor on the text of a
                // caption page"). The caption editors' onMouseDown
                // stopPropagation is the second half of the fix.
                return (
                  <figure
                    key={p.id}
                    data-page-id={p.id}
                    className={
                      'preview-figure'
                      + (isActive ? ' preview-figure--active' : '')
                      + (isSelected ? ' preview-figure--selected' : '')
                      + (showBefore ? ' preview-figure--drop-before' : '')
                      + (showAfter ? ' preview-figure--drop-after' : '')
                      + (!p.file_path ? ' preview-figure--caption' : '')
                      // B18 round 3, pt 5 — the CAPTION-drag cue (red = a
                      // caption lands here; white = a page lands there): the
                      // half edge (top/bottom caption), the merge ring
                      // (onto a caption page), or the gap edges (a caption
                      // page lands between figures).
                      + (capDrop && capDrop.pageId === p.id && capDrop.pos === 'top' ? ' preview-figure--cap-top' : '')
                      + (capDrop && capDrop.pageId === p.id && capDrop.pos === 'bottom' ? ' preview-figure--cap-bottom' : '')
                      + (capDrop && capDrop.pageId === p.id && capDrop.merge ? ' preview-figure--cap-merge' : '')
                      + (capDrop && capDrop.slotVisible === i ? ' preview-figure--cap-before' : '')
                      + (capDrop && capDrop.slotVisible === i + 1 ? ' preview-figure--cap-after' : '')
                    }
                    title="Click to make this the active page · Ctrl+click to multi-select · Up/Down = the adjacent page · Shift+Up/Down to extend · drag to reorder · drag a selected page to move the whole selection"
                    onClick={e => onListRowClick(e, p.id, 'preview')}
                    draggable={!(captionEditId !== null && captionEditId.startsWith(p.id + ':'))}
                    onDragStart={e => onRowDragStart(e, p)}
                    onDragEnd={clearDrag}
                  >
                    {/* B18 round 5 — the HOVER number (bottom-left of the
                        page): the page number in general; the FROZEN media
                        number instead while in text mode (owner: "this will
                        help during editing"). */}
                    <span className={
                      'preview-hovernum'
                      + (mediaNum !== null ? ' preview-hovernum--media' : '')
                    }>
                      {mediaNum !== null ? `Media ${mediaNum}` : `Page ${p.page_number}`}
                    </span>
                    {/* B18 — the caption POSITION model: 'top' (default) |
                        'bottom' | 'page' (a caption-only page, no image).
                        B18 round 2 — the interaction model (spec:
                        editor-overhaul.md §1): NO default caption box — the
                        bar exists only where the owner put one (clicking a
                        bar arms the inline input; the top/bottom '+' on a
                        captionless page creates the bar there). The four '+'
                        surround the IMAGE, on hover, for ANY page: on a page
                        that HAS a caption (or a caption page) all four INSERT
                        an adjacent caption page (top/left → before,
                        bottom/right → after — including above page 1 / below
                        the last page); a hover bin (top-right) deletes the
                        caption (or the caption page itself). The caption node
                        + the image node are emitted in the order the position
                        demands. */}
                    {(() => {
                      const isCaptionPage = !p.file_path
                      // B18 round 4 — dual slots: a media page may hold a TOP
                      // and a BOTTOM caption AT THE SAME TIME (the owner: "not
                      // either or … at the same time"). Each slot is its own
                      // editor: armed key `${p.id}:${slot}`, text in slotOf(slot)
                      // (caption_top / caption_bottom). A caption page is the
                      // 'page' slot (the legacy `caption` column).
                      const theme = selectedComic && selectedComic.theme_colour
                      const capStyle = theme ? { background: theme, color: legibleTextOn(theme) } : undefined
                      const editingTop = captionEditId === `${p.id}:top`
                      const editingBottom = captionEditId === `${p.id}:bottom`
                      const editingPage = captionEditId === `${p.id}:page`
                      const topFilled = !isCaptionPage && !!(p.caption_top && String(p.caption_top).trim())
                      const bottomFilled = !isCaptionPage && !!(p.caption_bottom && String(p.caption_bottom).trim())
                      const plusDisabled = deleting || reordering

                      const stop = (fn) => (e) => { e.stopPropagation(); fn() }
                      // Disarm on blur — EXCEPT when focus is moving to another
                      // control INSIDE the same widget (e.g. the Merge button or
                      // the bin). A real mousedown on such a control blurs the
                      // input first; if that blur disarmed the widget, React would
                      // unmount the button before mouseup/click and the click would
                      // never land (the merge would silently no-op). Containing the
                      // disarm to "focus left the widget" keeps the control mounted
                      // for its own click while still disarming on a genuine click-away.
                      const disarmUnlessInside = (e) => {
                        const related = e.relatedTarget
                        if (related && related.nodeType === 1) {
                          const host = e.currentTarget.closest('.caption-page-box, .cap-bar')
                          if (host && host.contains(related)) return
                        }
                        if (captionSave !== 'error') setCaptionEditId(null)
                      }
                      const plus = (side, title, onClick) => (
                        <button
                          type="button"
                          className={'cap-plus cap-plus--' + side}
                          title={title}
                          aria-label={title}
                          disabled={plusDisabled}
                          onClick={onClick}
                        >
                          +
                        </button>
                      )
                      // The four '+' behaviours — B18 round 4, per SLOT (the
                      // owner: "the + should act on its OWN slot"):
                      //   • top/bottom '+' act on THEIR OWN slot — an EMPTY
                      //     slot arms the bar there; a FILLED slot inserts a
                      //     caption page above (top) / below (bottom).
                      //   • left/right '+' insert a caption page before/after
                      //     (unchanged from round 2).
                      //   • a caption page → ALL FOUR insert (unchanged).
                      const insertAt = (side) => () => insertCaptionPage(side === 'top' || side === 'left' ? 'before' : 'after', p.id)
                      const armBar = (side) => () => setCaptionEditId(`${p.id}:${side}`)
                      const plusHandlers = {
                        top: (isCaptionPage || topFilled) ? insertAt('top') : armBar('top'),
                        bottom: (isCaptionPage || bottomFilled) ? insertAt('bottom') : armBar('bottom'),
                        left: insertAt('left'),
                        right: insertAt('right'),
                      }
                      const plusTitles = {
                        top: (isCaptionPage || topFilled) ? 'Insert a caption page above this page' : 'Add a caption above the image',
                        bottom: (isCaptionPage || bottomFilled) ? 'Insert a caption page below this page' : 'Add a caption below the image',
                        left: 'Insert a caption page before this page',
                        right: 'Insert a caption page after this page',
                      }
                      const plusButtons = (
                        <>
                          {plus('top', plusTitles.top, stop(plusHandlers.top))}
                          {plus('bottom', plusTitles.bottom, stop(plusHandlers.bottom))}
                          {plus('left', plusTitles.left, stop(plusHandlers.left))}
                          {plus('right', plusTitles.right, stop(plusHandlers.right))}
                        </>
                      )

                      // B18 round 4 — the per-slot bar nodes. A bar is either
                      // ARMED (its own textarea — at most ONE editor across
                      // the editor is armed: captionEditId) or READ-ONLY
                      // (draggable, click to arm, bin deletes that slot). The
                      // slot decides everything: the text field (slotOf()),
                      // the armed key, the drag payload, the bin's target.
                      // B18 round 6, pt 3 — the bar carries its OWN slot: a drop ON
                      // the bar targets that slot, ordered by the bar's own top/bottom
                      // half (resolveCaptionTarget reads data-cap-slot — the comment
                      // lives OUTSIDE the JSX tag; comments are illegal between
                      // attributes, so this one sits with the round-4 note above).
                      const readBar = (slot, text) => (
                        <div
                          className={
                            'cap-bar cap-bar--bar'
                            + (capDragPageId === p.id && capDragRef.current && capDragRef.current.slot === slot
                              ? ' caption-node--dragging' : '')
                          }
                          style={capStyle}
                          title={`Click to edit the ${slot} caption · drag it to a page half, onto a caption page (merge), or to a gap (it becomes a caption page)`}
                          draggable
                          data-caption-drag="bar"
                          data-cap-slot={slot}
                          onDragStart={e => startCaptionDrag(e, 'bar', p, slot)}
                          onDragEnd={endCaptionDrag}
                          onClick={e => { e.stopPropagation(); setCaptionEditId(`${p.id}:${slot}`) }}
                        >
                          <PageBin
                            title={`Delete the ${slot} caption on page ${p.page_number}`}
                            disabled={deleting}
                            onClick={e => { e.stopPropagation(); deleteCaption(p.id, slot) }}
                          />
                          <span className="page-caption">{text}</span>
                        </div>
                      )

                      const armedBar = (slot, text) => (
                        <div className="cap-bar" data-cap-slot={slot} style={capStyle}>
                          <PageBin
                            title={`Delete the ${slot} caption on page ${p.page_number}`}
                            disabled={deleting}
                            onClick={e => { e.stopPropagation(); deleteCaption(p.id, slot) }}
                          />
                          {/* B18 round 3, pt 12 — the bar's editor is a
                              TEXTAREA (multi-line; Ctrl/⌘+Enter newline,
                              Enter commits + closes). B18 round 4, pt 1 —
                              onMouseDown stops the event BEFORE it reaches
                              the figure: the figure is a native drag source
                              (page reorder) and its click would
                              activate+scroll — either one would steal the
                              caret (the owner: "i still can't click and
                              place a cursor on the text of a caption page").
                              (The figure's own `draggable` is also disabled
                              while this page's caption editor is armed.) */}
                          <textarea
                            className="caption-input"
                            style={capStyle}
                            rows={1}
                            autoFocus
                            value={text ?? ''}
                            placeholder="Caption…"
                            aria-label={`${slot} caption for page ${p.page_number}`}
                            onMouseDown={e => e.stopPropagation()}
                            onChange={e => onCaptionChange(p, slot, e.target.value)}
                            onKeyDown={e => onCaptionKeyDown(e, p, slot)}
                            onClick={e => e.stopPropagation()}
                            onBlur={disarmUnlessInside}
                          />
                          {captionSave === 'error' ? <span className="caption-status error">{captionError}</span> : null}
                        </div>
                      )

                      let topNode = null
                      let bottomNode = null
                      let captionNode = null
                      if (isCaptionPage) {
                        captionNode = (
                          <div className="caption-page-box">
                            <PageBin
                              title={`Delete caption page ${p.page_number}`}
                              disabled={deleting}
                              onClick={e => { e.stopPropagation(); deletePage(p.id) }}
                            />
                            {editingPage ? (
                              <>
                                <div className="caption-page-frame">
                                  <textarea
                                    className="caption-page-input"
                                    // B18 round 7 — the paste split reads this to
                                    // know WHICH caption page is being edited.
                                    data-page-id={p.id}
                                    style={capStyle}
                                    autoFocus
                                    value={p.caption ?? ''}
                                    placeholder="Caption page…"
                                    aria-label={`Caption page ${p.page_number}`}
                                    // B18 round 4, pt 1 — the caret fix:
                                    // mousedown must not reach the figure
                                    // (native drag + activate+scroll would
                                    // steal the caret).
                                    onMouseDown={e => e.stopPropagation()}
                                    onChange={e => onCaptionChange(p, 'page', e.target.value)}
                                    // B18 round 3, pt 12 — Enter COMMITS +
                                    // closes the caption; Ctrl/⌘+Enter = a
                                    // line break (the old Enter-newline was
                                    // the multi-line story the owner cut).
                                    onKeyDown={e => onCaptionKeyDown(e, p, 'page')}
                                    // B18 round 3, pt 8 — a click in the TEXT
                                    // goes to the caret, not to the figure's
                                    // activate+scroll (onListRowClick would
                                    // centre the page and fight the caret).
                                    // The textarea fills the frame, so every
                                    // in-frame click lands here.
                                    onClick={e => e.stopPropagation()}
                                    onBlur={disarmUnlessInside}
                                  />
                                </div>
                                <div className="caption-page-actions">
                                  <button
                                    type="button"
                                    className="cap-merge"
                                    // B18 round 3, pts 4/5 — merge now folds
                                    // into the nearest CAPTION PAGE (never an
                                    // image page — the owner), source text on
                                    // top, one line break between; disabled
                                    // when there is no caption-page neighbour.
                                    title="Merge this caption into the nearest caption page (this text on top)"
                                    aria-label="Merge this caption into the nearest caption page"
                                    disabled={deleting || !hasCaptionPageNeighbor(selectedPages, p.id)}
                                    onClick={e => { e.stopPropagation(); mergeCaptionPage(p.id) }}
                                  >
                                    Merge
                                  </button>
                                  {captionSave === 'error' ? <span className="caption-status error">{captionError}</span> : null}
                                </div>
                              </>
                            ) : (
                              // B18 round 3, pt 5 — the read-only caption page
                              // is DRAGGABLE (its own drag — pt 2: never the
                              // whole page; the [data-caption-drag] guard +
                              // stopPropagation keep the figure out). Drop
                              // targets: a page half, a caption page (merge),
                              // a gap (move). The fading cue marks the source.
                              <div
                                className={
                                  'caption-page-frame caption-page-frame--bar'
                                  + (capDragPageId === p.id && capDragRef.current && capDragRef.current.slot === 'page'
                                    ? ' caption-node--dragging' : '')
                                }
                                style={capStyle}
                                title="Click to edit the caption page · drag it to a page half, onto a caption page (merge), or to a gap (move)"
                                draggable
                                data-caption-drag="page"
                                onDragStart={e => startCaptionDrag(e, 'page', p, 'page')}
                                onDragEnd={endCaptionDrag}
                                onClick={e => { e.stopPropagation(); setCaptionEditId(`${p.id}:page`) }}
                              >
                                <span className="caption-page-caption">{p.caption || 'Caption page'}</span>
                              </div>
                            )}
                          </div>
                        )
                      } else {
                        // B18 round 4 — dual slots: the top bar (if any) is
                        // emitted above the image, the bottom bar (if any)
                        // below — BOTH at the same time when both are filled.
                        topNode = editingTop
                          ? armedBar('top', p.caption_top)
                          : (topFilled ? readBar('top', p.caption_top) : null)
                        bottomNode = editingBottom
                          ? armedBar('bottom', p.caption_bottom)
                          : (bottomFilled ? readBar('bottom', p.caption_bottom) : null)
                      }

                      // The image wrapper (image pages only — a 'page' row has
                      // no image). The four '+' live INSIDE it: around the
                      // image, not the caption bar (substep 3).
                      const imgNode = isCaptionPage ? null : (
                        <div className="preview-imgwrap">
                          <PageBin
                            title={`Delete page ${p.page_number} (${fileNameOf(p.file_path)})`}
                            disabled={deleting}
                            onClick={e => { e.stopPropagation(); deletePage(p.id) }}
                          />
                          <img className="preview-thumb" src={p.file_path} alt={`Page ${p.page_number}`} draggable={false} />
                          {plusButtons}
                        </div>
                      )

                      return (
                        <>
                          {isCaptionPage ? plusButtons : null}

                          {/* B18 round 4 — dual slots: top bar above the
                              image, bottom bar below (both at once when both
                              are filled); a caption page is the node alone
                              (no image). */}
                          {isCaptionPage
                            ? <>{captionNode}</>
                            : <>{topNode}{imgNode}{bottomNode}</>}
                        </>
                      )
                    })()}
                  </figure>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* B18 round 5 — the UPDATE / DISCARD modal: a preview reorder that
          conflicts with un-updated text (while in text mode). Update = the
          markdown wins (the pending edit is dropped); Discard = the comic's
          state stands (the pending edit runs + the markdown regenerates).
          Also used for toggle-off with unsaved changes (no pending edit —
          Update applies + exits; Discard discards + exits). */}
      {showTextModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Unsaved text mode edits">
          <div className="modal-card">
            <h3>Unsaved text mode edits</h3>
            <p className="modal-text">
              There are unsaved text mode edits.
              Update = apply the text to the comic (the text wins).
              Discard = keep the comic's state (the text's changes are discarded).
            </p>
            <div className="modal-actions">
              <button className="btn--primary" onClick={modalUpdate}>Update</button>
              <button className="btn--danger" onClick={modalDiscard}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {/* B18 round 5 — the GUARD prompt: a tiles-mode edit attempted while
          unsaved text-mode edits (the shared draft) exist. Review → text mode;
          Discard → clear the draft + proceed with the edit. */}
      {showGuard && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Unsaved text mode changes">
          <div className="modal-card">
            <h3>Unsaved text mode changes</h3>
            <p className="modal-text">
              There are unsaved text mode changes. Review in text mode or
              discard them?
            </p>
            <div className="modal-actions">
              <button className="btn--primary" onClick={guardReview}>Review in text mode</button>
              <button className="btn--danger" onClick={guardDiscard}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {/* B18 round 6, issue 8 — the REUSABLE styled confirm modal (the house
          replacement for the native window.confirm in this editor). Rendered
          from the single `confirmReq` state; the destructive action is the red
          `.btn--danger` (or accent `.btn--primary` for non-destructive tones)
          and "Cancel" is the neutral `.btn--neutral`. */}
      {confirmReq && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={confirmReq.title}>
          <div className="modal-card">
            <h3>{confirmReq.title}</h3>
            <p className="modal-text">{confirmReq.message}</p>
            <div className="modal-actions">
              <button
                className={confirmReq.tone === 'danger' ? 'btn--danger' : 'btn--primary'}
                onClick={() => { const f = confirmReq.onConfirm; setConfirmReq(null); if (f) f() }}
              >
                {confirmReq.confirmLabel || 'Confirm'}
              </button>
              <button
                className="btn--neutral"
                onClick={() => { const f = confirmReq.onCancel; setConfirmReq(null); if (f) f() }}
              >
                {confirmReq.cancelLabel || 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ResizableSection>
  )
}
