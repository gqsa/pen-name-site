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

export default function ComicEditor({
  csrfToken,
  topDelta = 0,
  onTopDeltaChange = null,
}) {
  // comics: array (null until the first fetch lands) — the full comic list.
  // pages : array — ALL comics' pages from the same fetch (keyed `pages`).
  // selectedId: the id of the comic being edited (a number, matching the DB id).
  const [comics, setComics] = useState(null)
  const [pages, setPages] = useState([])
  const [selectedId, setSelectedId] = useState(null)
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
  // Step 11.5b — the TILE WINDOW's landing slot: the 0-based index (into the
  // comic's CURRENT page list — the cell the dragged page will OCCUPY after
  // the drop) where a drop over the grid would land, or null when no grid
  // dragover is in progress / the drop would be a no-op. Drives the red slot
  // marker on that one cell. The marker and every drop handler share ONE
  // plan (planBlockDrop — the dragged page, or its whole selection block per
  // Step 12.5e), so the drop lands where the marker was — the grid's answer
  // to the preview's before/after bar.
  const [gridDropSlot, setGridDropSlot] = useState(null)

  // Step 4 — caption auto-save state.
  const captionTimers = useRef({})                       // page id → pending debounce timeout (per page, so one page's timer can't clobber another's)
  const [captionSave, setCaptionSave] = useState(null)   // null | 'saving' | 'saved' | 'error'
  const [captionError, setCaptionError] = useState(null) // the message behind an 'error' status

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
      // Default selection = the first comic, or null if there are none. A reload
      // keeps a selection the owner already made (prev !== null).
      setSelectedId(prev => (prev !== null ? prev : (list.length ? list[0].id : null)))
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

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
      return
    }
    if (uploadingRef.current) {
      setNotice(null)
      setError('An upload is already in progress — wait for it to finish.')
      return
    }
    const list = Array.from(files).filter(f => f && (f.type || '').startsWith('image/'))
    if (list.length === 0) {
      setNotice(null)
      setError('No image files in that batch — only image files are added as pages.')
      return
    }
    uploadingRef.current = true
    setUploading(true)
    setError(null)
    setNotice(null)
    // Base number from the comic's CURRENT local pages; then increment per
    // success (never reuse a number → a 409 would stop the batch anyway).
    let nextNumber = selectedPages.reduce((m, p) => Math.max(m, Number(p.page_number) || 0), 0) + 1
    let inserted = 0
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

  // Drag/drop: preventDefault on dragover is REQUIRED for the drop to be allowed.
  const onZoneDragOver = useCallback((e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }, [])

  const onZoneDragLeave = useCallback((e) => {
    // dragleave fires when the pointer moves onto a child — ignore that.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setDragActive(false)
  }, [])

  const onZoneDrop = useCallback((e) => {
    e.preventDefault()
    setDragActive(false)
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (files.length) addFiles(files)
  }, [addFiles])

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
  }, [])

  const onRowDragStart = useCallback((e, page) => {
    if (reorderingRef.current) { e.preventDefault(); return }
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
  // (h < d → h, h > d → h − 1, the no-op suppressions, gap → last) — guarded
  // by scratch/test-step-12.5e-group.mjs (476-case equivalence + group
  // invariants over every subset/handle/target). The 2026-09-28 inversion
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

  // Step 11.5b — the TILE WINDOW's landing-slot marker (the Step-9.5 concept,
  // ported to the 2D grid). ONE handler on the grid <ul> (the old per-tile +
  // per-list pair fought over the same dragover — React ran both, list-level
  // last, so the list's null always clobbered the tile's id and the ring
  // never showed): the hovered tile is resolved from the event TARGET (a
  // child of the tile — img / label / bin — or the ul itself = the gap), and
  // the plan gives the cell the handle will occupy — the drop lands exactly
  // there (the marker and the drops share planBlockDrop).
  const resolveGridSlot = useCallback((hoverPageId) => {
    const draggedId = dragIdRef.current
    if (draggedId == null) return null
    const plan = planBlockDrop(draggedId, hoverPageId)
    return plan ? plan.handleLanding : null
  }, [planBlockDrop])
  const onGridDragOver = useCallback((e) => {
    if (dragIdRef.current === null) return   // not our drag (e.g. a file drag)
    e.preventDefault()                        // REQUIRED for the drop to be allowed
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    // The LIST regime (fully zoomed out) has NO per-row drop — a row drop
    // lands LAST (the rows have no onDrop; the ul's does) — so the slot is
    // always the end there, whichever row is under the pointer. In the
    // grid/fill regimes resolve the hovered tile from the event target
    // (closest() — the target is often a child of the tile, e.g. the img).
    const isList = zoom <= ZOOM_LIST_MAX
    const li = (!isList && e.target && e.target.closest)
      ? e.target.closest('li[data-page-id]')
      : null
    setGridDropSlot(resolveGridSlot(li ? Number(li.dataset.pageId) : null))
  }, [zoom, resolveGridSlot])
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
      if (!e.currentTarget.contains(rt)) setGridDropSlot(null)
      return
    }
    if (e.target === e.currentTarget) setGridDropSlot(null)
  }, [])

  // The ONE place a new order is computed + persisted. `next` must be the
  // comic's COMPLETE page set in the new order (the server 400s a partial list).
  const reorder = useCallback(async (next) => {
    if (selectedId === null) return
    if (reorderingRef.current) return
    const newOrder = next.map(p => p.id)
    const currentOrder = selectedPages.map(p => p.id)
    // No-op guard: same length + same sequence = nothing to persist.
    if (newOrder.length !== currentOrder.length || currentOrder.every((id, i) => id === newOrder[i])) return
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

  const onRowDrop = useCallback((e, page) => {
    e.preventDefault()
    e.stopPropagation()                          // keep the list-level handler out
    const draggedId = dragIdRef.current
    if (draggedId === null || reorderingRef.current) return
    const plan = planBlockDrop(draggedId, page.id)
    clearDrag()
    if (!plan) return                            // self / block member / already there
    reorder(plan.next)
    commitDragActive(draggedId)                  // the dragged page becomes active
  }, [clearDrag, reorder, planBlockDrop, commitDragActive])

  // Drop on the list body / a row gap → the block lands LAST.
  const onListDrop = useCallback((e) => {
    e.preventDefault()
    const draggedId = dragIdRef.current
    if (draggedId === null || reorderingRef.current) return
    const plan = planBlockDrop(draggedId, null)
    clearDrag()
    if (!plan) return                            // the block already sits last
    reorder(plan.next)
    commitDragActive(draggedId)
  }, [clearDrag, reorder, planBlockDrop, commitDragActive])

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
    if (dragIdRef.current === null) return   // not our drag (e.g. a file drag)
    e.preventDefault()                        // REQUIRED for the drop to be allowed
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
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
    setPreviewDropIdx(idx)
  }, [])

  const onPreviewDragLeave = useCallback((e) => {
    // dragleave fires when the pointer moves onto a child — ignore that.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setPreviewDropIdx(null)
  }, [])

  const onPreviewDrop = useCallback((e) => {
    e.preventDefault()
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
  }, [previewDropIdx, clearDrag, reorder, planBlockDrop, commitDragActive])

  // --- Step 4: caption auto-save ------------------------------------------------
  //
  // The input is controlled directly by the page's caption (value =
  // caption ?? ''), so typing updates the local state + the preview
  // immediately. A per-page-id debounce (~600 ms) then fires ONE PATCH per
  // edit burst — no save button by design. Blank maps to null (an explicit
  // null CLEARS the server-side caption; '' would store an empty string).
  // On failure the typed value stays (no rollback) and the status line
  // reports the error.

  const saveCaption = useCallback(async (pageId, value) => {
    const next = value.trim() === '' ? null : value
    setCaptionSave('saving')
    setCaptionError(null)
    try {
      const res = await fetch(`/api/admin/comic-pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ caption: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `save caption answered ${res.status}`)
      }
      setCaptionSave('saved')
    } catch (err) {
      setCaptionSave('error')
      setCaptionError(err.message)
    }
  }, [csrfToken])

  const onCaptionChange = useCallback((page, value) => {
    const next = value.trim() === '' ? null : value
    const current = page.caption ?? null
    // Update the local state instantly (input + preview are driven by it).
    setPages(prev => prev.map(p => (p.id === page.id ? { ...p, caption: next } : p)))
    if (next === current) return   // nothing changed → nothing to persist
    if (captionSave === 'error') setCaptionSave(null)  // re-typing clears the stale error status
    const timers = captionTimers.current
    if (timers[page.id]) { clearTimeout(timers[page.id]); delete timers[page.id] }
    timers[page.id] = setTimeout(() => {
      delete timers[page.id]
      saveCaption(page.id, value)
    }, 600)
  }, [saveCaption, captionSave])

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
  const deletePage = useCallback(async (pageId) => {
    // The hover BIN always passes the page it points at. (Step 12.5a also
    // allowed a no-arg call defaulting to the active page — kept as a
    // harmless fallback; the heading pill + Delete key now go through
    // deletePages/deleteSelection below.)
    if (deleting) return
    if (pageId == null) pageId = activePageId
    if (pageId == null) return
    const page = selectedPages.find(p => p.id === pageId)
    if (!page) return
    const ok = window.confirm(`Delete page ${page.page_number} (${fileNameOf(page.file_path)})?\nThe remaining pages renumber — this cannot be undone.`)
    if (!ok) return
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
      const remaining = selectedPages.filter(p => p.id !== pageId)
      const renumbered = remaining.map((p, i) => ({ ...p, page_number: i + 1 }))
      const others = prevPages.filter(p => p.comic_id !== selectedId)
      setPages([...others, ...renumbered])
      // Step 12.5b — remove the deleted page from the MULTI-SELECTION (the
      // validity effect above reconciles the active page: last remaining
      // selected member, else the comic's first page). Deleting a
      // non-selected page leaves the selection untouched.
      setSelectedIds(prev => prev.filter(id => id !== pageId))
      setNotice(data.count !== undefined
        ? `Deleted page ${page.page_number} — ${data.count} page${data.count === 1 ? '' : 's'} left.`
        : `Deleted page ${page.page_number}.`)
    } catch (err) {
      setPages(prevPages)
      setError(err.message)
    } finally {
      setDeleting(false)
    }
  }, [activePageId, deleting, selectedPages, pages, selectedId, csrfToken])

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
  // Step 11.5a (fourth revision — the current one) — two deltas: the BOTTOM
  // grip changes the height (bottom edge follows the pointer, top edge fixed,
  // the page grows at the bottom); the TOP grip moves the top edge with the
  // pointer (bottom edge fixed) via `topDelta` / `onTopDeltaChange` — App
  // shifts the content above (its `.wrap`) to make room. This component only
  // passes the pair through; the deltas live in ResizableSection.
  return (
    <ResizableSection
      className="comic-editor"
      storageKey="comicEditor"
      topDelta={topDelta}
      onTopDeltaChange={onTopDeltaChange}
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

          {/* Step 2 — the live dropzone: THREE input paths.
              drag/drop a batch · single click = paste · double click = picker. */}
          <div
            className={
              'dropzone'
              + (dragActive ? ' dropzone--active' : '')
              + (uploading ? ' dropzone--busy' : '')
            }
            onDragOver={onZoneDragOver}
            onDragLeave={onZoneDragLeave}
            onDrop={onZoneDrop}
            onClick={onZoneClick}
            onDoubleClick={onZoneDoubleClick}
            title="Ctrl+V (or click) to paste from the clipboard · double-click to pick files · or drag a batch of images in"
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
              <p className="muted">No pages yet.</p>
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
                    // page in the preview; the reorder DnD lives in the
                    // grid/fill regimes (nothing is draggable here).
                    return (
                      <li
                        key={p.id}
                        data-page-id={p.id}
                        className={
                          'page-list-item'
                          + (isActive ? ' page-list-item--active' : '')
                          + (isSelected ? ' page-list-item--selected' : '')
                          // Step 11.5b — the list regime's landing slot (a row
                          // drop lands LAST, so this is the last row — the
                          // cell the dragged page will occupy).
                          + (gridDropSlot === i ? ' page-list-item--drop-slot' : '')
                        }
                        title={`${fileNameOf(p.file_path)} — click to activate · Ctrl+click to multi-select · arrows to move · Shift+arrow to extend · Shift+click to range-select`}
                        onClick={e => onListRowClick(e, p.id)}
                      >
                        <span className="page-list-num">Page {p.page_number}</span>
                        <span className="page-list-name">{fileNameOf(p.file_path)}</span>
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
                        // Step 11.5b — the LANDING SLOT: the cell the dragged
                        // page will occupy (the marker and the drop share the
                        // one slot model, so a drop lands exactly here). The
                        // grid/fill regimes only — in the list regime the
                        // rows above take the slot instead.
                        + (gridDropSlot === i ? ' page-tile--drop-slot' : '')
                      }
                      draggable
                      title={`${fileNameOf(p.file_path)} — click to activate · Ctrl+click to multi-select · arrows to move (grid) · Shift+arrow to extend · drag to reorder · drag a selected page to move the whole selection`}
                      onClick={e => onListRowClick(e, p.id)}
                      onDragStart={e => onRowDragStart(e, p)}
                      onDragEnd={clearDrag}
                      onDrop={e => onRowDrop(e, p)}
                    >
                      <img src={p.file_path} alt={`Page ${p.page_number}`} />
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
            <p className="muted">No pages yet.</p>
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
                const planAt = (slot) => draggingId !== null && slot >= 0 && slot <= visiblePages.length
                  ? planBlockDrop(draggingId, slot < visiblePages.length ? visiblePages[slot].id : null)
                  : null
                const showBefore = previewDropIdx === i && !!planAt(i)
                const showAfter = previewDropIdx === i + 1 && !!planAt(i + 1)
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
                    }
                    title="Click to make this the active page · Ctrl+click to multi-select · Up/Down = the adjacent page · Shift+Up/Down to extend · drag to reorder · drag a selected page to move the whole selection"
                    onClick={e => onListRowClick(e, p.id, 'preview')}
                    draggable
                    onDragStart={e => onRowDragStart(e, p)}
                    onDragEnd={clearDrag}
                  >
                    {isActive ? (
                      /* Step 8 — the caption editor lives HERE: the (Step-4,
                         unchanged) caption input above the ACTIVE page's image,
                         centred at the image's width (fit-content figure), with
                         the save cues beside it. Non-active pages keep the
                         read-only figcaption (when they have one). */
                      <>
                        <input
                          type="text"
                          className="caption-input"
                          value={p.caption ?? ''}
                          placeholder="Caption…"
                          aria-label={`Caption for page ${p.page_number}`}
                          onChange={e => onCaptionChange(p, e.target.value)}
                        />
                        {/* 2026-09-27 user tweak — 'Saving…' + 'Caption saved' now
                            live in the preview toolbar (next to the active-page
                            toggle) and the saved cue auto-hides after ~3 s (the
                            state is per-editor, not per-page, so a stuck 'saved'
                            cue was following the active page onto pages that had
                            never been saved). Only a FAILED save stays here,
                            beside the box it belongs to. */}
                        {captionSave === 'error' ? <span className="caption-status error">{captionError}</span> : null}
                      </>
                    ) : (
                      p.caption ? <figcaption className="page-caption">{p.caption}</figcaption> : null
                    )}
                    {/* 2026-09-27 user tweak — the bin lives INSIDE this wrapper,
                        so its top-right corner is the IMAGE's top-right on EVERY
                        page. It used to anchor to the figure's corner, which on
                        the active page is the caption box's corner (the bin
                        floated over the caption input). Hover reveal is scoped
                        to the image now, not the caption box. Still surgical:
                        deletes THIS page even if it is not the active one. */}
                    <div className="preview-imgwrap">
                      <PageBin
                        title={`Delete page ${p.page_number} (${fileNameOf(p.file_path)})`}
                        disabled={deleting}
                        onClick={e => { e.stopPropagation(); deletePage(p.id) }}
                      />
                      <img className="preview-thumb" src={p.file_path} alt={`Page ${p.page_number}`} />
                    </div>
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
