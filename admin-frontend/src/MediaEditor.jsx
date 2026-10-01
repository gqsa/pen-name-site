import { useCallback, useEffect, useRef, useState } from 'react'
import ResizableSection from './ResizableSection.jsx'

// B2.7 — the image / video upload editor.
//
// One section, TWO tabs (Images | Videos) — the two entities share the upload
// pipeline, the title / caption / member-flag fields, and only VIDEOS carry a
// description (server.js: the images table has no `description` column; the
// videos table does). Both tables carry `is_member` (0 = free, 1 = members-only;
// the B8 reader gates on it) — the per-item "Members only" checkbox. The active
// tab is also the upload `kind` and the drop/paste filter, so a file only
// lands where it belongs.
//
// Layout (B2.6r + the B2.7 row's grip ask): a SIBLING of `.wrap` in App.jsx,
// in its own `.media-editor` container — the SAME width as the story / comic
// editors in both orientations (portrait 1100px, landscape min(1600px, 96vw);
// the index.css media block). The main branch is the generic RESIZABLE section
// — the CANONICAL 11.5a 5th-revision grip model, the same ResizableSection the
// story and comic editors mount: grips on BOTH edges (both grow the section's
// height; the top grip scrolls the page so the growth is visible) + the height
// persisted to localStorage (gqsa.sectionHeight.mediaEditor) + double-click a
// grip to reset. A second `.section-divider` hairline sits between the comic
// and media sections (App.jsx) so the grip zones never crowd.
//
// Data (B2.4 contract — pinned, don't re-derive; server.js L1418–1493):
//   • GET /api/admin/content (GET = CSRF-exempt)
//       → { stories, comics, pages, images, videos, counts }
//         images: [{ id, title, caption, file_path, publish_date, is_member, tier_id, created_at, updated_at }]
//         videos: same + description
//   • POST /api/admin/upload — multipart `kind` THEN `file` (multer walks the
//     stream in order); kind = 'images' | 'videos' (else 'misc'). → { file_path }
//     The file lands under /uploads/{kind}/<uuid>/<originalname>.
//   • POST /api/admin/images   { title, caption, file_path, … } → 201 { success, id }
//     POST /api/admin/videos   { title, description, caption, file_path, … }
//     title + file_path REQUIRED at creation (400 otherwise).
//   • PUT /api/admin/images/:id / /api/admin/videos/:id — PARTIAL, but with
//     different per-field semantics (the payload below encodes them):
//       title        — `b.title ?? row.title`        → a BLANK title would store
//                    '' and clobber the stored one, so OMIT it when blank.
//       caption      — `b.caption === undefined ? row : b.caption`
//                    → an EXPLICIT null CLEARS it. Send blank → null.
//       description  — `b.description ?? row.description` (videos ONLY)
//                    → absent/null KEEPS the current value; '' CLEARS it.
//                    So ALWAYS send the raw value ('' = a real clear).
//       is_member    — `(b.is_member ?? row.is_member) ? 1 : 0` → a plain
//                    0/1 flag (0 = free, 1 = members-only); ALWAYS send it.
//   • DELETE /api/admin/{kind}/:id — removes the DB ROW ONLY; the file stays on
//     disk (B13's file manager cleans orphans later).
//
// Input paths (the ComicEditor's three, mirrored):
//   • DRAG a file anywhere in the section → append it (section is the
//     catch-all; the drop zone stays the visual anchor + ring).
//   • Ctrl+V (a document-level `paste` listener — the RELIABLE path that
//     surfaces OS file copies) → append the matching media.
//   • SINGLE CLICK the drop zone → paste via navigator.clipboard.read()
//     (secondary; does not surface OS file copies) — deferred 250 ms behind a
//     timer a double-click cancels.
//   • DOUBLE CLICK the drop zone → the hidden <input type="file" multiple>
//     OS picker.
// All four funnel into addFiles() — sequential uploads (the server's multer is
// single-file), each: upload → POST {kind} { title, file_path } → append the
// row to the local list.
//
// Auto-save (the StoryEditor / ComicEditor caption pattern, per item): the
// inputs are controlled by the item's fields, so typing updates the local
// list immediately; a per-item-id debounce (~600 ms) then fires ONE PUT per
// edit burst — no save button. A 'Saving…' / 'Saved' (fades ~3 s) / 'Save
// failed — …' cue sits beside each item's Delete. Editing clears a stale
// error. The save reads from refs (always the latest list) and the KIND is
// captured at schedule time, so a tab switch mid-debounce still saves to the
// correct endpoint + list.

// --- Upload / naming helpers (module-level, no hooks) -------------------------

// The server saves files under their ORIGINALNAME (server.js multer `filename`)
// and express.static infers the MIME type from the extension — so a name
// without an extension (a raw clipboard blob arrives as `filename="blob"`)
// would be served with no media content type. Derive a sensible extension from
// the MIME type when we have to name a blob ourselves (ComicEditor's
// extForImageType, generalised so it also handles video types: mp4 → mp4,
// quicktime → quicktime, webm → webm).
function extForType(mime) {
  const sub = String(mime).split('/')[1] || ''
  if (sub === 'jpeg') return 'jpg'
  if (/^[a-z0-9]+$/.test(sub)) return sub
  return 'media'
}

// The FILE NAME for a card's muted line (the last path segment of the server
// file_path, e.g. /uploads/images/<uuid>/photo.png → "photo.png"). The uuid
// folder is opaque, so the owner's own file name is what they recognise.
function fileNameOf(file_path) {
  const segs = String(file_path || '').split('/').filter(Boolean)
  return segs.length ? segs[segs.length - 1] : 'media'
}

// A DEFAULT TITLE from the file name (new items are created with this until the
// owner renames them): strip the last extension, turn dashes/underscores into
// spaces, collapse runs. "my-photo_v2.png" → "my photo v2".
function titleFromFileName(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '')
  const t = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t || 'untitled'
}

// THE upload call (the house pattern — copied shape, `kind` BEFORE `file`,
// no Content-Type: the browser sets the multipart boundary).
async function uploadMedia(file, kind, csrfToken) {
  const fd = new FormData()
  fd.append('kind', kind)
  fd.append('file', file)
  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    body: fd,   // the multipart body itself — without this the request goes out empty → 400 "No file field"
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `upload answered ${res.status}`)
  }
  return res.json()
}

// The PARTIAL PUT payload for one item — encodes the three per-field semantics
// (see the header). `kind` = 'images' | 'videos'.
function buildPayload(kind, item) {
  const payload = {}
  // title — only if non-blank (a blank would store '' and clobber the stored title).
  if ((item.title ?? '').trim() !== '') payload.title = item.title
  // caption — always send; blank → null (an explicit null CLEARS the server caption).
  payload.caption = (item.caption ?? '').trim() === '' ? null : item.caption
  // is_member — plain 0/1 (0 = free, 1 = members-only); always send the current
  // flag so a toggle lands (the server stores `(b.is_member ?? row.is_member) ? 1 : 0`).
  payload.is_member = item.is_member ? 1 : 0
  if (kind === 'videos') {
    // description — always send the RAW value ('' clears; null would KEEP).
    payload.description = item.description ?? ''
  }
  return payload
}

// Step-13 disambiguation (ComicEditor's helper): true only for an OS file drag
// (dataTransfer.types includes 'Files') — never for an internal drag. Pure, so
// safe in a handler without re-binding.
function dragHasFiles(e) {
  const types = e && e.dataTransfer && e.dataTransfer.types
  if (!types) return false
  return Array.from(types).some(t => String(t).toLowerCase() === 'files')
}

export default function MediaEditor({ csrfToken }) {
  // kind — the ACTIVE tab ('images' | 'videos'); also the upload `kind` and the
  // drop/paste filter. images / videos — each list (null until the first fetch
  // lands); both are loaded at boot so switching tabs is instant.
  const [kind, setKind] = useState('images')
  const [images, setImages] = useState(null)
  const [videos, setVideos] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // Upload pipeline state (the ComicEditor's dropzone trio).
  const [uploading, setUploading] = useState(false)   // UI flag (drives the busy look)
  const [uploadMsg, setUploadMsg] = useState('')      // "Uploading i/N…"
  const [dragActive, setDragActive] = useState(false) // drag-over ring
  const fileInputRef = useRef(null)                   // hidden <input type="file">
  const clickTimer = useRef(null)                     // single-vs-double-click disambiguation
  const uploadingRef = useRef(false)                  // authoritative in-flight guard (ref = always current)

  // Per-item auto-save state (the ComicEditor caption pattern, per item id).
  const saveTimers = useRef({})   // id → pending debounce timeout
  const fadeTimers = useRef({})   // id → 'Saved' fade timeout
  const [saveStatus, setSaveStatus] = useState({})    // id → 'saving' | 'saved' | 'error'
  const [saveErrors, setSaveErrors] = useState({})    // id → the message behind an 'error'

  // Refs that always point at the latest data — the debounce paths (which fire
  // later, possibly after a tab switch) must not trust a stale closure.
  const kindRef = useRef(kind)
  useEffect(() => { kindRef.current = kind }, [kind])
  const imagesRef = useRef(images)
  useEffect(() => { imagesRef.current = images }, [images])
  const videosRef = useRef(videos)
  useEffect(() => { videosRef.current = videos }, [videos])

  // Clear pending timers if the component unmounts early (they'd fire into the
  // void). One effect for all three.
  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
    Object.values(saveTimers.current).forEach(t => clearTimeout(t))
    Object.values(fadeTimers.current).forEach(t => clearTimeout(t))
  }, [])

  const list = kind === 'images' ? images : videos
  const setList = kind === 'images' ? setImages : setVideos

  // --- Load -------------------------------------------------------------------
  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/content', { headers: { Accept: 'application/json' } })
      if (!res.ok) { setError(`content endpoint answered ${res.status}`); return }
      const data = await res.json()
      setImages(Array.isArray(data.images) ? data.images : [])
      setVideos(Array.isArray(data.videos) ? data.videos : [])
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // --- Auto-save (per item) ----------------------------------------------------
  // The 'Saved' cue is a MOMENT, not a state (the ComicEditor caption pattern)
  // — it fades out after ~3 s. A smart guard: only clear if it is STILL 'saved'
  // (a newer 'saving'/'error' that overwrote it is left alone).
  const scheduleFade = useCallback((id) => {
    const timers = fadeTimers.current
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id] }
    timers[id] = setTimeout(() => {
      delete timers[id]
      setSaveStatus(prev => (prev[id] === 'saved' ? { ...prev, [id]: null } : prev))
    }, 3000)
  }, [])

  // ONE save for an item. `k` is the item's kind, captured at schedule time (NOT
  // read at fire time) — so a tab switch mid-debounce still hits the correct
  // endpoint + list. The item is read from the matching ref (always latest).
  const saveItem = useCallback(async (id, k) => {
    const src = k === 'images' ? imagesRef.current : videosRef.current
    const item = Array.isArray(src) ? src.find(it => it.id === id) : null
    if (!item) return
    setSaveStatus(prev => ({ ...prev, [id]: 'saving' }))
    setSaveErrors(prev => { const n = { ...prev }; delete n[id]; return n })
    try {
      const res = await fetch(`/api/admin/${k}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(buildPayload(k, item)),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `save answered ${res.status}`)
      }
      setSaveStatus(prev => ({ ...prev, [id]: 'saved' }))
      scheduleFade(id)
    } catch (err) {
      setSaveStatus(prev => ({ ...prev, [id]: 'error' }))
      setSaveErrors(prev => ({ ...prev, [id]: err.message }))
    }
  }, [csrfToken, scheduleFade])

  // One edit = one working-copy update + a per-item debounce. `k` is captured
  // now (the active tab = the item's kind) and passed to saveItem at fire time.
  const updateItem = useCallback((id, field, value) => {
    const k = kindRef.current
    const setter = k === 'images' ? setImages : setVideos
    setter(prev => (Array.isArray(prev) ? prev.map(it => (it.id === id ? { ...it, [field]: value } : it)) : prev))
    if (saveStatus[id] === 'error') setSaveStatus(prev => ({ ...prev, [id]: null })) // re-editing clears the stale error
    const timers = saveTimers.current
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id] }
    timers[id] = setTimeout(() => {
      delete timers[id]
      saveItem(id, k)
    }, 600)
  }, [saveStatus, saveItem])

  // --- Upload pipeline (all four input paths funnel here) ----------------------
  // Sequential on purpose: the server's multer is single-file. For each file
  // matching the ACTIVE tab's kind:
  //   1. uploadMedia(file, kind) → { file_path }
  //   2. POST /api/admin/{kind} { title, file_path } → 201 { success, id }
  //   3. append the row to the local list (the card appears immediately).
  // Any failure stops the batch — a half-uploaded set is reported, not hidden.
  const addFiles = useCallback(async (files) => {
    const k = kindRef.current
    if (uploadingRef.current) {
      setNotice(null)
      setError('An upload is already in progress — wait for it to finish.')
      return
    }
    const prefix = k === 'images' ? 'image/' : 'video/'
    const noun = k === 'images' ? 'image' : 'video'
    const list0 = Array.from(files).filter(f => f && (f.type || '').startsWith(prefix))
    if (list0.length === 0) {
      setNotice(null)
      setError(`No ${noun} files in that batch — only ${noun} files are added on the ${k} tab.`)
      return
    }
    uploadingRef.current = true
    setUploading(true)
    setError(null)
    setNotice(null)
    let inserted = 0
    try {
      for (let i = 0; i < list0.length; i += 1) {
        setUploadMsg(`Uploading ${i + 1}/${list0.length} — ${list0[i].name || noun}…`)
        const up = await uploadMedia(list0[i], k, csrfToken)
        const title = titleFromFileName(list0[i].name || up.originalName || 'media')
        const res = await fetch(`/api/admin/${k}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ title, file_path: up.file_path }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `create answered ${res.status}`)
        }
        const created = await res.json()
        const now = Date.now()
        const row = {
          id: created.id, title, caption: null,
          description: null,   // videos start blank (images have no such column)
          file_path: up.file_path, publish_date: now,
          is_member: 0, tier_id: null, created_at: now, updated_at: now,
        }
        if (k === 'images') setImages(prev => [...prev, row])
        else setVideos(prev => [...prev, row])
        inserted += 1
      }
      setNotice(`Added ${inserted} ${noun}${inserted === 1 ? '' : 's'}.`)
    } catch (err) {
      setError(err.message + (inserted > 0
        ? ` — ${inserted}/${list0.length} ${noun}(s) saved before the failure; the rest were not added.`
        : ''))
    } finally {
      uploadingRef.current = false
      setUploading(false)
      setUploadMsg('')
    }
  }, [csrfToken])

  // --- Input path 1: click-to-paste (navigator.clipboard.read — secondary) -----
  // A blob has no name, so wrap it in a File with a proper name + extension
  // (extForType — the server saves by originalname). NOTE: this path does NOT
  // surface OS file copies (see onPasteEvent below — that one does); it is the
  // single-click convenience only.
  const doPaste = useCallback(async () => {
    if (uploadingRef.current) {
      setNotice(null)
      setError('An upload is already in progress — wait for it to finish.')
      return
    }
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      setNotice(null)
      setError('Clipboard read isn’t available in this browser — drag the file in, or double-click the dropzone to pick files.')
      return
    }
    try {
      const k = kindRef.current
      const prefix = k === 'images' ? 'image/' : 'video/'
      const items = await navigator.clipboard.read()
      const files = []
      for (let i = 0; i < items.length; i += 1) {
        const type = Array.from(items[i].types).find(t => t.startsWith(prefix))
        if (!type) continue
        const blob = await items[i].getType(type)
        files.push(new File([blob], `pasted-${Date.now()}-${i + 1}.${extForType(type)}`, { type }))
      }
      if (files.length === 0) {
        setNotice(null)
        setError(`No ${k} on the clipboard — copy one first, then Ctrl+V in the editor, or drag one in / double-click to pick files.`)
        return
      }
      await addFiles(files)
    } catch (err) {
      setNotice(null)
      setError('Couldn’t read the clipboard (permission denied or empty) — drag the file in, or double-click the dropzone to pick files.')
    }
  }, [addFiles])

  // --- Input path 2: Ctrl+V (the RELIABLE clipboard path) ----------------------
  // The DOM `paste` event's `clipboardData.items` DOES expose OS file copies
  // (each item's `getAsFile()`), so this is the primary paste path. Attached to
  // `document` (not the section): a click on the drop zone leaves focus on
  // <body> — a section-scoped onPaste would never see a subsequent Ctrl+V.
  // Non-media pastes (e.g. text into a caption input) are left alone: we only
  // act when the paste actually carries a matching media file, otherwise we
  // return WITHOUT preventDefault so the default paste proceeds.
  const onPasteEvent = useCallback((e) => {
    if (uploadingRef.current) return
    const k = kindRef.current
    const prefix = k === 'images' ? 'image/' : 'video/'
    const items = (e.clipboardData && e.clipboardData.items)
      ? Array.from(e.clipboardData.items)
      : []
    const files = []
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      if (it.kind !== 'file') continue
      const f = (typeof it.getAsFile === 'function') ? it.getAsFile() : null
      if (f && (f.type || '').startsWith(prefix)) files.push(f)
    }
    if (files.length === 0) return   // not a matching-media paste → let it through (caption text, etc.)
    e.preventDefault()
    addFiles(files)
  }, [addFiles])

  // Register the document-level paste listener (re-attaches when deps change;
  // the disposer removes it on unmount).
  useEffect(() => {
    document.addEventListener('paste', onPasteEvent)
    return () => document.removeEventListener('paste', onPasteEvent)
  }, [onPasteEvent])

  // --- Input paths 3 + 4: single click = paste, double click = picker ---------
  // A double-click also fires TWO `click` events, so a single click is deferred
  // behind a 250 ms timer the double-click cancels (the ComicEditor's model).
  const onZoneClick = useCallback(() => {
    if (clickTimer.current) return
    clickTimer.current = setTimeout(() => { clickTimer.current = null; doPaste() }, 250)
  }, [doPaste])

  const onZoneDoubleClick = useCallback(() => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null }
    fileInputRef.current?.click()
  }, [])

  const onFilePicked = useCallback((e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''   // let the same file be re-picked later
    if (files.length) addFiles(files)
  }, [addFiles])

  // --- Section-level file drop (the SECTION is the catch-all) ------------------
  // A file dragged from the OS over ANYWHERE in the section appends it to the
  // ACTIVE tab; the drop zone stays the visual anchor + ring. preventDefault on
  // dragover is REQUIRED to allow the drop.
  const onSectionDragOver = useCallback((e) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }, [])

  const onSectionDragLeave = useCallback((e) => {
    if (!dragHasFiles(e)) return
    // dragleave fires when the pointer moves onto a child — ignore that.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setDragActive(false)
  }, [])

  const onSectionDrop = useCallback((e) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) addFiles(files)
  }, [addFiles])

  // --- Delete -----------------------------------------------------------------
  // DELETE removes the DB ROW ONLY — the file stays on disk (B13's file manager
  // cleans orphans later). The confirm text says so, so the owner isn't
  // surprised the bytes remain.
  const deleteItem = useCallback(async (item) => {
    const k = kindRef.current
    const label = (item.title ?? '').trim() || fileNameOf(item.file_path)
    const ok = window.confirm(`Delete “${label}”?\nIts file stays on disk (cleaned up later) — this cannot be undone.`)
    if (!ok) return
    setNotice(null)
    setError(null)
    try {
      const res = await fetch(`/api/admin/${k}/${item.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `delete answered ${res.status}`)
      }
      if (k === 'images') setImages(prev => prev.filter(it => it.id !== item.id))
      else setVideos(prev => prev.filter(it => it.id !== item.id))
      setSaveStatus(prev => { const n = { ...prev }; delete n[item.id]; return n })
      setSaveErrors(prev => { const n = { ...prev }; delete n[item.id]; return n })
      setNotice(`Deleted “${label}”.`)
    } catch (err) {
      setError(err.message)
    }
  }, [csrfToken])

  // --- Render -----------------------------------------------------------------

  // Loading / error branches stay plain <section>s (the story / comic
  // editors' pattern) — but in the `.media-editor` container so they keep the
  // section width now that the section sits outside `.wrap`.
  if (list === null) {
    if (error) {
      return (
        <section className="media-editor">
          <h2>Media editor</h2>
          <div className="panel panel--warn">
            <p className="error" style={{ marginTop: 0 }}>Couldn't load the media editor.</p>
            <p className="muted">{error}</p>
            <p><button onClick={() => load()}>Try again</button></p>
          </div>
        </section>
      )
    }
    return (
      <section className="media-editor">
        <h2>Media editor</h2>
        <p className="muted">Loading images and videos…</p>
      </section>
    )
  }

  // B2.6r + the B2.7 row — the CANONICAL 11.5a 5th-revision grip model (the
  // same ResizableSection the story / comic editors mount). initialHeight 880
  // keeps the section's natural portrait height; minHeight 620 keeps the item
  // list usable when the section is dragged small.
  return (
    <ResizableSection
      className={'media-editor' + (dragActive ? ' media-editor--file-drag' : '')}
      storageKey="mediaEditor"
      initialHeight={880}
      minHeight={620}
      onDragOver={onSectionDragOver}
      onDrop={onSectionDrop}
      onDragLeave={onSectionDragLeave}
    >
      <h2>Media editor</h2>
      <p className="muted">
        Upload images and videos — drag a file anywhere in this section, Ctrl+V
        to paste, or double-click the box below to pick files. Titles and
        captions auto-save as you edit (no save button).
      </p>

      {/* Tabs — the active tab is the upload kind + drop/paste filter. */}
      <div className="media-tabs" role="tablist" aria-label="Media type">
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'images'}
          className={'media-tab' + (kind === 'images' ? ' media-tab--on' : '')}
          onClick={() => setKind('images')}
        >
          Images
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'videos'}
          className={'media-tab' + (kind === 'videos' ? ' media-tab--on' : '')}
          onClick={() => setKind('videos')}
        >
          Videos
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}{' '}
          <button style={{ padding: '4px 10px' }} onClick={() => load()}>Reload</button>
        </p>
      )}
      {notice && <p className="success" role="status">{notice}</p>}
      {uploading && <p className="muted" role="status">{uploadMsg}</p>}

      {/* The drop zone — the visual anchor. Single click = paste, double click
          = the OS picker; the whole section above is the actual drop target. */}
      <div
        className={'dropzone' + (dragActive ? ' dropzone--active' : '') + (uploading ? ' dropzone--busy' : '')}
        onClick={onZoneClick}
        onDoubleClick={onZoneDoubleClick}
        title="Drag a file anywhere in the section to add it · Ctrl+V (or click) to paste · double-click to pick files"
      >
        {kind === 'images'
          ? 'Drop image files here · Ctrl+V or click to paste · double-click to pick files'
          : 'Drop video files here · Ctrl+V or click to paste · double-click to pick files'}
      </div>

      {/* The item list — flex-fills the section and scrolls internally. */}
      <div className="media-list">
        {list.length === 0 ? (
          <p className="muted">
            No {kind} yet — drop one above, or pick a file.
          </p>
        ) : (
          list.map(item => (
            <article className="media-item" key={item.id}>
              <div className="media-item-preview" title={fileNameOf(item.file_path)}>
                {kind === 'images'
                  ? <img src={item.file_path} alt={item.title || ''} />
                  : <video src={item.file_path} controls preload="metadata" />}
              </div>
              <div className="media-item-fields">
                <label>Title</label>
                <input
                  type="text"
                  value={item.title ?? ''}
                  placeholder="Title…"
                  onChange={e => updateItem(item.id, 'title', e.target.value)}
                />
                <label>Caption</label>
                <input
                  type="text"
                  value={item.caption ?? ''}
                  placeholder="Caption (shown on the media's card, if at all)…"
                  onChange={e => updateItem(item.id, 'caption', e.target.value)}
                />
                {kind === 'videos' && (
                  <>
                    <label>Description</label>
                    <input
                      type="text"
                      value={item.description ?? ''}
                      placeholder="Description (optional)…"
                      onChange={e => updateItem(item.id, 'description', e.target.value)}
                    />
                  </>
                )}
                {/* Member flag — both kinds carry is_member (0 = free, 1 = members-only).
                    Toggling it re-saves the item with the new flag (buildPayload sends 0/1). */}
                <label className="media-item-flag">
                  <input
                    type="checkbox"
                    checked={!!item.is_member}
                    onChange={e => updateItem(item.id, 'is_member', e.target.checked ? 1 : 0)}
                  />
                  Members only (hide from free readers)
                </label>
                <p className="media-item-file muted">{fileNameOf(item.file_path)}</p>
                <div className="media-item-actions">
                  <button
                    type="button"
                    className="btn--danger"
                    style={{ padding: '6px 14px' }}
                    onClick={() => deleteItem(item)}
                  >
                    Delete
                  </button>
                  {saveStatus[item.id] === 'saving' && (
                    <span className="caption-status" style={{ display: 'inline-block', margin: 0, verticalAlign: 'middle' }} role="status">
                      Saving…
                    </span>
                  )}
                  {saveStatus[item.id] === 'saved' && (
                    <span className="caption-status" style={{ display: 'inline-block', margin: 0, verticalAlign: 'middle' }} role="status">
                      Saved
                    </span>
                  )}
                  {saveStatus[item.id] === 'error' && (
                    <span className="caption-status error" style={{ display: 'inline-block', margin: 0, verticalAlign: 'middle' }} role="alert">
                      Save failed — {saveErrors[item.id]}
                    </span>
                  )}
                </div>
              </div>
            </article>
          ))
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={kind === 'images' ? 'image/*' : 'video/*'}
        hidden
        onChange={onFilePicked}
      />
    </ResizableSection>
  )
}
