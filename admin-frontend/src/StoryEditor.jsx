import { useCallback, useEffect, useRef, useState } from 'react'

// B2.6 — the story editor — Step-1 shell (load / select / create + read-only body).
//
// Built up over the B2.6 steps on this shell (see b2-6.md for the pinned contract):
//   • Step 1 — load the story list from GET /api/admin/content, select one,
//     create one (title required; the server ALSO requires a non-empty body at
//     creation, so a new story seeds its body with its title — the story starts
//     with its title line and the owner then edits/pastes the real body), and
//     show the body read-only.
//   • Step 2 — the body becomes a textarea (paste/type) + a "Load text file"
//     button (hidden file input → file.text() → replaces the body).
//   • Step 3 — auto-save: ~600 ms debounce → ONE PUT /api/admin/stories/:id
//     { title, description, body } per edit burst; flush on story switch and
//     on unmount; blank-title guard (the server would otherwise store '').
//
// Layout: single column, rendered INSIDE the .wrap column in App.jsx (after the
// Tracker) — 780px is enough for a text editor, so unlike the comic editor this
// one does not need its own wider container.
//
// Data (B2.4 contract — pinned, don't re-derive; server.js L1198–1234):
//   • GET /api/admin/content (GET = CSRF-exempt)
//       → { stories, comics, pages, images, videos, counts }
//         stories: [{ id, title, description, body, publish_date, is_member, tier_id, created_at, updated_at }]
//   • POST /api/admin/stories  { title, body, … } → 201 { success, id }
//     title + body REQUIRED (400 otherwise); description/publish_date/is_member/tier_id optional.
//   • PUT /api/admin/stories/:id — PARTIAL: omitted fields keep the row's value;
//     description: null clears; tier_id: null explicitly clears (=== undefined check).
//     A blank title/body in the payload WOULD overwrite → the editor guards title.

export default function StoryEditor({ csrfToken }) {
  // stories: array (null until the first fetch lands) — the full story list.
  // selectedId: the id of the story being edited (a number, matching the DB id).
  const [stories, setStories] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // Step 2 — the working copy of the selected story: { title, description, body }.
  // Synced from `stories` when the SELECTION changes (not on every stories update —
  // that would clobber in-flight typing); null when nothing is selected.
  const [draft, setDraft] = useState(null)
  const draftForId = useRef(null)   // the story id the draft currently belongs to
  const fileRef = useRef(null)      // hidden <input type="file"> for the body upload
  const [loadingFile, setLoadingFile] = useState(false)

  useEffect(() => {
    if (selectedId === null) { draftForId.current = null; setDraft(null); return }
    if (draftForId.current === selectedId) return
    const s = stories.find(x => x.id === selectedId)
    draftForId.current = selectedId
    setDraft(s ? { title: s.title ?? '', description: s.description ?? '', body: s.body ?? '' } : null)
  }, [selectedId, stories])

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/content', { headers: { Accept: 'application/json' } })
      if (!res.ok) { setError(`content endpoint answered ${res.status}`); return }
      const data = await res.json()
      const list = Array.isArray(data.stories) ? data.stories : []
      setStories(list)
      // Default selection = the first story, or null if there are none. A reload
      // keeps a selection the owner already made (prev !== null).
      setSelectedId(prev => (prev !== null ? prev : (list.length ? list[0].id : null)))
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const createStory = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) { setError('Give the new story a title first.'); return }
    if (creating) return
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      // title + body are BOTH required at creation — seed the body with the
      // title (see the header note); the owner edits the body in Steps 2–3.
      const res = await fetch('/api/admin/stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title, body: title }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `create answered ${res.status}`)
      }
      const data = await res.json()
      setStories(prev => (prev === null
        ? [{ id: data.id, title, description: null, body: title }]
        : [...prev, { id: data.id, title, description: null, body: title }]))
      setSelectedId(data.id)
      setNewTitle('')
      setNotice(`Created “${title}”.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }, [newTitle, creating, csrfToken])

  // --- Step 2: "Load text file" — the file REPLACES the body ------------------
  // (the file IS the body; predictable). Reads the text with file.text() and
  // drops it straight into the draft (Step 3 makes that auto-save).
  const onFilePicked = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''   // let the same file be re-picked later
    if (!file) return
    if (selectedId === null) {
      setNotice(null)
      setError('Select or create a story first, then load its text file.')
      return
    }
    setLoadingFile(true)
    setError(null)
    setNotice(null)
    try {
      const text = await file.text()
      setDraft(d => (d ? { ...d, body: text } : d))
      setNotice(`Loaded ${text.length} character${text.length === 1 ? '' : 's'} from “${file.name || 'the file'}” into the body.`)
    } catch (err) {
      setError('Could not read that file — ' + err.message)
    } finally {
      setLoadingFile(false)
    }
  }, [selectedId])

  // --- Loading / error (before the first fetch lands) -------------------------
  if (stories === null) {
    if (error) {
      return (
        <section>
          <h2>Story editor</h2>
          <div className="panel panel--warn">
            <p className="error" style={{ marginTop: 0 }}>Couldn't load the story editor.</p>
            <p className="muted">{error}</p>
            <p><button onClick={() => load()}>Try again</button></p>
          </div>
        </section>
      )
    }
    return (
      <section>
        <h2>Story editor</h2>
        <p className="muted">Loading stories…</p>
      </section>
    )
  }

  const selected = stories.find(s => s.id === selectedId) || null

  return (
    <section>
      <h2>Story editor</h2>
      <p className="muted">
        Pick or create a story, then write its body — type, paste, or load a
        .txt file (landing in the next B2.6 steps).
      </p>

      {error && (
        <p className="error">
          {error}{' '}
          <button style={{ padding: '4px 10px' }} onClick={() => load()}>Reload</button>
        </p>
      )}
      {notice && <p className="success">{notice}</p>}

      <label htmlFor="story-select">Story</label>
      <select
        id="story-select"
        value={selectedId ?? ''}
        onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : null)}
      >
        {stories.length === 0 && <option value="">(no stories yet — create one below)</option>}
        {stories.map(s => (
          <option key={s.id} value={s.id}>{s.title}</option>
        ))}
      </select>

      <div className="row" style={{ marginTop: '12px' }}>
        <input
          type="text"
          value={newTitle}
          placeholder="New story title…"
          style={{ flex: '1 1 160px' }}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createStory() }}
        />
        <button onClick={createStory} disabled={creating}>
          {creating ? 'Creating…' : 'New story'}
        </button>
      </div>

      {selected && draft ? (
        <>
          <label htmlFor="story-title">Title</label>
          <input
            id="story-title"
            type="text"
            value={draft.title}
            onChange={e => setDraft(d => (d ? { ...d, title: e.target.value } : d))}
          />

          <label htmlFor="story-desc">Description (optional)</label>
          <input
            id="story-desc"
            type="text"
            value={draft.description}
            placeholder="Shown on the story's card, if at all…"
            onChange={e => setDraft(d => (d ? { ...d, description: e.target.value } : d))}
          />

          <h3 style={{ margin: '18px 0 4px' }}>
            <span>Body</span>
            <span className="muted" style={{ fontWeight: 400 }}> — {draft.body.length} characters</span>
            <span style={{ float: 'right' }}>
              <button style={{ padding: '4px 10px' }} onClick={() => fileRef.current?.click()} disabled={loadingFile}>
                {loadingFile ? 'Loading…' : 'Load text file'}
              </button>
            </span>
          </h3>
          <textarea
            rows={14}
            aria-label="Story body"
            placeholder="Write the story body here, paste text, or load a .txt file…"
            value={draft.body}
            onChange={e => setDraft(d => (d ? { ...d, body: e.target.value } : d))}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.text,text/plain"
            hidden
            onChange={onFilePicked}
          />
        </>
      ) : (
        <p className="muted">Select a story to edit it.</p>
      )}
    </section>
  )
}
