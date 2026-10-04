import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ResizableSection from './ResizableSection.jsx'

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
      await addFiles(files)
    } catch (err) {
      setNotice(null)
      setError('Couldn’t read the clipboard (permission denied or empty) — drag the images in, or double-click the dropzone to pick files.')
    }
  }, [selectedId, addFiles])

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
  // focus is. Text pastes (e.g. into a caption input) are left alone: we only
  // act when the paste actually carries an image file, otherwise we return
  // without preventDefault so the default paste proceeds.
  const onPasteEvent = useCallback((e) => {
    if (selectedId === null) return
    if (uploadingRef.current) return
    const items = (e.clipboardData && e.clipboardData.items)
      ? Array.from(e.clipboardData.items)
      : []
    const files = []
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      if (it.kind !== 'file') continue
      const f = (typeof it.getAsFile === 'function') ? it.getAsFile() : null
      if (f && (f.type || '').startsWith('image/')) files.push(f)
    }
    if (files.length === 0) return   // not an image paste → let it through (caption text, etc.)
    e.preventDefault()
    addFiles(files)
  }, [selectedId, addFiles])

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
    if (files.length) addFiles(files)
  }, [addFiles])

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
    } catch (err) {
      setPages(prevPages)                       // roll the optimistic order back
      setError(err.message)
    } finally {
      reorderingRef.current = false
      setReordering(false)
    }
  }, [selectedId, selectedPages, pages, csrfToken])

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
    // Upload first (appends at the end — the round-1 pipeline, unchanged).
    const newPages = await addFiles(files)
    if (newPages.length === 0) return
    // If there is no specific index, the end-append above is the final result.
    if (insertIndex === null) return
    // Splice the new pages at insertIndex and persist the new order.
    // `selectedPages` here is the STALE closure value (length N, before
    // addFiles) — exactly the list the slot was resolved against.
    const newOrder = [
      ...selectedPages.slice(0, insertIndex),
      ...newPages,
      ...selectedPages.slice(insertIndex),
    ]
    reorder(newOrder)
  }, [gridDropSlot, previewDropIdx, selectedPages, visiblePagesRef, addFiles, reorder])

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
    reorder(plan.next)
    commitDragActive(draggedId)                  // the dragged page becomes active
  }, [clearDrag, reorder, planBlockDrop, commitDragActive, gapFromEvent])

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
    reorder(plan.next)
    commitDragActive(draggedId)
  }, [clearDrag, reorder, planBlockDrop, commitDragActive, gapFromEvent, resolveCaptionTarget, endCaptionDrag])

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
    reorder(plan.next)
    commitDragActive(draggedId)
  }, [previewDropIdx, clearDrag, reorder, planBlockDrop, commitDragActive, resolveCaptionTarget, endCaptionDrag])

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
      return true
    } catch (err) {
      setCaptionSave('error')
      setCaptionError(err.message)
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
    if (timers[key]) { clearTimeout(timers[key]); delete timers[key] }
    timers[key] = setTimeout(() => {
      delete timers[key]
      saveCaption(page.id, slot, value)
    }, 600)
  }, [saveCaption, captionSave])

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
    saveCaption(page.id, slot, page[slotOf(slot)] ?? '')
  }, [saveCaption])

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
      const ok = window.confirm(`Delete page ${page.page_number} (${fileNameOf(page.file_path)})?\nThe remaining pages renumber — this cannot be undone.`)
      if (!ok) return false
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
      return true
    } catch (err) {
      setPages(prevPages)
      setError(err.message)
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
  const deleteCaption = useCallback(async (pageId, slot) => {
    const page = selectedPages.find(x => x.id === pageId)
    if (!page) return false
    const ok = window.confirm(
      `Delete the caption on page ${page.page_number}?\nThis cannot be undone.`,
    )
    if (!ok) return false
    const field = slotOf(slot)
    const key = `${pageId}:${slot}`
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
        return
      }
      // saveCaption PATCHes the server; mirror the merged text locally so
      // the target's box shows it before the splice below.
      setPages(prev => prev.map(p2 => (p2.id === target.id ? { ...p2, caption: merged } : p2)))
    }
    // The source page is deleted (the house confirm still applies — page
    // deletes always ask). If the owner cancels it, the merge stands (the
    // destination has the text) and the source stays too — say so, so the
    // duplicate is understood, not "stuck".
    if (captionEditId === `${pageId}:page`) setCaptionEditId(null)
    const deleted = await deletePage(pageId)       // the server renumbers 1..N
    if (!deleted && changed) {
      setError(`The caption was merged into page ${target.page_number} — the caption page was kept (its delete was cancelled). Delete it from its bin if you want it gone.`)
    }
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
      } catch (err) {
        setError(err.message)   // the optimistic value stays (retry/clear to fix)
      }
    }, 400)
  }, [selectedId, csrfToken, setComics, setError, themeTimer])

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
  const deletePages = useCallback(async (ids) => {
    if (deleting) return
    if (!Array.isArray(ids) || ids.length === 0) return
    // Resolve to the current comic's pages (reading order); ignore ids that
    // aren't pages of this comic (a stale selection from another comic).
    const targets = selectedPages.filter(p => ids.includes(p.id))
    if (targets.length === 0) return
    const numbers = targets.map(p => p.page_number)
    const ok = window.confirm(
      `Delete ${targets.length} page${targets.length === 1 ? '' : 's'} (pages ${numbers.join(', ')})?`
      + '\nThe remaining pages renumber — this cannot be undone.',
    )
    if (!ok) return
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
    } catch (err) {
      setPages(prevPages)                      // roll the whole batch back
      setError(err.message)
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
    deletePages(ids)
  }, [selectedIds, activePageId, deletePages])

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
          <select
            id="comic-select"
            value={selectedId ?? ''}
            onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : null)}
          >
            {comics.length === 0 && <option value="">(no comics yet — create one below)</option>}
            {comics.map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
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
                  screen-pick is GONE: where the browser lacks the EyeDropper
                  API the button opens the NATIVE <input type="color">
                  picker (the hidden input above, showPicker()) — no screen
                  capture, no permission prompt. Cancelling either picker
                  (a throw, or a dismissed dialog) is swallowed. */}
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
                  : 'Open the colour picker (this browser lacks the EyeDropper API)'}
                onClick={() => {
                  if ('EyeDropper' in window) {
                    new window.EyeDropper().open()
                      .then(res => { if (res && res.sRGBHex) setThemeColour(res.sRGBHex) })
                      .catch(() => {})             // the user cancelled the picker
                    return
                  }
                  // No EyeDropper API — the native colour picker (the hidden
                  // <input type="color">): no screen capture, no prompt.
                  const el = themeDropperRef.current
                  if (!el) return
                  try { el.showPicker() } catch { el.click() }
                }}
              >
                Eyedropper
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
            {/* Step 12.5a — the heading row is flex; the always-visible
                "Delete" pill sits right-aligned (the h3 spans the section
                width, so its right edge IS the tiles' right margin) and
                deletes the ACTIVE page. The Delete key does the same. */}
            <h3 className="pages-heading">
              Pages
              {selectedComic ? <span> — {selectedComic.title}</span> : null}
              <span className="muted" style={{ fontWeight: 400 }}> ({selectedPages.length})</span>
              {reordering ? <span className="muted" style={{ fontWeight: 400 }}> — reordering…</span> : null}
              {/* Step 12.5b — deletes the WHOLE selection (the active page
                  alone when there is none); the label carries the count. */}
              <button
                type="button"
                className="pages-delete-btn"
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
                  <FakeCaptionPage onAdd={async () => { const created = await insertCaptionPageAt(0); if (created) setCaptionEditId(`${created.id}:page`) }} />
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
                        ? <img src={p.file_path} alt={`Page ${p.page_number}`} />
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
          </h3>
          {selectedPages.length === 0 ? (
            /* B18 round 3, pt 15 — the FAKE caption page ON THE PREVIEW
               PLANE (same component as the first-tile one): theme red,
               white italic "Disrupt the narrative…", the '+' centred below.
               Click → a real caption page of the DEFAULT colour at slot 0.
               Vanishes the moment any page exists (this conditional). */
            <div className="comic-preview comic-preview--empty">
              {/* B18 round 4, pt 7 — opening the "Disrupt the narrative" page
                  lands it IMMEDIATELY in the typable state: create it, then
                  arm its 'page' editor (the armed textarea autofocuses). */}
              <FakeCaptionPage onAdd={async () => { const created = await insertCaptionPageAt(0); if (created) setCaptionEditId(`${created.id}:page`) }} />
            </div>
          ) : (
            <div
              className="comic-preview"
              ref={previewRef}
              onDragOver={onPreviewDragOver}
              onDragLeave={onPreviewDragLeave}
              onDrop={onPreviewDrop}
            >
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
                          <img className="preview-thumb" src={p.file_path} alt={`Page ${p.page_number}`} />
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
    </ResizableSection>
  )
}
