import { useEffect, useState } from 'react'

// Step 11 (B2.5 round 2) + Step 11.5a — the GENERIC resizable-section pattern:
// a <section> whose height is base + two independent deltas, a flex body that
// fills, and grip strips on the TOP and BOTTOM edges.
//
// Edge model (2026-09-28, FOURTH revision — the current one):
//
//   height = baseHeight + topDelta + bottomDelta          (clamped 480..1400)
//
//   • TOP grip — drag up → taller, down → shorter. The section's TOP EDGE
//     follows the pointer and the BOTTOM EDGE stays fixed. A section can't
//     pull its flow position upward by itself (whatever sits above it is in
//     the way — its own negative margin can't beat the gap's margin
//     collapsing), so the shift happens on the content ABOVE: the parent
//     shifts it up by `topDelta` (margin-top = baseMargin − topDelta). This
//     component reports its topDelta through `onTopDeltaChange`; the parent
//     applies the margin. (It is base−Δ, NOT a bare −Δ: a bare negative
//     margin would shift the content above by base+Δ and the top edge would
//     overshoot the pointer by the whole base margin.)
//   • BOTTOM grip — drag down → taller, up → shorter. The section's BOTTOM
//     edge follows the pointer and the TOP edge stays fixed. Only the height
//     changes; normal flow pushes whatever is below down — the page grows at
//     the bottom.
//
//   Neither grip ever changes another section's HEIGHT. A section above only
//   MOVES (it is part of the content above) when the top grip is dragged.
//
// History — why this revision (the user rejected the ones before it):
//   1st — the top grip moved the section with `transform: translateY` (it
//         painted over the section above — rejected).
//   2nd — shrank the section above to make room (rejected: changing one
//         section's height must not change any other section's).
//   3rd — both grips changed only this section's height (the grow directions
//         did nothing visible — the edge never followed the pointer —
//         rejected).
//   4th — THIS: two deltas; the top edge follows the pointer via the
//         content-above shift, the bottom edge via the height.
//
// pointerdown on a grip → pointermove tracked on window → clamped set →
// pointerup releases + commits. Nothing in here knows about comics or
// stories, so the story / media editor sections (and B2.8 — editor-section
// minimise) can mount one per section and each keeps its own deltas + grips
// for free (a section mounted WITHOUT `onTopDeltaChange` degrades to
// height-only resizing — there is no content above for the parent to shift,
// so the top edge doesn't follow the pointer; the bottom grip is full).
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

const MIN_H = 480         // px — the total-height lower clamp
const MAX_H = 1400        // px — the total-height upper clamp
const DEFAULT_H = 720     // px — the base height

const heightKey = k => 'gqsa.sectionHeight.' + k
const legacyPullKey = k => 'gqsa.sectionTopPull.' + k   // 1st revision — cleared below

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

function clearStored(storageKey, keyFn) {
  try { window.localStorage.removeItem(keyFn(storageKey)) } catch { /* nothing to clear */ }
}

export default function ResizableSection({
  className = '',
  initialHeight = DEFAULT_H,
  minHeight = MIN_H,
  maxHeight = MAX_H,
  storageKey = null,
  topDelta = 0,
  onTopDeltaChange = null,
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
  // topDelta — CONTROLLED when the parent is given (it applies the
  // content-above shift); otherwise internal state (the height-only
  // fallback above). NOTE: in controlled mode the PARENT must initialize
  // `topDelta` from the same readStoredDeltas() so the first paint is
  // already shifted — the child never pushes it, so a parent that starts
  // from 0 would flash the un-shifted layout for a frame.
  const [internalTop, setInternalTop] = useState(() =>
    storageKey != null ? readStoredDeltas(storageKey, initialHeight, minHeight, maxHeight).t : 0,
  )
  const top = onTopDeltaChange ? topDelta : internalTop
  const setTop = onTopDeltaChange || setInternalTop

  // One-shot cleanup: the FIRST revision stored a `pull` (a translateY that
  // painted over the section above). The model no longer has one — drop the
  // stale key so it can't confuse anyone inspecting localStorage.
  useEffect(() => {
    if (storageKey != null) clearStored(storageKey, legacyPullKey)
  }, [storageKey])

  const height = initialHeight + top + bottomDelta

  // ONE handler for BOTH grips. `edge` is 'top' or 'bottom'; `dy` is the
  // pointer delta (down is +):
  //   • top grip    → the TOP edge follows the pointer:
  //                   topDelta = start − dy (drag up: dy<0 → topDelta grows
  //                   → taller; the content above shifts up by the same
  //                   amount; the bottom edge stays fixed)
  //   • bottom grip → the BOTTOM edge follows the pointer:
  //                   bottomDelta = start + dy (drag down: dy>0 → taller;
  //                   normal flow pushes the content below down; the top
  //                   edge stays fixed)
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
        lastTop = t
        setTop(t)
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
      className={('resizable-section ' + className).trim()}
      style={{ height: height + 'px' }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
    >
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
    </section>
  )
}
