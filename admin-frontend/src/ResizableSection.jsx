import { useState } from 'react'

// Step 11 (B2.5 round 2) — the PLAIN resizable-section pattern: a <section>
// with a fixed height (state, px), its content in a flex body that fills, and
// a grip strip on the BOTTOM edge that drag-resizes the height — pointerdown
// on the grip → pointermove tracked on window → clamped setH → pointerup
// releases. Nothing in here knows about comics or stories, so B2.8 can mount
// one instance per open editor and each keeps its own height.
//
// Lifetime: the height is session state. It resets to `initialHeight` on a
// page reload (Step 11's spec accepts that) and survives a comic switch
// (state lives on the mounted section, not per-comic).
const MIN_H = 480      // px — the spec's lower clamp
const MAX_H = 1400     // px — the spec's upper clamp
const DEFAULT_H = 720  // px — the spec's initial height

export default function ResizableSection({
  className = '',
  initialHeight = DEFAULT_H,
  minHeight = MIN_H,
  maxHeight = MAX_H,
  children,
}) {
  const [h, setH] = useState(initialHeight)

  const onGripPointerDown = (e) => {
    if (e.button !== 0) return            // left button only
    e.preventDefault()                    // no text-selection / native drag
    const startY = e.clientY
    const startH = h
    const clamp = v => Math.max(minHeight, Math.min(maxHeight, Math.round(v)))
    const onMove = ev => setH(clamp(startH + (ev.clientY - startY)))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('section-resizing')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // ns-resize cursor everywhere + no accidental text selection while
    // dragging (the CSS behind the class is in index.css, Step 11).
    document.body.classList.add('section-resizing')
  }

  return (
    <section className={('resizable-section ' + className).trim()} style={{ height: h + 'px' }}>
      <div className="resizable-body">{children}</div>
      <div
        className="resizable-grip"
        onPointerDown={onGripPointerDown}
        onDoubleClick={() => setH(initialHeight)}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize section"
        title="Drag up/down to resize (double-click to reset)"
      />
    </section>
  )
}
