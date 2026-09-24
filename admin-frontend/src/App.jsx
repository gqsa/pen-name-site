import { useCallback, useEffect, useState } from 'react'
import Tracker from './Tracker.jsx'
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
export default function App() {
  // { status: 'loading' | 'ok' | 'forbidden' | 'error', csrfToken?, emailTransport?, detail? }
  const [state, setState] = useState({ status: 'loading' })

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
  // The tracker lives in the 780px `.wrap` column; the comic editor is a SIBLING
  // of `.wrap` so it can use its own wider container (`.comic-editor`) for the
  // split view. Visually it still sits directly below the tracker.
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
        <p style={{ marginTop: '26px' }}>
          <a href="/dashboard">Dashboard</a> · <a href="/">Home</a> · <a href="/logout">Log out</a>
        </p>
      </div>
      <ComicEditor csrfToken={state.csrfToken} />
    </>
  )
}
