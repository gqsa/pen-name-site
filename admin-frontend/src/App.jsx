import { useCallback, useEffect, useState } from 'react'
import Tracker from './Tracker.jsx'
import StoryEditor from './StoryEditor.jsx'
import ComicEditor from './ComicEditor.jsx'
import { readStoredDeltas } from './ResizableSection.jsx'

// B2.2 — the admin shell.
//
// The SERVER is the only gate (isAdmin in server.js — the SPA HTML and every
// /api/admin/* route answer non-admins with 403). The shell's job at boot is
// to fetch the session's CSRF token from /api/admin/boot; every state-changing
// POST this app ever makes sends it as the X-CSRF-Token header (the same
// posture as the EJS fetch() calls).
//
// Today this is a placeholder shell: the implementation tracker (B2.3), the
// comic / story / media editors (B2.5–B2.7) and the announcements panel
// (B2.9) all land inside it.
//
// B2.5 Step 11.5a (fourth revision — the current one): the comic editor has
// TWO independent deltas (topDelta + bottomDelta; height = base + both).
// The BOTTOM grip only changes the section's height — normal flow pushes the
// page out at the bottom, the section's top edge stays put. The TOP grip
// moves the section's TOP edge with the pointer and keeps its BOTTOM edge
// fixed: the section can't pull itself up out of flow (its own negative
// margin loses to the gap's margin collapsing), so THIS app shifts the
// content above it — this `.wrap` — up by topDelta: the wrap's margin-top =
// baseMargin − topDelta (baseMargin measured once at mount; a bare −Δ margin
// would overshoot by the whole base margin). Neither grip ever changes any
// other section's HEIGHT — the sections above only MOVE with the wrap.
// ResizableSection owns both deltas + the grips + persistence
// (gqsa.sectionHeight.<storageKey>, JSON {t, b}); App only owns the
// content-above shift + reports topDelta back.

export default function App() {
  // { status: 'loading' | 'ok' | 'forbidden' | 'error', csrfToken?, emailTransport?, detail? }
  const [state, setState] = useState({ status: 'loading' })

  // Step 11.5a (fourth revision) — the comic editor's topDelta, owned HERE
  // because only this component can shift the content above it (the `.wrap`).
  // Initialized from the SAME storage read the section uses (the section
  // never pushes it), so the first paint is already shifted — no jump on
  // load when a topDelta is stored.
  const [comicTop, setComicTop] = useState(() =>
    readStoredDeltas('comicEditor', 720, 480, 1400).t,
  )
  // The wrap's base margin-top, measured once at mount (the `.wrap` CSS
  // value — 40px today — without hardcoding it). null until measured.
  const [wrapBaseMargin, setWrapBaseMargin] = useState(null)
  const wrapRef = useCallback((el) => {
    if (el && wrapBaseMargin === null) {
      const m = parseFloat(getComputedStyle(el).marginTop)
      setWrapBaseMargin(Number.isFinite(m) ? m : 0)
    }
  }, [wrapBaseMargin])
  // margin-top = base − topDelta shifts the wrap (and everything below it)
  // by EXACTLY topDelta; at 0 the CSS margin applies untouched.
  const wrapStyle = comicTop !== 0 && wrapBaseMargin !== null
    ? { marginTop: (wrapBaseMargin - comicTop) + 'px' }
    : undefined

  // Step 11.5a (second revision) — one-time cleanup: that revision stored
  // the story-side boundary height under this key and no longer has one;
  // drop the stale value so it can't confuse anyone inspecting localStorage.
  useEffect(() => {
    try { window.localStorage.removeItem('gqsa.storyBodyHeight') } catch { /* nothing to clear */ }
  }, [])

  const boot = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const res = await fetch('/api/admin/boot', { headers: { Accept: 'application/json' } })
      if (res.status === 403) { setState({ status: 'forbidden' }); return }
      if (!res.ok) { setState({ status: 'error', detail: `boot endpoint answered ${res.status}` }); return }
      const data = await res.json()
      if (!data.isAdmin || typeof data.csrfToken !== 'string') {
        setState({ status: 'error', detail: 'boot endpoint returned no CSRF token' })
        return
      }
      setState({ status: 'ok', csrfToken: data.csrfToken, emailTransport: data.emailTransport })
    } catch (err) {
      setState({ status: 'error', detail: err.message })
    }
  }, [])

  useEffect(() => { boot() }, [boot])

  if (state.status === 'loading') {
    return <div className="wrap"><h1>Admin — gqsa</h1><p className="muted">Loading…</p></div>
  }

  if (state.status === 'forbidden') {
    return (
      <div className="wrap">
        <h1>Admin — gqsa</h1>
        <div className="panel panel--warn">
          <p className="error" style={{ marginTop: 0 }}>Not admin.</p>
          <p className="muted">
            The admin area is only for the site owner. Log in with the owner account, then come back.
          </p>
          <p><a className="btn" href="/login">Go to login</a></p>
        </div>
        <p style={{ marginTop: '26px' }}><a href="/">Home</a> · <a href="/logout">Log out</a></p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="wrap">
        <h1>Admin — gqsa</h1>
        <div className="panel panel--warn">
          <p className="error" style={{ marginTop: 0 }}>Couldn't boot the admin area.</p>
          <p className="muted">{state.detail}</p>
          <p><button onClick={() => boot()}>Try again</button></p>
        </div>
      </div>
    )
  }

  // status === 'ok' — the shell is live and the CSRF token is in hand.
  // The tracker + story editor live in the 780px `.wrap` column; the comic
  // editor is a SIBLING of `.wrap` so it can use its own wider container
  // (`.comic-editor`) for the split view. Visually it sits directly below
  // the story editor. The `.wrap` is the CONTENT ABOVE the comic section —
  // the comic's top grip shifts it via `wrapStyle` (Step 11.5a, fourth
  // revision; `wrapRef` measures its base margin once).
  return (
    <>
      <div className="wrap" ref={wrapRef} style={wrapStyle}>
        <h1>Admin — gqsa</h1>
        <p className="muted">
          Site owner only. The implementation tracker below is the single source of
          truth for what's built. The comic / story / media editors land in
          B2.5–B2.7, the announcements panel in B2.9.
        </p>
        <Tracker csrfToken={state.csrfToken} />
        <StoryEditor csrfToken={state.csrfToken} />
        <p style={{ marginTop: '26px' }}>
          <a href="/dashboard">Dashboard</a> · <a href="/">Home</a> · <a href="/logout">Log out</a>
        </p>
      </div>
      <ComicEditor
        csrfToken={state.csrfToken}
        topDelta={comicTop}
        onTopDeltaChange={setComicTop}
      />
    </>
  )
}
