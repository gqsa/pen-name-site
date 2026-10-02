import { useEffect, useState } from 'react'

// Step 11 (B2.5 round 2) + Step 11.5a — the GENERIC resizable-section pattern:
// a <section> whose height is base + two independent deltas, a flex body that
// fills, and grip strips on the TOP and BOTTOM edges.
//
// Edge model (2026-09-28, FIFTH revision — the current one):
//
//   height = baseHeight + topDelta + bottomDelta          (clamped 480..1400)
//
//   BOTH grips simply GROW the section's height — neither ever shifts the
//   content above (that was the 4th revision's mechanism and the source of
//   the top clipping / gapping). The only difference is the scroll:
//
//   • TOP grip — drag up → taller, down → shorter. The section grows (the
//     growth is "below", like the bottom grip) AND the page scrolls DOWN by
//     the same amount (window.scrollBy, incremental). Net in the viewport:
//     the bottom edge stays put, the top edge + grip climb up under the
//     pointer, so the user SEES the section get taller. The content above is
//     never shifted — it just scrolls up, reachable by scrolling back.
//   • BOTTOM grip — drag down → taller, up → shorter. The section grows;
//     normal flow pushes whatever is below down — the page grows at the
//     bottom. No scroll (the growth is already visible at the bottom edge).
//
//   Neither grip ever changes another section's HEIGHT, and neither moves
//   any other element's layout position — the top grip's scroll is a
//   viewport effect only (it doesn't change the document flow at all).
//
// History — why this revision (the user rejected the ones before it):
//   1st — the top grip moved the section with `transform: translateY` (it
//         painted over the section above — rejected).
//   2nd — shrank the section above to make room (rejected: changing one
//         section's height must not change any other section's).
//   3rd — both grips changed only this section's height (the grow directions
//         did nothing visible — the edge never followed the pointer —
//         rejected).
//   4th — two deltas; the top edge followed the pointer via the
//         content-above shift, the bottom edge via the height (the shift
//         clipped the heading at the very top / gapped when the content
//         above was small — rejected).
//   5th — THIS: both grips grow the height (no content-above shift); the
//         top grip additionally scrolls the page down by the drag amount so
//         the growth is visible (top edge climbs under the pointer, bottom
//         edge stays put).
//
// pointerdown on a grip → pointermove tracked on window → clamped set →
// pointerup releases + commits. Nothing in here knows about comics or
// stories, so the story / media editor sections (and B2.8 — editor-section
// minimise) can mount one per section and each keeps its own deltas + grips
// for free. Both grips are full in every context (the 5th revision dropped
// the controlled / content-above-shift mode, so there is no fallback path).
//
// Lifetime: when a `storageKey` is given, BOTH deltas persist to
// localStorage under `gqsa.sectionHeight.<key>` as `{"t":<top>,"b":<bottom>}`
// (committed on pointerup, only if the drag moved). A plain-number value —
// the 1st–3rd revision's absolute height — is migrated on read: the old model
// pinned the top edge, so the whole difference becomes the bottomDelta (the
// stored height looks identical after the migration). Browser-side, so it
// also survives Render's free-tier disk wipes. Without a `storageKey` it
// stays session state (resets on reload).
//
// Reset: double-click EITHER grip → both deltas back to 0 (the stored value
// dropped too, so a stale one can't re-apply on the next load).
//
// B2.8 (editor sections minimisable) — when a `title` prop is given, the
// section grows the minimise affordance: a small "−" button (top-right
// corner) collapses the section to a 48px header bar (the title + a
// Restore button), and Restore brings it back. STATE-ONLY — no endpoints.
// The grips + body stay MOUNTED the whole time (CSS hides them while
// minimized), so the editor's drafts / selection / zoom survive the
// round-trip untouched. The minimise state PERSISTS across reloads the
// same way the height does (localStorage `gqsa.sectionMinimized.<key>`,
// written on every minimise/restore — the user comes back to the same
// decluttered view); without a storageKey it stays session state. The
// height deltas are preserved across the round-trip.

const MIN_H = 480         // px — the total-height lower clamp
const MAX_H = 1400        // px — the total-height upper clamp
const DEFAULT_H = 720     // px — the base height

const heightKey = k => 'gqsa.sectionHeight.' + k
const legacyPullKey = k => 'gqsa.sectionTopPull.' + k   // 1st revision — cleared below
const minimizedKey = k => 'gqsa.sectionMinimized.' + k  // B2.8 — persisted minimise state

// Step 11.5a — read the stored deltas; returns {t, b}. Every access is
// try/catch'd: a blocked or unavailable storage (private mode, quota)
// degrades to session state — the section still works, it only forgets on
// reload. Accepts the current JSON shape AND the old plain-number (absolute
// height) shape from the earlier revisions — the number migrates to
// {t: 0, b: n − base} (see the header: the old model pinned the top edge).
export function readStoredDeltas(storageKey, baseHeight, lo, hi) {
  const none = { t: 0, b: 0 }
  try {
    const raw = window.localStorage.getItem(heightKey(storageKey))
    if (raw == null) return none
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n)) {
      const b = n - baseHeight
      return (b >= lo - baseHeight && b <= hi - baseHeight) ? { t: 0, b } : none
    }
    const o = JSON.parse(raw)
    if (o && Number.isFinite(o.t) && Number.isFinite(o.b)
        && baseHeight + o.t + o.b >= lo && baseHeight + o.t + o.b <= hi) {
      return { t: o.t, b: o.b }
    }
    return none
  } catch { return none }
}

function writeStored(storageKey, deltas) {
  try { window.localStorage.setItem(heightKey(storageKey), JSON.stringify(deltas)) } catch { /* session-only */ }
}

// B2.8 — the persisted minimise flag ('1' minimised / '0' expanded). Blocked
// or unavailable storage degrades to the expanded default (session state) —
// the section still works, it only forgets on reload, exactly like the
// height-delta fallback.
function readStoredMinimized(storageKey) {
  try { return window.localStorage.getItem(minimizedKey(storageKey)) === '1' } catch { return false }
}
function writeMinimized(storageKey, on) {
  try { window.localStorage.setItem(minimizedKey(storageKey), on ? '1' : '0') } catch { /* session-only */ }
}

function clearStored(storageKey, keyFn) {
  try { window.localStorage.removeItem(keyFn(storageKey)) } catch { /* nothing to clear */ }
}

export default function ResizableSection({
  className = '',
  initialHeight = DEFAULT_H,
  minHeight = MIN_H,
  maxHeight = MAX_H,
  storageKey = null,
  // B2.8 — the section's name (e.g. 'Comic editor'). When given, the section
  // gets the minimise affordance (the "−" button → the title + Restore bar).
  // Without it the section renders exactly as before (no button, no bar).
  title = null,
  // Generic drag pass-through: any section can opt into being a drop target
  // by forwarding these to the <section> below. The comic editor uses them
  // for Step 13's section-level file drop (a file dropped ANYWHERE in the
  // section appends at the end). Kept fully generic here — no comic logic in
  // this shared component (the story / media sections + B2.8 inherit the
  // ability without the behaviour).
  onDragOver = null,
  onDrop = null,
  onDragLeave = null,
  children,
}) {
  // bottomDelta — always internal state: the bottom edge needs no parent
  // shift, normal flow does the work.
  const [bottomDelta, setBottomDelta] = useState(() =>
    storageKey != null ? readStoredDeltas(storageKey, initialHeight, minHeight, maxHeight).b : 0,
  )
  // 5th revision — topDelta is internal state (the 4th revision's controlled
  // mode + content-above shift is gone; the parent no longer owns the delta).
  // The section simply GROWS by it (height = base + top + bottom); the TOP
  // grip additionally scrolls the page so the growth is visible (startResize).
  const [top, setTop] = useState(() =>
    storageKey != null ? readStoredDeltas(storageKey, initialHeight, minHeight, maxHeight).t : 0,
  )

  // B2.8 — the minimise state. Persisted like the height (the user comes
  // back to the same decluttered view on reload) when a storageKey is
  // given; without one it's session state. The deltas above are untouched
  // by it, so a Restore returns the section to exactly the height it had
  // before the minimise.
  const [minimized, setMinimized] = useState(() =>
    storageKey != null ? readStoredMinimized(storageKey) : false,
  )
  const setMinimizedBoth = (on) => {
    setMinimized(on)
    if (storageKey != null) writeMinimized(storageKey, on)
  }

  // One-shot cleanup: the FIRST revision stored a `pull` (a translateY that
  // painted over the section above). The model no longer has one — drop the
  // stale key so it can't confuse anyone inspecting localStorage.
  useEffect(() => {
    if (storageKey != null) clearStored(storageKey, legacyPullKey)
  }, [storageKey])

  const height = initialHeight + top + bottomDelta

  // ONE handler for BOTH grips. `edge` is 'top' or 'bottom'; `dy` is the
  // pointer delta (down is +). 5th revision — BOTH grips grow the section's
  // height (no content-above shift); the TOP grip additionally scrolls the
  // page so the growth is visible:
  //   • top grip    → the section grows (topDelta = start − dy; drag up:
  //                   dy<0 → taller) AND the page scrolls DOWN by the same
  //                   amount. Net in the viewport: the bottom edge stays put,
  //                   the top edge + grip climb up under the pointer, so you
  //                   SEE the section get taller. The content above is never
  //                   shifted — it just scrolls up (reachable by scrolling).
  //   • bottom grip → the section grows (bottomDelta = start + dy; drag down:
  //                   dy>0 → taller); normal flow pushes the content below
  //                   down; the top edge stays fixed. No scroll (the growth
  //                   is already visible at the bottom edge).
  // The TOTAL height is clamped to [minHeight, maxHeight]: whichever limit
  // hits first freezes that edge's drag (the other delta is untouched).
  const startResize = (e, edge) => {
    if (e.button !== 0) return            // left button only
    e.preventDefault()                    // no text-selection / native drag
    const startY = e.clientY
    const startTop = top
    const startBottom = bottomDelta
    let lastTop = startTop
    let lastBottom = startBottom
    let moved = false
    const onMove = ev => {
      const dy = Math.round(ev.clientY - startY)
      if (dy !== 0) moved = true
      if (edge === 'top') {
        let t = startTop - dy
        const total = initialHeight + t + startBottom
        if (total < minHeight) t = minHeight - initialHeight - startBottom
        else if (total > maxHeight) t = maxHeight - initialHeight - startBottom
        // 5th revision — the section GROWS by (t − lastTop) and the page
        // SCROLLS DOWN by that same amount (window.scrollBy, incremental —
        // the change since the last move, not the total from the start). The
        // growth is "below" like the bottom grip, so without the scroll it
        // would be out of view; the scroll keeps the bottom edge put and lets
        // the top edge + grip climb up under the pointer, so the user sees
        // the section get taller. Clamping is honoured: if the section can't
        // grow (already at the limit) growth is 0 and there is no scroll.
        const growth = t - lastTop
        lastTop = t
        setTop(t)
        // behavior:'instant' overrides any CSS scroll-behavior:smooth so the
        // scroll tracks the pointer exactly during the drag (no animation lag).
        if (growth !== 0) window.scrollBy({ top: growth, behavior: 'instant' })
      } else {
        let b = startBottom + dy
        const total = initialHeight + startTop + b
        if (total < minHeight) b = minHeight - initialHeight - startTop
        else if (total > maxHeight) b = maxHeight - initialHeight - startTop
        lastBottom = b
        setBottomDelta(b)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('section-resizing')
      // Persist the committed deltas. Only write when the drag actually
      // moved, so a plain click on the grip never churns storage.
      if (storageKey != null && moved && (lastTop !== startTop || lastBottom !== startBottom)) {
        writeStored(storageKey, { t: lastTop, b: lastBottom })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // ns-resize cursor everywhere + no accidental text selection while
    // dragging (the CSS behind the class is in index.css, Step 11).
    document.body.classList.add('section-resizing')
  }

  // Double-click EITHER grip → both deltas back to the default (and the
  // stored value dropped, so a stale one can't re-apply on the next load).
  const reset = () => {
    setTop(0)
    setBottomDelta(0)
    if (storageKey != null) clearStored(storageKey, heightKey)
  }

  return (
    <section
      className={(
        'resizable-section'
        + (minimized ? ' resizable-section--minimized' : '')
        + (className ? ' ' + className : '')
      ).trim()}
      // B2.8 — while minimized the inline height is dropped and the CSS
      // `.resizable-section--minimized` height (48px header bar) takes over.
      style={minimized ? undefined : { height: height + 'px' }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
    >
      {/* B2.8 — the minimise header bar. Static chrome, hidden while
          expanded; the body below stays MOUNTED in BOTH states (that is
          what keeps the editor's drafts / selection / zoom intact). */}
      {title != null && (
        <div className="section-minbar">
          <span className="section-minbar-title">{title}</span>
          <button
            type="button"
            className="section-minbar-restore"
            onClick={() => setMinimizedBoth(false)}
            aria-label={'Restore ' + title}
          >
            + Restore
          </button>
        </div>
      )}
      <div
        className="resizable-grip resizable-grip--top"
        onPointerDown={e => startResize(e, 'top')}
        onDoubleClick={reset}
        role="separator"
        aria-orientation="horizontal"
        title="Drag up/down to move this section's top edge (double-click to reset)"
        aria-label="Resize section (top edge)"
      />
      <div className="resizable-body">{children}</div>
      <div
        className="resizable-grip resizable-grip--bottom"
        onPointerDown={e => startResize(e, 'bottom')}
        onDoubleClick={reset}
        role="separator"
        aria-orientation="horizontal"
        title="Drag up/down to move this section's bottom edge (double-click to reset)"
        aria-label="Resize section (bottom edge)"
      />
      {/* B2.8 — the minimise button (visible only while expanded; a static
          sibling of the grips, so a click never starts a grip drag). */}
      {title != null && !minimized && (
        <button
          type="button"
          className="section-minimise"
          onClick={() => setMinimizedBoth(true)}
          aria-label={'Minimise ' + title}
          title={'Minimise ' + title}
        >
          −
        </button>
      )}
    </section>
  )
}
