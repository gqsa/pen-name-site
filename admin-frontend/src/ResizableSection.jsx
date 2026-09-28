import { useState } from 'react'

// Step 11 (B2.5 round 2) — the PLAIN resizable-section pattern: a <section>
// with a fixed height (state, px), its content in a flex body that fills, and
// grip strips on the TOP and BOTTOM edges (Step 11.5a).
//
// Edge model (2026-09-28 follow-up — each grip owns ONE edge, the other
// edge stays put, like a window resize):
//   • BOTTOM grip — the section's HEIGHT: drag down → taller, up → shorter;
//     the top edge stays put. The original Step-11 behaviour, unchanged.
//   • TOP grip — the section's TOP EDGE: drag up → the top edge rises (the
//     section grows UPWARD, the bottom edge stays put); drag down → the top
//     edge drops (the section shrinks from the top, the bottom edge stays
//     put). Implemented as height + a vertical PULL: the top grip moves both
//     by the same amount (h ± n AND pull ± n), which keeps the bottom edge
//     fixed — top = flow − pull, bottom = flow − pull + h. The pull renders
//     as `transform: translateY(−pull px)`: NO reflow (the document height
//     never changes, so a page scrolled to the bottom doesn't jump mid-drag)
//     and no margin to fight (the section keeps its CSS margin). The section
//     is later in the DOM than whatever sits above it, so it simply paints
//     over that content while pulled up. Capped at TOP_PULL_MAX so a runaway
//     drag can't bury the whole page (and the cap can't be smuggled in via
//     storage, since the restore range is validated).
//
// pointerdown on a grip → pointermove tracked on window → clamped set →
// pointerup releases + commits. Nothing in here knows about comics or
// stories, so the story / media editor sections (and B2.8 — editor-section
// minimise) can mount one per section and each keeps its own height + grips
// for free.
//
// Lifetime: when a `storageKey` is given (Step 11.5a), BOTH values persist to
// localStorage under `gqsa.sectionHeight.<key>` (height) and
// `gqsa.sectionTopPull.<key>` (pull) — they survive a hard reload and comic
// switches (one pair per SECTION, not per comic). Browser-side, so they also
// survive Render's free-tier disk wipes. Without a `storageKey` it stays
// session state (resets on reload).

const MIN_H = 480         // px — the height's lower clamp
const MAX_H = 1400        // px — the height's upper clamp
const DEFAULT_H = 720     // px — the default height
const TOP_PULL_MAX = 1000 // px — how far ABOVE its flow position the top edge may go

// Step 11.5a — the localStorage helpers. Every access is try/catch'd: a
// blocked or unavailable storage (private mode, quota) degrades to session
// state — the section still works, it only forgets on reload.
const heightKey = k => 'gqsa.sectionHeight.' + k
const pullKey = k => 'gqsa.sectionTopPull.' + k

function readStored(storageKey, keyFn, fallback, lo, hi) {
  try {
    const raw = window.localStorage.getItem(keyFn(storageKey))
    if (raw == null) return fallback
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < lo || n > hi) return fallback  // corrupt/garbage → default
    return n
  } catch { return fallback }
}

function writeStored(storageKey, keyFn, value) {
  try { window.localStorage.setItem(keyFn(storageKey), String(value)) } catch { /* session-only */ }
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
  children,
}) {
  // Step 11.5a — restore the stored size on mount (fall back to
  // `initialHeight` / pull 0 when absent/invalid).
  const [h, setH] = useState(() =>
    storageKey != null ? readStored(storageKey, heightKey, initialHeight, 100, 5000) : initialHeight,
  )
  const [pull, setPull] = useState(() =>
    storageKey != null ? readStored(storageKey, pullKey, 0, -2000, 2000) : 0,
  )

  // One drag handler for both grips; each grip owns ONE edge:
  //   dir +1 = bottom grip → the BOTTOM edge follows the pointer (height ±
  //                      n, the top edge stays put)
  //   dir −1 = top grip    → the TOP edge follows the pointer (height and
  //                      pull move together, the bottom edge stays put)
  const startResize = (e, dir) => {
    if (e.button !== 0) return            // left button only
    e.preventDefault()                    // no text-selection / native drag
    const startY = e.clientY
    const startH = h
    const startPull = pull
    let lastH = startH                    // the last values (the commit)
    let lastPull = startPull
    const onMove = ev => {
      const dy = ev.clientY - startY
      if (dir > 0) {
        lastH = Math.max(minHeight, Math.min(maxHeight, Math.round(startH + dy)))
        lastPull = startPull
      } else {
        const n = Math.abs(dy)
        if (dy < 0) {
          // drag UP — the top edge rises by n: the height grows AND the pull
          // grows by the same amount, so the bottom edge (flow − pull + h)
          // stays put. Whichever limit hits first (height cap or pull cap)
          // freezes the drag.
          const hNew = Math.min(maxHeight, startH + n)
          lastH = hNew
          lastPull = Math.min(TOP_PULL_MAX, startPull + (hNew - startH))
        } else {
          // drag DOWN — the top edge drops by n: the height shrinks AND the
          // pull shrinks by the same amount (the pull may go NEGATIVE = the
          // top edge below its flow position). The height floor limits how
          // far it can drop, and the bottom edge stays put.
          const hNew = Math.max(minHeight, startH - n)
          lastH = hNew
          lastPull = startPull - (startH - hNew)
        }
      }
      setH(lastH)
      setPull(lastPull)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('section-resizing')
      // Step 11.5a — persist the committed size. Only write when the drag
      // actually moved, so a plain click on the grip never churns storage.
      if (storageKey != null && (lastH !== startH || lastPull !== startPull)) {
        if (lastH !== startH) writeStored(storageKey, heightKey, lastH)
        if (lastPull !== startPull) writeStored(storageKey, pullKey, lastPull)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // ns-resize cursor everywhere + no accidental text selection while
    // dragging (the CSS behind the class is in index.css, Step 11).
    document.body.classList.add('section-resizing')
  }

  // Step 11.5a — double-click a grip: reset to the defaults AND drop BOTH
  // stored values, so a later reload restores the defaults too (otherwise
  // the stale stored values would re-apply on the next load).
  const resetSize = () => {
    setH(initialHeight)
    setPull(0)
    if (storageKey != null) {
      clearStored(storageKey, heightKey)
      clearStored(storageKey, pullKey)
    }
  }

  // 2026-09-28 follow-up — the pull is a visual translate (no reflow). Only
  // set the transform when non-zero, so a fresh section carries no stacking
  // context at all.
  const style = { height: h + 'px' }
  if (pull !== 0) style.transform = 'translateY(' + (-pull) + 'px)'

  return (
    <section className={('resizable-section ' + className).trim()} style={style}>
      <div
        className="resizable-grip resizable-grip--top"
        onPointerDown={e => startResize(e, -1)}
        onDoubleClick={resetSize}
        role="separator"
        aria-orientation="horizontal"
        title="Drag up/down to move the top edge (double-click to reset)"
        aria-label="Resize section (top edge)"
      />
      <div className="resizable-body">{children}</div>
      <div
        className="resizable-grip resizable-grip--bottom"
        onPointerDown={e => startResize(e, 1)}
        onDoubleClick={resetSize}
        role="separator"
        aria-orientation="horizontal"
        title="Drag up/down to resize (double-click to reset)"
        aria-label="Resize section (bottom edge)"
      />
    </section>
  )
}
