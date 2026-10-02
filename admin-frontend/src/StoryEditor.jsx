import { useCallback, useEffect, useRef, useState } from 'react'
import ResizableSection from './ResizableSection.jsx'

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
// Layout (B2.6r): a SIBLING of `.wrap` in App.jsx, in its own `.story-editor`
// container — SAME width as `.comic-editor` in both orientations (user
// follow-up 2026-10-01: portrait 1100px, landscape min(1600px, 96vw) — the
// body textarea uses the width). The main branch is the generic RESIZABLE
// section — the CANONICAL 11.5a 5th-revision grip model, the same one the
// comic editor uses: grips on BOTH edges (both grow the section's height;
// the top grip scrolls the page so the growth is visible) + the height
// persisted to localStorage (gqsa.sectionHeight.storyEditor) + double-click
// a grip to reset. initialHeight 880 ≈ the section's natural height before
// B2.6r (portrait keeps today's look); the body's textarea flex-fills the
// section (index.css), so the grips visibly resize the body.
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

  // Step 3 — auto-save (the pattern = the ComicEditor caption debouncer,
  // adapted to a single-story draft): ~600 ms debounce → ONE PUT per edit
  // burst; flush on story switch and on unmount (a switch must never lose
  // the last burst). `save` = null | 'saving' | 'saved' | 'error' (the cue
  // in the theme); `saveError` = the message behind an 'error'.
  // `dirtyVersion` = 0 while the draft is clean, bumped on every edit — a
  // save only clears it if nothing was edited while it was in flight, so a
  // burst that lands mid-save still gets saved.
  const [save, setSave] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const saveTimer = useRef(null)    // the pending debounce timeout
  const dirtyVersion = useRef(0)
  const draftRef = useRef(null)     // always the latest draft — the flush paths must not trust a stale closure
  useEffect(() => { draftRef.current = draft }, [draft])

  useEffect(() => {
    if (selectedId === null) { draftForId.current = null; setDraft(null); return }
    if (draftForId.current === selectedId) return
    const s = stories.find(x => x.id === selectedId)
    draftForId.current = selectedId
    dirtyVersion.current = 0   // a fresh draft (from the server) is clean — no save owed
    setDraft(s ? { title: s.title ?? '', description: s.description ?? '', body: s.body ?? '' } : null)
  }, [selectedId, stories])

  // --- Step 3: auto-save ------------------------------------------------------
  // The PUT payload for a draft — the server's PARTIAL semantics (server.js
  // L1258: `b.title ?? row.title` …): a field OMITTED keeps the row's value,
  // so the blank-title guard = OMIT the title (sending '' would store '' and
  // clobber the stored title). description / body always go — an explicit ''
  // there is a real clear (the owner emptied the field).
  const buildPayload = (values) => {
    const payload = { description: values.description ?? '', body: values.body ?? '' }
    if ((values.title ?? '').trim() !== '') payload.title = values.title
    return payload
  }

  const saveNow = useCallback(async (id, values, version) => {
    setSave('saving')
    setSaveError(null)
    try {
      const res = await fetch(`/api/admin/stories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(buildPayload(values)),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `save answered ${res.status}`)
      }
      if (dirtyVersion.current === version) dirtyVersion.current = 0
      // Keep the story list (the select dropdown) in sync with what was saved.
      const stored = buildPayload(values)
      setStories(prev => (prev === null ? prev : prev.map(s => (s.id === id
        ? { ...s, title: stored.title ?? s.title, description: stored.description, body: stored.body }
        : s))))
      setSave('saved')
    } catch (err) {
      setSave('error')
      setSaveError(err.message)
    }
  }, [csrfToken])

  // ~600 ms debounce: ONE PUT per edit burst (no save button by design). Only
  // a dirty draft schedules a save (a fresh selection loads clean).
  useEffect(() => {
    if (draft === null || dirtyVersion.current === 0) return undefined
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      const v = dirtyVersion.current
      if (v === 0) return
      if (draftForId.current !== null) void saveNow(draftForId.current, draftRef.current, v)
    }, 600)
  }, [draft, saveNow])

  // The 'saved' cue is a MOMENT, not a state (the ComicEditor caption
  // pattern) — it fades out after ~3 s. Only a FAILED save lingers.
  useEffect(() => {
    if (save !== 'saved') return undefined
    const t = setTimeout(() => setSave(null), 3000)
    return () => clearTimeout(t)
  }, [save])

  // Switching stories FLUSHES the outgoing story's pending burst first — a
  // switch must never lose the last burst (an in-flight save, if any, already
  // owns its captured copy).
  const onStorySelect = useCallback((e) => {
    const next = e.target.value ? Number(e.target.value) : null
    if (next === selectedId) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (dirtyVersion.current > 0 && draftForId.current !== null && draftRef.current) {
      void saveNow(draftForId.current, draftRef.current, dirtyVersion.current)
    }
    setSelectedId(next)
  }, [selectedId, saveNow])

  // Unmount: flush a pending burst (best effort — keepalive lets the request
  // outlive the unmount; a body over the 64 KB keepalive limit just drops).
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (dirtyVersion.current === 0 || draftForId.current === null || !draftRef.current) return
    const id = draftForId.current
    fetch(`/api/admin/stories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(buildPayload(draftRef.current)),
      keepalive: true,
    }).catch(() => {})
    dirtyVersion.current = 0
  }, [csrfToken])

  // One edit = one working-copy update + a dirty bump (the debounce effect
  // above sees the new draft and schedules the burst's save). Re-editing also
  // clears a stale 'error' cue (the ComicEditor caption pattern).
  const updateDraft = useCallback((patch) => {
    setDraft(d => (d ? { ...d, ...patch } : d))
    dirtyVersion.current += 1
    if (save === 'error') setSave(null)
  }, [save])

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
      updateDraft({ body: text })   // the dirty bump schedules the auto-save
      setNotice(`Loaded ${text.length} character${text.length === 1 ? '' : 's'} from “${file.name || 'the file'}” into the body.`)
    } catch (err) {
      setError('Could not read that file — ' + err.message)
    } finally {
      setLoadingFile(false)
    }
  }, [selectedId, updateDraft])

  // --- Loading / error (before the first fetch lands) -------------------------
  // The loading / error branches stay plain <section>s (the comic editor's
  // pattern) — but in the `.story-editor` container so they keep the 1100px
  // portrait width (the comic editor's width) now that the section sits
  // outside `.wrap`.
  if (stories === null) {
    if (error) {
      return (
        <section className="story-editor">
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
      <section className="story-editor">
        <h2>Story editor</h2>
        <p className="muted">Loading stories…</p>
      </section>
    )
  }

  const selected = stories.find(s => s.id === selectedId) || null

  // B2.6r — the CANONICAL 11.5a 5th-revision grip model (the same
  // ResizableSection the comic editor mounts): both grips grow the section's
  // height, the top grip scrolls the page so the growth is visible, the
  // deltas persist to localStorage under storageKey, double-click a grip
  // resets. initialHeight 880 ≈ the section's natural pre-B2.6r height, so
  // portrait keeps today's look; minHeight 620 keeps the flex-filled body
  // textarea usable (≥ ~150px) when the section is shrunk.
  return (
    <ResizableSection
      className="story-editor"
      storageKey="storyEditor"
      initialHeight={880}
      minHeight={620}
      // B2.8 — the minimise affordance (title shown on the collapsed bar).
      title="Story editor"
    >
      <h2>Story editor</h2>
      <p className="muted">
        Pick or create a story, then write its body — type, paste, or load a
        .txt file. It auto-saves as you edit (no save button).
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
        onChange={onStorySelect}
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
            onChange={e => updateDraft({ title: e.target.value })}
          />

          <label htmlFor="story-desc">Description (optional)</label>
          <input
            id="story-desc"
            type="text"
            value={draft.description}
            placeholder="Shown on the story's card, if at all…"
            onChange={e => updateDraft({ description: e.target.value })}
          />

          <h3 style={{ margin: '18px 0 4px' }}>
            <span>Body</span>
            <span className="muted" style={{ fontWeight: 400 }}> — {draft.body.length} characters</span>
            {save === 'saving' ? (
              <span className="caption-status" style={{ display: 'inline-block', margin: '0 0 0 10px', verticalAlign: 'middle', fontSize: 12 }} role="status">
                Saving…
              </span>
            ) : null}
            {save === 'saved' ? (
              <span className="caption-status" style={{ display: 'inline-block', margin: '0 0 0 10px', verticalAlign: 'middle', fontSize: 12 }} role="status">
                Saved
              </span>
            ) : null}
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
            onChange={e => updateDraft({ body: e.target.value })}
          />
          {save === 'error' && (
            <p className="caption-status error" role="alert">
              Save failed — {saveError} (your text is still here; the next edit re-sends it)
            </p>
          )}
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
    </ResizableSection>
  )
}
