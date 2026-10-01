import { useCallback, useEffect, useState } from 'react'
import Tracker from './Tracker.jsx'
import StoryEditor from './StoryEditor.jsx'
import ComicEditor from './ComicEditor.jsx'

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
// B2.5 Step 11.5a (FIFTH revision — the current one): the comic editor has
// TWO independent deltas (topDelta + bottomDelta; height = base + both).
// BOTH grips grow the section's height — the bottom grip at the bottom edge
// (normal flow pushes the page out at the bottom), the top grip with a
// parallel page scroll so the growth is visible (the top edge climbs under
// the pointer, the bottom edge stays put). Neither grip shifts the content
// above — that was the 4th revision's mechanism and the source of the top
// clipping / gapping. ResizableSection owns both deltas + the grips +
// persistence (gqsa.sectionHeight.<storageKey>, JSON {t, b}); App owns
// nothing about the section's size (the `.wrap` above is never shifted).

export default function App() {
  // { status: 'loading' | 'ok' | 'forbidden' | 'error', csrfToken?, emailTransport?, detail? }
  const [state, setState] = useState({ status: 'loading' })

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
  // the story editor. Step 11.5a (FIFTH revision) — the comic's grips live
  // entirely inside ResizableSection (both deltas grow its height; the top
  // grip scrolls the page so the growth is visible). App owns nothing about
  // the section's size — the `.wrap` above is never shifted.
  return (
    <>
      <div className="wrap">
        <h1>Admin — gqsa</h1>
        <p className="muted">
          Site owner only. The implementation tracker below is the single source of
          truth for what's built. The comic / story / media editors land in
          B2.5–B2.7, the announcements panel in B2.9.
        </p>
        <Tracker csrfToken={state.csrfToken} />
        <StoryEditor csrfToken={state.csrfToken} />
      </div>
      <ComicEditor csrfToken={state.csrfToken} />
      {/* Page-bottom nav (moved 2026-10-01: it sat between the story and comic
          editors — the user wants it at the bottom of the page, centred). */}
      <p style={{ marginTop: '26px', textAlign: 'center' }}>
        <a href="/dashboard">Dashboard</a> · <a href="/">Home</a> · <a href="/logout">Log out</a>
      </p>
    </>
  )
}
