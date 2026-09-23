import { useCallback, useEffect, useState } from 'react'

// B2.3 — the implementation tracker (ported out of views/admin.ejs; that EJS
// page is the no-build fallback and retires in B2.9).
//
// Data: GET /api/admin/roadmap (admin-gated) — the whole roadmap in
// sort_order; grouped client-side by phase A/B/C (same display as the EJS
// page: "step — label", done rows full-ink, pending rows muted).
// Mutations: POST /admin/toggle-roadmap with the X-CSRF-Token header (the
// global CSRF middleware in server.js covers every POST; the token came from
// /api/admin/boot via the shell).
// UX: optimistic flip — the checkbox answers instantly (like the EJS
// onchange) and rolls back with an error line if the server disagrees.
export default function Tracker({ csrfToken }) {
  // items: [{ id, phase, step, label, done }] — null until the first fetch lands
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/roadmap', { headers: { Accept: 'application/json' } })
      if (!res.ok) { setError(`roadmap endpoint answered ${res.status}`); return }
      const data = await res.json()
      setItems(data.items)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = useCallback(async (id) => {
    if (busyId !== null) return
    const row = items.find(r => r.id === id)
    if (!row) return
    const wasDone = !!row.done
    setBusyId(id)
    setError(null)
    // Optimistic flip.
    setItems(items.map(r => r.id === id ? { ...r, done: wasDone ? 0 : 1 } : r))
    try {
      const res = await fetch('/admin/toggle-roadmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `toggle answered ${res.status}`)
      }
    } catch (err) {
      // Roll the checkbox back to what it was, and show what went wrong.
      setItems(prev => prev.map(r => r.id === id ? { ...r, done: wasDone ? 1 : 0 } : r))
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }, [items, csrfToken, busyId])

  if (items === null) {
    if (error) {
      return (
        <div className="panel panel--warn">
          <p className="error" style={{ marginTop: 0 }}>Couldn't load the tracker.</p>
          <p className="muted">{error}</p>
          <p><button onClick={() => load()}>Try again</button></p>
        </div>
      )
    }
    return <p className="muted">Loading tracker…</p>
  }

  const done = items.filter(r => r.done).length
  const phases = ['A', 'B', 'C']
    .map(phase => [phase, items.filter(r => r.phase === phase)])
    .filter(([, phaseItems]) => phaseItems.length > 0)

  return (
    <section>
      <h2>
        Implementation tracker{' '}
        <span className="muted" style={{ fontWeight: 400 }}>({done} / {items.length} done)</span>
      </h2>
      {phases.map(([phase, phaseItems]) => (
        <div key={phase}>
          <h3 style={{ marginBottom: '4px' }}>Phase {phase}</h3>
          <ul className="checklist">
            {phaseItems.map(item => (
              <li key={item.id}>
                <input
                  type="checkbox"
                  id={`rm-${item.id}`}
                  data-id={item.id}
                  checked={!!item.done}
                  disabled={busyId !== null}
                  onChange={() => toggle(item.id)}
                />
                <label
                  htmlFor={`rm-${item.id}`}
                  style={{ margin: 0, color: item.done ? 'inherit' : 'var(--muted)' }}
                >
                  <strong>{item.step}</strong> — {item.label}
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {error && (
        <p className="error">
          {error}{' '}
          <button style={{ padding: '4px 10px' }} onClick={() => load()}>Reload</button>
        </p>
      )}
    </section>
  )
}
