// B18 round 5 — the TEXT MODE engine (serialization + parsing).
//
// Pure functions, no React / no DOM, so they are unit-testable in isolation.
// The comic is the source of truth; text mode is a PROSE-FIRST view over it.
// The text pane renders a comic as a small markdown dialect:
//
//   [media N]            a MEDIA page (image / video / audio), N = its FROZEN
//                        number (assigned in comic order when text mode is
//                        entered; refreshed only on regenerate).
//   > caption line       a TOP caption = a `>` line immediately BEFORE the
//                        marker; a BOTTOM caption = a `>` line immediately
//                        AFTER it.
//   --- <prose> ---      a CAPTION PAGE (a page with no media), fenced
//                        between two `---` divider lines.
//   %% ... %%            a COMMENT (round 6): visible in the text pane, but
//                        STRIPPED before parsing / applying / copying — it
//                        never renders in the preview, never applies to the
//                        comic, and is lost when the text refreshes. Use it
//                        for agent-generated prompts (danbooru / minimax h3)
//                        that sit alongside the story.
//
// Everything else the owner types is PROSE: it is preserved in the text pane
// but is NOT part of the comic model, so applying never creates or deletes
// from it (the fault-tolerance rule — "treated as prose / ignored").
//
// ROUND-TRIP CONTRACT: comicToMarkdown(comic) → markdownToBlocks(md) →
// (apply) reproduces the same comic. The serializer and parser below agree on
// the format; a blank line separates every block so the top/bottom caption
// ambiguity between two adjacent markers is always resolved.

const MARKER_RE = /^\[media (\d+)\]\s*$/
const FENCE_RE = /^\s*---\s*$/
const CAP_RE = /^>\s?(.*)$/
const isBlank = (s) => s.trim() === ''

// --- B18 round 6 — COMMENT-OUT PUNCTUATION ----------------------------------
// `%% ... %%` — a BLOCK COMMENT (multi-line capable). Anything between `%%`
// (inclusive) is STRIPPED before parsing / applying / copying: it is visible
// in the text pane (the owner can edit it) but never rendered in the preview,
// never applied to the comic, and never copied. Intended for agent-generated
// prompts (danbooru tags, minimax h3 prompts, etc.) that the owner wants to
// keep alongside the story without affecting the comic.
//
// The regex matches the FIRST `%%` and the NEXT `%%` (non-greedy), so
// `%% foo %% bar %% baz %%` strips `%% foo %%` and `%% baz %%` (leaving
// ` bar `). Unmatched `%%` (no closing delimiter) is left as-is (prose).
const COMMENT_RE = /%%[\s\S]*?%%/g

// stripComments(md) → the markdown with all `%% ... %%` blocks removed. A
// comment line (a line that is entirely a comment, or part of a multi-line
// comment) is removed ENTIRELY (not just the comment part), so the blocks
// before and after the comment remain adjacent (no blank line between them —
// a blank line would separate a caption from its marker, breaking the
// caption-claiming logic). A comment in the MIDDLE of a line is removed
// (the rest of the line is kept).
export function stripComments(md) {
  const lines = String(md).split('\n')
  const out = []
  let inComment = false
  for (const line of lines) {
    if (inComment) {
      // We are inside a multi-line comment (the opening %% was on a previous
      // line). Look for the closing %% on this line.
      const close = line.indexOf('%%')
      if (close === -1) continue   // still inside the comment
      const after = line.slice(close + 2)
      inComment = false
      if (after.trim() !== '') out.push(after.trim())
      // If `after` is blank, the line is entirely comment — skip it.
    } else if (!line.includes('%%')) {
      // No comment on this line — keep it EXACTLY (blank lines included: they
      // carry meaning — a blank line separates a caption from its marker).
      out.push(line)
    } else {
      // Strip every COMPLETE %% ... %% block on this line (there may be
      // several), leaving the surrounding text intact. (matchAll — String.match
      // with /g returns bare strings without .index.)
      let kept = line
      const matches = [...kept.matchAll(COMMENT_RE)]
      if (matches.length > 0) {
        let rebuilt = ''
        let pos = 0
        for (const m of matches) {
          rebuilt += kept.slice(pos, m.index) + ' '
          pos = m.index + m[0].length
        }
        rebuilt += kept.slice(pos)
        kept = rebuilt
      }
      // A DANGLING %% (an open with no close on this line) starts a
      // multi-line comment: keep the text before it, drop the rest.
      const dangling = kept.indexOf('%%')
      if (dangling !== -1) {
        kept = kept.slice(0, dangling)
        inComment = true
      }
      kept = kept.replace(/\s+/g, ' ').trim()
      if (kept !== '') out.push(kept)
      // If `kept` is blank, the line was entirely comment — skip it.
    }
  }
  return out.join('\n')
}

// comicToMarkdown(pages) → { markdown, numberToPageId }
//   pages            — the comic's pages in page_number order. A page is a
//                      MEDIA page when file_path is non-null, else a CAPTION
//                      page (or an empty 'media' slot, serialized like a bare
//                      marker the owner can fill).
//   markdown         — the text-pane string.
//   numberToPageId   — Map<number, pageId>: the FROZEN media numbers (1..N in
//                      comic order). The apply engine resolves each [media N]
//                      through this map; a number NOT in the map is a NEW
//                      media placeholder.
export function comicToMarkdown(pages) {
  const numberToPageId = new Map() // number → pageId (for the apply engine)
  const pageToNumber = new Map()   // pageId → number (for serializing the marker)
  let n = 0
  for (const p of pages) {
    if (p.file_path) { n += 1; numberToPageId.set(n, p.id); pageToNumber.set(p.id, n) }
  }
  const out = []
  for (const p of pages) {
    if (p.file_path) {
      const num = pageToNumber.get(p.id)
      if (p.caption_top) for (const line of String(p.caption_top).split('\n')) out.push('> ' + line)
      out.push(`[media ${num}]`)
      if (p.caption_bottom) for (const line of String(p.caption_bottom).split('\n')) out.push('> ' + line)
    } else {
      const isSlot = (p.caption_position === 'media')
      if (isSlot) {
        // An EMPTY media slot has no frozen number (it is not yet real media).
        // Render it as a bare placeholder the owner fills by dragging a file in.
        out.push('[media ?]')
      } else {
        out.push('---')
        for (const line of String(p.caption ?? '').split('\n')) out.push(line)
        out.push('---')
      }
    }
    out.push('') // blank line separates every block (top/bottom disambiguation)
  }
  const markdown = out.join('\n').replace(/\n+$/, '')
  return { markdown, numberToPageId }
}

// markdownToBlocks(md) → an ORDERED array of blocks, each:
//   { type: 'media', number, top, bottom }   a [media N] marker + captions, or
//   { type: 'media', number: null, top, bottom }  a bare [media ?] slot, or
//   { type: 'captionPage', text }            a ---fenced prose block.
// Fault-tolerant: unrecognized lines are ignored (never create / delete). A
// `>` line is a caption only when adjacent (no blank line) to a marker; a
// fence must be well-formed (exactly three dashes) to delimit a caption page.
export function markdownToBlocks(md) {
  // B18 round 6 — strip comments (%% ... %%) BEFORE parsing: they are visible
  // in the text pane but never rendered in the preview or applied to the comic.
  const lines = stripComments(String(md)).split('\n')
  const n = lines.length
  const blocks = []
  const consumed = new Set()

  // 1) Caption pages: pair the well-formed fences (1st+2nd, 3rd+4th, …). An
  //    odd trailing fence (and its content) is prose — ignored, never a page.
  const fenceIdx = []
  for (let i = 0; i < n; i++) if (FENCE_RE.test(lines[i])) fenceIdx.push(i)
  for (let f = 0; f + 1 < fenceIdx.length; f += 2) {
    const start = fenceIdx[f]
    const end = fenceIdx[f + 1]
    const textLines = []
    for (let i = start + 1; i < end; i++) { textLines.push(lines[i]); consumed.add(i) }
    consumed.add(start); consumed.add(end)
    blocks.push({ type: 'captionPage', text: textLines.join('\n'), _pos: start })
  }

  // 2) Media markers, in line order, each claiming its adjacent `>` captions.
  //    A `>` line already claimed (consumed) is never double-assigned: between
  //    two markers with no blank line it belongs to the PREVIOUS marker's
  //    bottom (top-to-bottom reading); a blank line hands it to the NEXT
  //    marker's top.
  for (let i = 0; i < n; i++) {
    if (consumed.has(i)) continue
    const line = lines[i]
    const slot = /^\[media \?\]\s*$/.test(line)
    const m = slot ? null : line.match(MARKER_RE)
    if (!slot && !m) continue
    const number = slot ? null : Number(m[1])

    let k = i - 1
    const topLines = []
    while (k >= 0) {
      if (consumed.has(k) || isBlank(lines[k]) || MARKER_RE.test(lines[k]) || FENCE_RE.test(lines[k]) || /^\[media \?\]\s*$/.test(lines[k])) break
      const cm = lines[k].match(CAP_RE)
      if (!cm) break
      topLines.unshift(cm[1]); consumed.add(k); k -= 1
    }
    let l = i + 1
    const bottomLines = []
    while (l < n) {
      if (consumed.has(l) || isBlank(lines[l]) || MARKER_RE.test(lines[l]) || FENCE_RE.test(lines[l]) || /^\[media \?\]\s*$/.test(lines[l])) break
      const cm = lines[l].match(CAP_RE)
      if (!cm) break
      bottomLines.push(cm[1]); consumed.add(l); l += 1
    }

    blocks.push({ type: 'media', number, top: topLines.join('\n'), bottom: bottomLines.join('\n'), _pos: i })
    consumed.add(i)
  }

  blocks.sort((a, b) => a._pos - b._pos)
  for (const b of blocks) delete b._pos
  return blocks
}

// toPlainText(md) → the text with the punctuation markup REMOVED (the copy
// button's "plain text"): the `>` caption prefixes, the `---` fences, and the
// [media x] / [media ?] markers are all stripped, leaving the plain prose +
// caption text (the actual words, in order). Blank runs are collapsed.
export function toPlainText(md) {
  // B18 round 6 — strip comments (%% ... %%) BEFORE converting: they are never
  // copied (the owner wants the actual words, not the agent prompts).
  return stripComments(String(md))
    .split('\n')
    .map((line) => {
      const cap = line.match(CAP_RE)
      if (cap) return cap[1]
      if (FENCE_RE.test(line)) return ''
      if (MARKER_RE.test(line) || /^\[media \?\]\s*$/.test(line)) return ''
      return line
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// buildTargetDoc(blocks, numberToPageId, pages, theme) → the applyDoc target
//   { pages: [...], theme } in TEXT ORDER. This is the bridge from the parsed
//   blocks to the existing applyDoc primitive:
//     • [media N] whose N is in numberToPageId  → the EXISTING media page,
//       re-ordered to this position, its top/bottom slots set from the block.
//     • [media N] / [media ?] with no mapped N   → a NEW empty 'media' slot at
//       this position (created on apply; the owner fills it by dragging in).
//     • a captionPage block                     → a NEW caption page here.
//   Existing media pages NOT referenced by any block are KEPT (real media is
//   never deleted) and appended, in their current order, at the END. Existing
//   caption pages / slots not reproduced by the text are dropped (file-less
//   pages are derived from the text).
export function buildTargetDoc(blocks, numberToPageId, pages, theme) {
  const pageById = new Map(pages.map((p) => [p.id, p]))
  const target = []
  const referenced = new Set()
  // Claim existing caption pages by text (in comic order) so a lossless
  // round-trip REUSES their ids instead of deleting + recreating them. A page
  // claimed here survives in the target (not dropped); unclaimed caption pages
  // are the ones the text no longer represents → dropped (the delete feature).
  const claimableCaps = pages
    .filter((p) => !p.file_path && p.caption_position !== 'media')
    .map((p) => ({ page: p, claimed: false }))
  const claimCaption = (text) => {
    const hit = claimableCaps.find((c) => !c.claimed && (c.page.caption ?? '') === text)
    if (hit) { hit.claimed = true; return hit.page }
    return null
  }
  let seq = 0 // fresh, unique id for every NEW page (placeholder or caption)
  for (const block of blocks) {
    if (block.type === 'media') {
      const pid = block.number != null ? numberToPageId.get(block.number) : undefined
      if (pid != null && pageById.has(pid)) {
        const p = pageById.get(pid)
        referenced.add(pid)
        target.push({
          id: p.id,
          file_path: p.file_path,
          caption: p.caption ?? null,
          caption_top: block.top || null,
          caption_bottom: block.bottom || null,
          caption_position: p.caption_position || 'top',
        })
      } else {
        // A NEW media placeholder (a typed number the comic doesn't have yet,
        // or a bare [media ?] slot). Fresh non-numeric id → applyDoc treats it
        // as an addition and the server creates it as a file-less 'media' slot.
        target.push({
          id: `textnew-${seq}`,
          file_path: null,
          caption: null,
          caption_top: null,
          caption_bottom: null,
          caption_position: 'media',
        })
        seq += 1
      }
    } else if (block.type === 'captionPage') {
      const existing = claimCaption(block.text)
      if (existing) {
        // Reuse the existing caption page (its id preserved) — a lossless
        // round-trip reproduces the SAME page, not a delete + recreate.
        target.push({
          id: existing.id,
          file_path: null,
          caption: block.text,
          caption_top: null,
          caption_bottom: null,
          caption_position: 'page',
        })
      } else {
        // A NEW caption page (no existing page carries this exact text).
        target.push({
          id: `textnew-${seq}`,
          file_path: null,
          caption: block.text,
          caption_top: null,
          caption_bottom: null,
          caption_position: 'page',
        })
        seq += 1
      }
    }
  }
  // KEEP unreferenced real media (never delete real media) — appended at end.
  for (const p of pages) {
    if (p.file_path && !referenced.has(p.id)) {
      target.push({
        id: p.id,
        file_path: p.file_path,
        caption: p.caption ?? null,
        caption_top: p.caption_top ?? null,
        caption_bottom: p.caption_bottom ?? null,
        caption_position: p.caption_position || 'top',
      })
    }
  }
  return { pages: target, theme }
}
