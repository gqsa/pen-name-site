import { useState } from 'react'

// Step 11 (B2.5 round 2) — the PLAIN resizable-section pattern: a <section>
// with a fixed height (state, px), its content in a flex body that fills, and
// grip strips on the TOP and BOTTOM edges (Step 11.5a) that drag-resize the
// height — pointerdown on a grip → pointermove tracked on window → clamped
// setH → pointerup releases. Nothing in here knows about comics or stories,
// so the story / media editor sections (and B2.8 — editor‑section minimise)
// can mount one per section and each keeps its own height + grips for free.
//
// Lifetime: when a `storageKey` is given (Step 11.5a), the height persists to
// localStorage under `gqsa.sectionHeight.<key>` — it survives a hard reload
// and comic switches (one value per SECTION, not per comic). Browser-side, so
// it also survives Render's free-tier disk wipes. Without a `storageKey` it
// stays session state (resets to `initialHeight` on reload).

const MIN_H = 480      // px — the spec's lower clamp
const MAX_H = 1400     // px — the spec's upper clamp
const DEFAULT_H = 720  // px — the spec's initial height

// Step 11.5a — the localStorage helpers. Every access is try/catch'd: a
// blocked or unavailable storage (private mode, quota) degrades to session
// state — the section still works, it only forgets on reload.
const heightKey = k => 'gqsa.sectionHeight.' + k

function readStoredHeight(storageKey, fallback) {
  try {
    const raw = window.localStorage.getItem(heightKey(storageKey))
    if (raw == null) return fallback
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 100 || n > 5000) return fallback  // corrupt/garbage → default
    return n
  } catch { return fallback }
}

function storeHeight(storageKey, value) {
  try { window.localStorage.setItem(heightKey(storageKey), String(value)) } catch { /* session-only */ }
}

function clearStoredHeight(storageKey) {
  try { window.localStorage.removeItem(heightKey(storageKey)) } catch { /* nothing to clear */ }
}

export default function ResizableSection({
  className = '',
  initialHeight = DEFAULT_H,
  minHeight = MIN_H,
  maxHeight = MAX_H,
  storageKey = null,
  children,
}) {
  // Step 11.5a — restore the stored height on mount (fall back to
  // `initialHeight` when absent/invalid).
  const [h, setH] = useState(() =>
    storageKey != null ? readStoredHeight(storageKey, initialHeight) : initialHeight,
  )

  // One drag handler for both grips. dir: +1 = bottom grip (drag down →
  // taller), -1 = top grip (drag up → taller, drag down → shorter).
  const startResize = (e, dir) => {
    if (e.button !== 0) return            // left button only
    e.preventDefault()                    // no text-selection / native drag
    const startY = e.clientY
    const startH = h
    const clamp = v => Math.max(minHeight, Math.min(maxHeight, Math.round(v)))
    let lastH = startH                    // the last clamped value (the commit)
    const onMove = ev => {
      lastH = clamp(startH + dir * (ev.clientY - startY))
      setH(lastH)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('section-resizing')
      // Step 11.5a — persist the committed height. Only write when the drag
      // actually moved, so a plain click on the grip never churns storage.
      if (storageKey != null && lastH !== startH) storeHeight(storageKey, lastH)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // ns-resize cursor everywhere + no accidental text selection while
    // dragging (the CSS behind the class is in index.css, Step 11).
    document.body.classList.add('section-resizing')
  }

  // Step 11.5a — double-click a grip: reset to the default AND drop the
  // stored value, so a later reload restores the default too (otherwise the
  // stale stored height would re-apply on the next load).
  const resetHeight = () => {
    setH(initialHeight)
    if (storageKey != null) clearStoredHeight(storageKey)
  }

  const gripProps = {
    role: 'separator',
    'aria-orientation': 'horizontal',
    title: 'Drag up/down to resize (double-click to reset)',
  }

  return (
    <section className={('resizable-section ' + className).trim()} style={{ height: h + 'px' }}>
      <div
        className="resizable-grip resizable-grip--top"
        onPointerDown={e => startResize(e, -1)}
        onDoubleClick={resetHeight}
        {...gripProps}
        aria-label="Resize section (top edge)"
      />
      <div className="resizable-body">{children}</div>
      <div
        className="resizable-grip resizable-grip--bottom"
        onPointerDown={e => startResize(e, 1)}
        onDoubleClick={resetHeight}
        {...gripProps}
        aria-label="Resize section (bottom edge)"
      />
    </section>
  )
}
