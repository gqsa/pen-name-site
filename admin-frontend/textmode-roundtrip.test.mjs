import { comicToMarkdown, markdownToBlocks, buildTargetDoc, toPlainText } from './src/textMode.js'
import assert from 'node:assert/strict'

let passed = 0
function ok(name, fn) { fn(); passed += 1; console.log('  ✓', name) }

// A realistic comic: 3 media pages (with top/bottom captions) + 2 caption pages.
const pages = [
  { id: 1, comic_id: 9, page_number: 1, file_path: 'uploads/a.png', caption: null, caption_top: 'Line A1', caption_bottom: 'Line B1', caption_position: 'top' },
  { id: 2, comic_id: 9, page_number: 2, file_path: 'uploads/b.png', caption: null, caption_top: null, caption_bottom: null, caption_position: 'top' },
  { id: 3, comic_id: 9, page_number: 3, file_path: null, caption: 'Prose one\nProse two', caption_top: null, caption_bottom: null, caption_position: 'page' },
  { id: 4, comic_id: 9, page_number: 4, file_path: 'uploads/c.png', caption: null, caption_top: 'Only top', caption_bottom: null, caption_position: 'top' },
  { id: 5, comic_id: 9, page_number: 5, file_path: null, caption: 'A second caption page', caption_top: null, caption_bottom: null, caption_position: 'page' },
]

ok('serialize: numbers assigned in comic order (media pages id 1,2,4 → numbers 1,2,3)', () => {
  const { markdown, numberToPageId } = comicToMarkdown(pages)
  assert.equal(numberToPageId.get(1), 1) // number 1 → page id 1
  assert.equal(numberToPageId.get(2), 2) // number 2 → page id 2
  assert.equal(numberToPageId.get(3), 4) // number 3 → page id 4 (id 3 is a caption page)
  assert.ok(markdown.includes('[media 1]'))
  assert.ok(markdown.includes('[media 2]'))
  assert.ok(markdown.includes('[media 3]'))
})

ok('round-trip: serialize → parse → apply reproduces the SAME comic (ids, order, captions)', () => {
  const { markdown, numberToPageId } = comicToMarkdown(pages)
  const blocks = markdownToBlocks(markdown)
  const target = buildTargetDoc(blocks, numberToPageId, pages, '#fff')
  // Same number of pages, same ids in the same order, same captions.
  assert.equal(target.pages.length, pages.length)
  for (let i = 0; i < pages.length; i++) {
    assert.equal(target.pages[i].id, pages[i].id)
    assert.equal(target.pages[i].file_path, pages[i].file_path)
    assert.equal(target.pages[i].caption, pages[i].caption)
    assert.equal(target.pages[i].caption_top, pages[i].caption_top)
    assert.equal(target.pages[i].caption_bottom, pages[i].caption_bottom)
  }
})

ok('parse: `>` lines between two markers (no blank) attach to the PREVIOUS marker bottom', () => {
  const blocks = markdownToBlocks('[media 1]\n> shared\n[media 2]')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].number, 1)
  assert.equal(blocks[0].bottom, 'shared')
  assert.equal(blocks[0].top, '')
  assert.equal(blocks[1].number, 2)
  assert.equal(blocks[1].top, '')
  assert.equal(blocks[1].bottom, '')
})

ok('parse: `>` lines after a blank line attach to the NEXT marker top', () => {
  const blocks = markdownToBlocks('[media 1]\n\n> next\n[media 2]')
  assert.equal(blocks[0].bottom, '')
  assert.equal(blocks[0].top, '')
  assert.equal(blocks[1].top, 'next')
  assert.equal(blocks[1].bottom, '')
})

ok('fault-tolerance: prose / malformed markers are ignored (never create or delete)', () => {
  const blocks = markdownToBlocks('just prose\n[media x]\n---\n[media 1]\n> cap')
  // Only the well-formed [media 1] + its caption survive. Prose, the malformed
  // [media x], and the lone fence are ignored.
  const media = blocks.filter((b) => b.type === 'media')
  assert.equal(media.length, 1)
  assert.equal(media[0].number, 1)
  assert.equal(media[0].bottom, 'cap')
  // No caption page was created from the single fence.
  assert.equal(blocks.filter((b) => b.type === 'captionPage').length, 0)
})

ok('apply: a typed NEW [media 7] becomes an empty "media" slot at that position', () => {
  const { numberToPageId } = comicToMarkdown(pages)
  const blocks = markdownToBlocks('[media 1]\n\n[media 7]\n\n[media 2]')
  const target = buildTargetDoc(blocks, numberToPageId, pages, null)
  const slot = target.pages.find((p) => p.caption_position === 'media')
  assert.ok(slot, 'an empty media slot is created')
  assert.equal(slot.file_path, null)
  // It sits between media 1 and media 2.
  const order = target.pages.map((p) => p.id)
  assert.ok(order.indexOf(slot.id) > order.indexOf(1))
  assert.ok(order.indexOf(slot.id) < order.indexOf(2))
})

ok('apply: unreferenced real media is KEPT (never deleted), appended at the end', () => {
  const { numberToPageId } = comicToMarkdown(pages)
  // Reference only media numbers 1 and 2 (page ids 1 and 2); the third media
  // (number 3 = page id 4) is dropped from the text but must SURVIVE.
  const blocks = markdownToBlocks('[media 1]\n[media 2]')
  const target = buildTargetDoc(blocks, numberToPageId, pages, null)
  const ids = target.pages.map((p) => p.id)
  assert.ok(ids.includes(4), 'the third media (page id 4) is still present')
  assert.equal(ids[ids.length - 1], 4, 'the third media appended at the end')
})

ok('toPlainText: strips > prefixes, --- fences, [media x] markers (the Copy button)', () => {
  const md = '[media 1]\n> top cap\n\n[media 2]\n> bottom cap\n\n---\nProse here\n---\n'
  const plain = toPlainText(md)
  assert.ok(plain.includes('top cap'))
  assert.ok(plain.includes('bottom cap'))
  assert.ok(plain.includes('Prose here'))
  assert.ok(!plain.includes('[media'))
  assert.ok(!plain.includes('>'))
  assert.ok(!plain.includes('---'))
})

console.log(`\n${passed} passed`)
