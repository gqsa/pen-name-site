# text-mode-skill — writing for the GQSA comic editor

> **Who this is for.** An AI session (agent) asked to author or edit a story for
> this site's comic editor. Read this top to bottom, then write your output in
> the exact dialect below. The output is pasted into the editor's **text box**
> (the *text mode* pane) and applied with the **Update** button.

The comic is the source of truth. Text mode is a **prose-first view over it**:
a small markdown dialect that the editor parses into pages (media + captions +
caption pages) and applies. Anything you write that the dialect doesn't
recognise is kept as *prose* — preserved in the text pane but **never** turned
into a page. So the bar is low: it is safe to write around the structure.

---

## 1. The five building blocks

| Token | Meaning | Form (exact) |
|---|---|---|
| `[media N]` | a **MEDIA page** (image / video / audio) | one line, `^\[media \d+\]\s*$` — e.g. `[media 1]` |
| `[media ?]` | an **empty media slot** (a placeholder to fill) | one line, exactly `[media ?]` |
| `> text` | a **caption** (top or bottom of a media page) | one line, leading `>` + optional single space |
| `---` | a **CAPTION PAGE** fence (a page with no media) | one line, exactly three dashes (optional surrounding spaces) |
| `%% ... %%` | a **COMMENT** (never rendered / applied / copied) | block, multi-line capable |

Everything else is **prose** (kept, but not part of the comic).

---

## 2. The hard rules (these are what break if ignored)

1. **A blank line separates every block.** Put a blank line between a media
   block and the next block, and around caption pages. The serializer does this
   for you on round-trip; do the same when authoring.
2. **A caption is a `>` line *immediately* adjacent to its marker.**
   - A **top** caption = `>` line(s) with **no blank line** directly **above**
     the marker.
   - A **bottom** caption = `>` line(s) with **no blank line** directly
     **below** the marker.
   - A blank line between a `>` line and a marker **detaches** the caption — it
     becomes prose.
3. **A caption page is fenced between two `---` lines.** Fences pair in order
   (1st+2nd, 3rd+4th, …). A lone trailing `---` (odd count) is prose, not a
   page. The text between the pair is the page's content.
4. **Media numbers are `1..N` in comic order** when the editor assigns them.
   A number the comic doesn't have yet (or a bare `[media ?]`) becomes a **new
   empty media slot** the owner fills by dragging a file in.
5. **Real media is never deleted by applying.** A `[media N]` you don't mention
   is kept (appended at the end). Mentioning it re-orders it and sets its
   captions. (Deleting pages is a separate, confirmed action in the UI.)
6. **Comments (`%% ... %%`) vanish before parsing.** They are visible in the
   text pane, but they are **never rendered in the preview, never applied to
   the comic, and never copied.** A comment-only line is removed *entirely* (so
   the blocks around it stay adjacent — a stray blank line would detach a
   caption). A `%% ... %%` in the middle of a line removes just that span.
   - **Edge:** a `%%` with no closing `%%` on that line opens a multi-line
     comment that runs until the next `%%`.

---

## 3. Where comments come in (the agent-prompt workflow)

This is the main reason comments exist. When you are generating a story that
needs **artwork prompts** (e.g. danbooru tags for the illustrator, or minimax
`h3` prompts for video), put those prompts in **comments** next to the media
slot they belong to. They stay in the text pane for the owner to read / copy,
but they do **not** affect the preview or the comic.

Place a comment **adjacent to its `[media N]` marker** (above or below — it
doesn't matter to the parser, only to the reader). One prompt per line or
block; group them for readability.

```
[media 1]
%% danbooru: 1girl, solo, smile, looking_at_viewer, soft_lighting, pastel_background %%
%% minimax h3: slow zoom-in on a smiling girl, gentle morning light, 8s loop %%
> The first thing you notice is how calm she looks.
```

After the owner applies, this becomes **one media page** (an empty slot if the
comic has no media yet) with the bottom caption *"The first thing you notice
…"*. The two `%% … %%` lines are **gone from the comic** — they live only in
the text pane (and are dropped again the next time the text regenerates).

---

## 4. A complete, paste-ready example

This is a whole story the way an agent should emit it. Paste it into the text
box, hit **Update**, and the comic is built: three media slots (with captions),
two caption-only pages, and the artwork prompts parked in comments.

```
The rain had just stopped when Mara pushed the door open.

[media 1]
%% danbooru: 1girl, wet_hair, umbrella, city_street, rain, blue_hair, cozy_jacket %%
%% minimax h3: raindrops falling off an umbrella, soft city bokeh, 6s, slow motion %%
> She did not run. She had never been in a hurry to be anywhere.

[media 2]
%% danbooru: 1girl, cafe_interior, steam, coffee_cup, warm_light, afternoon %%
> The barista already knew her order.

---
Chapter two — the letter.

She found it tucked behind the register, the paper soft with age.
---

[media 3]
%% danbooru: 1girl, reading, close_up, expressive_eyes, emotional, tear %%
> Some words you only understand the second time you read them.

---
Epilogue.

The city kept its secrets, but it had given her one.
---
```

**What this applies to:**
- `[media 1]`, `[media 2]`, `[media 3]` → three media pages (empty slots the
  owner fills by dragging the generated artwork in), each with its bottom
  caption.
- The two `--- … ---` blocks → two **caption pages** (the "letter" scene and the
  "epilogue").
- Every `%% … %%` line → **stripped** (never in the preview / comic / copy).
- The other prose lines → kept in the text pane, **not** turned into pages.

The owner then generates the art from the danbooru / minimax prompts, drops the
files onto the three empty slots, and edits captions / prose in place.

---

## 5. Do / Don't

**Do**
- Blank-line between blocks.
- Keep captions *touching* their marker (top above, bottom below).
- Fence caption pages with an even number of `---`.
- Put artwork / video prompts in `%% … %%` comments.
- Use `[media ?]` (or an unused number) for a slot you know will be filled later.

**Don't**
- Put a blank line between a `>` caption and its marker (it detaches).
- Use `--` or `----` as a fence (must be exactly three dashes).
- Expect prose to become pages — it won't (it's kept as prose only).
- Rely on comments surviving a text regeneration (they're dropped by design —
  that's the "excluded stuff not affecting the source of truth" behaviour).
- Delete real media by omission — unmentioned media is kept, not removed.

---

## 6. Quick reference — the dialect at a glance

```
PROSE LINE                                   (kept, never a page)

> top caption                                (must touch the marker below)
[media 3]                                    (a media page, frozen number 3)
> bottom caption                             (must touch the marker above)

---                                          (fence OPEN)
caption page text — any number of lines
---                                          (fence CLOSE)

%% danbooru: 1girl, ... %%                   (comment — never rendered/applied)
%% minimax h3: slow zoom, 8s loop %%         (comment — multi-line ok)

[media ?]                                    (empty media slot — owner fills it)
```

The round-trip contract: `comic → markdown → blocks → apply` reproduces the
same comic. Author to this dialect and the editor will compile it, keep the
prompts out of the source of truth, and leave the comic ready to edit.
