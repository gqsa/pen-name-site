import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// B2.5 — Step 2: the comic editor — shell + DROPZONE + upload pipeline.
//
// What this step adds on top of the Step-1 shell (read-only list/preview):
//   • A dropzone at the top of the left pane with THREE input paths:
//       drag/drop a batch of images · single-click = paste from the
//       clipboard · double-click = the OS file picker.
//       (A double-click also fires TWO click events, so a single click is
//       deferred behind a 250 ms timer the double-click cancels.)
//   • The upload pipeline: each image → POST /api/admin/upload (multipart,
//     `kind` BEFORE `file`, NO Content-Type header) → POST
//     /api/admin/comic-pages { comic_id, page_number = max+1, file_path }
//     — sequential (multer is single-file), optimistic local append so the
//     list + preview update immediately, stop + error line on any failure.
//
// Still NOT here (next steps): drag-reorder (Step 3), caption inputs +
// auto-save (Step 4). Keep the state shape stable.
//
// Data (B2.4 contract — pinned, don't re-derive):
//   • GET /api/admin/content  (GET = CSRF-exempt, no token needed)
//       → { comics, pages, stories, images, videos, counts }
//         comics: [{ id, title, description, publish_date, is_member, tier_id, created_at, updated_at }]
//         pages : [{ id, comic_id, page_number, file_path, caption }]   ← the key is "pages"
//   • POST /api/admin/comics       { title }  (JSON + X-CSRF-Token) → 201 { success, id }
//   • POST /api/admin/upload       multipart kind='comics' + file      → { success, file_path, … }
//   • POST /api/admin/comic-pages  { comic_id, page_number, file_path } → 201 { success, id }
//
// Layout note: the shell's `.wrap` column is 780px — too narrow for a two-column
// split view. This component therefore renders as a SIBLING of `.wrap` (see the
// ok-branch in App.jsx) and owns its own wider `.comic-editor` container (~1100px).

// --- Upload helpers (module-level, no hooks) ---------------------------------

// The server saves files under their ORIGINALNAME (server.js multer
// `filename`), and express.static infers the MIME type from the extension —
// so a name without an extension (a raw clipboard blob arrives as
// `filename="blob"`) would be served with no image content type. Derive a
// sensible extension from the MIME type when we have to name a blob ourselves.
function extForImageType(mime) {
  const sub = String(mime).split('/')[1] || ''
  if (sub === 'jpeg') return 'jpg'
  if (/^[a-z0-9]+$/.test(sub)) return sub
  return 'img'
}

// THE upload call (the house pattern — copied shape, `kind` BEFORE `file`,
// no Content-Type: the browser sets the multipart boundary).
async function uploadImage(file, csrfToken) {
  const fd = new FormData()
  fd.append('kind', 'comics')
  fd.append('file', file)
  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `upload answered ${res.status}`)
  }
  return res.json()
}

export default function ComicEditor({ csrfToken }) {
  // comics: array (null until the first fetch lands) — the full comic list.
  // pages : array — ALL comics' pages from the same fetch (keyed `pages`).
  // selectedId: the id of the comic being edited (a number, matching the DB id).
  const [comics, setComics] = useState(null)
  const [pages, setPages] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)

  // Step 2 — dropzone + pipeline state.
  const [uploading, setUploading] = useState(false)   // UI flag (drives the busy look)
  const [uploadMsg, setUploadMsg] = useState('')      // "Uploading i/N…"
  const [dragActive, setDragActive] = useState(false) // drag-over highlight
  const [notice, setNotice] = useState(null)          // green success line
  const fileInputRef = useRef(null)                   // hidden <input type="file">
  const clickTimer = useRef(null)                     // single-vs-double-click disambiguation
  // The authoritative in-flight flag. `uploading` (state) lags one render; a
  // ref read is always current, so two quick drops can't start two pipelines.
  const uploadingRef = useRef(false)

  // Clear the deferred single-click timer if the component unmounts early.
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current) }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/content', { headers: { Accept: 'application/json' } })
      if (!res.ok) { setError(`content endpoint answered ${res.status}`); return }
      const data = await res.json()
      const list = Array.isArray(data.comics) ? data.comics : []
      setComics(list)
      setPages(Array.isArray(data.pages) ? data.pages : [])
      // Default selection = the first comic, or null if there are none. A reload
      // keeps a selection the owner already made (prev !== null).
      setSelectedId(prev => (prev !== null ? prev : (list.length ? list[0].id : null)))
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // The selected comic's pages, in reading order. Drives BOTH the left list and
  // the right preview, so the two can't drift apart.
  const selectedPages = useMemo(() => {
    if (selectedId === null) return []
    return pages
      .filter(p => p.comic_id === selectedId)
      .sort((a, b) => a.page_number - b.page_number)
  }, [pages, selectedId])

  const createComic = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) { setError('Give the new comic a title first.'); return }
    if (creating) return
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/comics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `create answered ${res.status}`)
      }
      const data = await res.json()
      setComics(prev => (prev === null ? [{ id: data.id, title }] : [...prev, { id: data.id, title }]))
      setSelectedId(data.id)
      setNewTitle('')
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }, [newTitle, creating, csrfToken])

  // --- Step 2: the upload pipeline (all three input paths funnel here) -------
  //
  // Sequential on purpose: the server's multer is single-file. For each image:
  //   1. uploadImage() → { file_path }
  //   2. page_number = (max page_number among this comic's current pages) + 1
  //   3. POST /api/admin/comic-pages { comic_id, page_number, file_path } → 201
  //   4. append the row to local `pages` (list + preview update immediately)
  // Any failure stops the batch — a half-uploaded set is reported, not hidden.
  const addFiles = useCallback(async (files) => {
    if (selectedId === null) {
      setNotice(null)
      setError('Select or create a comic first, then add its pages.')
      return
    }
    if (uploadingRef.current) {
      setNotice(null)
      setError('An upload is already in progress — wait for it to finish.')
      return
    }
    const list = Array.from(files).filter(f => f && (f.type || '').startsWith('image/'))
    if (list.length === 0) {
      setNotice(null)
      setError('No image files in that batch — only image files are added as pages.')
      return
    }
    uploadingRef.current = true
    setUploading(true)
    setError(null)
    setNotice(null)
    // Base number from the comic's CURRENT local pages; then increment per
    // success (never reuse a number → a 409 would stop the batch anyway).
    let nextNumber = selectedPages.reduce((m, p) => Math.max(m, Number(p.page_number) || 0), 0) + 1
    let inserted = 0
    try {
      for (let i = 0; i < list.length; i += 1) {
        setUploadMsg(`Uploading ${i + 1}/${list.length} — ${list[i].name || 'image'}…`)
        const up = await uploadImage(list[i], csrfToken)
        const res = await fetch('/api/admin/comic-pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ comic_id: selectedId, page_number: nextNumber, file_path: up.file_path }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `add-page answered ${res.status}`)
        }
        const created = await res.json()
        const row = { id: created.id, comic_id: selectedId, page_number: nextNumber, file_path: up.file_path, caption: null }
        setPages(prev => [...prev, row])
        nextNumber += 1
        inserted += 1
      }
      const title = (comics.find(c => c.id === selectedId) || {}).title || 'the comic'
      setNotice(`Added ${inserted} page${inserted === 1 ? '' : 's'} to “${title}”.`)
    } catch (err) {
      setError(err.message + (inserted > 0
        ? ` — ${inserted}/${list.length} page(s) were saved before the failure; the rest were not added.`
        : ''))
    } finally {
      uploadingRef.current = false
      setUploading(false)
      setUploadMsg('')
    }
  }, [selectedId, selectedPages, comics, csrfToken])

  // --- Step 2: the three input paths -----------------------------------------

  // Click → PASTE: read the clipboard, keep the image items. A blob has no
  // name, so wrap it in a File with a proper name + extension (see
  // extForImageType — the server saves by originalname).
  const doPaste = useCallback(async () => {
    if (selectedId === null) {
      setNotice(null)
      setError('Select or create a comic first, then paste its pages.')
      return
    }
    if (uploadingRef.current) {
      setError('An upload is already in progress — wait for it to finish.')
      return
    }
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      setNotice(null)
      setError('Clipboard read isn’t available in this browser — drag the images in, or double-click the dropzone to pick files.')
      return
    }
    try {
      const items = await navigator.clipboard.read()
      const files = []
      for (let i = 0; i < items.length; i += 1) {
        const type = Array.from(items[i].types).find(t => t.startsWith('image/'))
        if (!type) continue
        const blob = await items[i].getType(type)
        files.push(new File([blob], `pasted-${Date.now()}-${i + 1}.${extForImageType(type)}`, { type }))
      }
      if (files.length === 0) {
        setNotice(null)
        setError('No image on the clipboard — copy an image first, or drag one in / double-click to pick files.')
        return
      }
      await addFiles(files)
    } catch (err) {
      setNotice(null)
      setError('Couldn’t read the clipboard (permission denied or empty) — drag the images in, or double-click the dropzone to pick files.')
    }
  }, [selectedId, addFiles])

  // Single click: defer behind a timer; a double-click cancels it and opens
  // the picker instead. (A double-click also fires two `click` events — the
  // `if (clickTimer.current) return` guard swallows the second one.)
  const onZoneClick = useCallback(() => {
    if (clickTimer.current) return
    clickTimer.current = setTimeout(() => { clickTimer.current = null; doPaste() }, 250)
  }, [doPaste])

  const onZoneDoubleClick = useCallback(() => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null }
    fileInputRef.current?.click()
  }, [])

  // Drag/drop: preventDefault on dragover is REQUIRED for the drop to be allowed.
  const onZoneDragOver = useCallback((e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }, [])

  const onZoneDragLeave = useCallback((e) => {
    // dragleave fires when the pointer moves onto a child — ignore that.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
    setDragActive(false)
  }, [])

  const onZoneDrop = useCallback((e) => {
    e.preventDefault()
    setDragActive(false)
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (files.length) addFiles(files)
  }, [addFiles])

  // Double-click → the OS picker (hidden input; the same pipeline as the rest).
  const onFilePicked = useCallback((e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // let the same file be re-picked later
    if (files.length) addFiles(files)
  }, [addFiles])

  // --- Loading / error (before the first fetch lands) -------------------------
  if (comics === null) {
    if (error) {
      return (
        <section className="comic-editor">
          <h2>Comic editor</h2>
          <div className="panel panel--warn">
            <p className="error" style={{ marginTop: 0 }}>Couldn't load the comic editor.</p>
            <p className="muted">{error}</p>
            <p><button onClick={() => load()}>Try again</button></p>
          </div>
        </section>
      )
    }
    return (
      <section className="comic-editor">
        <h2>Comic editor</h2>
        <p className="muted">Loading comics…</p>
      </section>
    )
  }

  const selectedComic = comics.find(c => c.id === selectedId) || null

  return (
    <section className="comic-editor">
      <h2>Comic editor</h2>
      <p className="muted">
        Split view — pick or create a comic on the left, add its pages with the
        dropzone (drag a batch · click to paste · double-click to pick files),
        watch the live preview on the right. Drag-reorder and caption auto-save
        land in the next B2.5 steps.
      </p>

      {error && (
        <p className="error">
          {error}{' '}
          <button style={{ padding: '4px 10px' }} onClick={() => load()}>Reload</button>
        </p>
      )}
      {notice && <p className="success">{notice}</p>}

      <div className="comic-split">
        {/* LEFT — the editor pane: comic select + create form + dropzone + page list. */}
        <div className="comic-left">
          <label htmlFor="comic-select">Comic</label>
          <select
            id="comic-select"
            value={selectedId ?? ''}
            onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : null)}
          >
            {comics.length === 0 && <option value="">(no comics yet — create one below)</option>}
            {comics.map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>

          <div className="row" style={{ marginTop: '12px' }}>
            <input
              type="text"
              value={newTitle}
              placeholder="New comic title…"
              style={{ flex: '1 1 160px' }}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createComic() }}
            />
            <button onClick={createComic} disabled={creating}>
              {creating ? 'Creating…' : 'New comic'}
            </button>
          </div>

          {/* Step 2 — the live dropzone: THREE input paths.
              drag/drop a batch · single click = paste · double click = picker. */}
          <div
            className={
              'dropzone'
              + (dragActive ? ' dropzone--active' : '')
              + (uploading ? ' dropzone--busy' : '')
            }
            onDragOver={onZoneDragOver}
            onDragLeave={onZoneDragLeave}
            onDrop={onZoneDrop}
            onClick={onZoneClick}
            onDoubleClick={onZoneDoubleClick}
            title="Click to paste from the clipboard · double-click to pick files · or drag a batch of images in"
          >
            {uploading ? (
              <span>{uploadMsg || 'Uploading…'}</span>
            ) : (
              <span className="muted">
                Drop a batch of images here · click to paste · double-click to pick files
              </span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onFilePicked}
          />

          <h3 style={{ margin: '18px 0 8px' }}>
            Pages
            {selectedComic ? <span> — {selectedComic.title}</span> : null}
            <span className="muted" style={{ fontWeight: 400 }}> ({selectedPages.length})</span>
          </h3>

          {selectedPages.length === 0 ? (
            <p className="muted">No pages yet.</p>
          ) : (
            <ul className="page-list">
              {selectedPages.map(p => (
                <li key={p.id} className="page-row">
                  {p.caption ? <p className="page-caption">{p.caption}</p> : null}
                  <img className="page-thumb" src={p.file_path} alt={`Page ${p.page_number}`} />
                  <span className="muted" style={{ marginTop: '6px', display: 'block' }}>Page {p.page_number}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* RIGHT — the live preview: caption ABOVE each image (spec), reading order. */}
        <div className="comic-right">
          <h3 style={{ margin: '18px 0 8px' }}>Preview</h3>
          {selectedPages.length === 0 ? (
            <p className="muted">No pages yet.</p>
          ) : (
            <div className="comic-preview">
              {selectedPages.map(p => (
                <figure key={p.id} className="preview-figure">
                  {p.caption ? <figcaption className="page-caption">{p.caption}</figcaption> : null}
                  <img className="preview-thumb" src={p.file_path} alt={`Page ${p.page_number}`} />
                </figure>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
