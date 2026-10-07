// ─── storyModel — reading the organiser's own long description as structure ──
//
// SPORTS-ONLY, and DIRECTIVE-FREE so the server-rendered story section can call it.
//
// The About copy is one long free-text field. For the Noyyal event the organiser
// already wrote it with structure:
//
//   🌊 Key Objectives
//   💧 Restoration of Waterways
//   <paragraph>
//   📢 Creating Public Awareness
//   <paragraph>
//   …
//   💧 Conclusion
//   <paragraph>
//
// This module READS that structure. It invents nothing, drops nothing and rewrites
// nothing: every character of the source ends up either in a heading or in a body
// paragraph, in the original order. A heading is a short line (≤ 72 chars) that opens
// with a pictograph or is followed by body text and carries no terminal '.', ':' or
// '?'. A heading whose next line is ANOTHER heading is a GROUP (a part title, like
// "Key Objectives"); otherwise it is an ENTRY with its paragraphs beneath.
//
// If the copy has no such structure — most events — `parseStory` returns a single
// group with a single untitled entry holding the whole text, and the section renders
// it as flowing prose. That is the honest fallback: no imposed shape.

export interface StoryEntry {
  /** '' when the source had no heading for this block. */
  title:  string
  /** The leading pictograph of the heading, when it had one. Display-only. */
  mark:   string
  /** One string per source paragraph, in order. */
  body:   string[]
}

export interface StoryGroup {
  /** '' when the source had no part title. */
  title:   string
  mark:    string
  entries: StoryEntry[]
}

export interface Story {
  groups: StoryGroup[]
  /** The last entry when its heading reads as a closing statement — rendered as a
   *  pull quote. Never invented: it is the source's own final block. */
  closing: StoryEntry | null
  /** True when the copy carried no headings at all and is rendered as prose. */
  plain:   boolean
}

/** A leading pictograph (emoji), if the line starts with one. */
const LEAD_MARK = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u

const CLOSING_WORDS = /^(conclusion|in closing|closing note|summary|final word)$/i

function splitMark(line: string): { mark: string; text: string } {
  const m = LEAD_MARK.exec(line)
  return m ? { mark: m[1], text: line.slice(m[0].length).trim() } : { mark: '', text: line.trim() }
}

/** Is this line a heading rather than body copy? */
function isHeading(line: string, next: string | undefined): boolean {
  const { mark, text } = splitMark(line)
  if (!text || text.length > 72) return false
  if (/[.:?;]$/.test(text)) return false
  if (text.split(/\s+/).length > 10) return false
  // A pictograph-led short line is the organiser's own heading marker.
  if (mark) return true
  // Otherwise it only counts as a heading when body copy follows it.
  return !!next && next.length > 0 && !isShortLine(next)
}

const isShortLine = (s: string) => s.length <= 72 && !/[.:?;]$/.test(s)

export function parseStory(description: string): Story {
  const src = (description ?? '').replace(/\r\n/g, '\n').trim()
  if (!src) return { groups: [], closing: null, plain: true }

  const lines = src.split('\n').map(l => l.trim())

  // ── Pass 1: lines → blocks (heading | body paragraph) ──────────────────────
  type Block = { kind: 'h' | 'p'; mark: string; text: string }
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => { if (para.length) { blocks.push({ kind: 'p', mark: '', text: para.join(' ') }); para = [] } }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) { flush(); continue }
    const next = lines.slice(i + 1).find(l => l.length > 0)
    if (isHeading(line, next)) {
      flush()
      const { mark, text } = splitMark(line)
      blocks.push({ kind: 'h', mark, text })
    } else {
      para.push(line)
    }
  }
  flush()

  if (!blocks.some(b => b.kind === 'h')) {
    const body = blocks.map(b => b.text).filter(Boolean)
    return { groups: [{ title: '', mark: '', entries: [{ title: '', mark: '', body }] }], closing: null, plain: true }
  }

  // ── Pass 2: blocks → groups of entries ─────────────────────────────────────
  const groups: StoryGroup[] = []
  let group: StoryGroup = { title: '', mark: '', entries: [] }
  let entry: StoryEntry | null = null

  const pushEntry = () => { if (entry && (entry.title || entry.body.length)) group.entries.push(entry); entry = null }
  const pushGroup = () => { pushEntry(); if (group.title || group.entries.length) groups.push(group) }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind === 'p') {
      if (!entry) entry = { title: '', mark: '', body: [] }
      entry.body.push(b.text)
      continue
    }
    // A heading whose successor is also a heading titles a PART of the story.
    const nextIsHeading = blocks[i + 1]?.kind === 'h'
    if (nextIsHeading) {
      pushGroup()
      group = { title: b.text, mark: b.mark, entries: [] }
    } else {
      pushEntry()
      entry = { title: b.text, mark: b.mark, body: [] }
    }
  }
  pushGroup()

  // ── The closing statement, when the source named one ───────────────────────
  let closing: StoryEntry | null = null
  const lastGroup = groups[groups.length - 1]
  const lastEntry = lastGroup?.entries[lastGroup.entries.length - 1]
  if (lastEntry && CLOSING_WORDS.test(lastEntry.title) && lastEntry.body.length) {
    closing = lastEntry
    lastGroup.entries = lastGroup.entries.slice(0, -1)
    if (!lastGroup.entries.length && !lastGroup.title) groups.pop()
  }

  return { groups: groups.filter(g => g.title || g.entries.length), closing, plain: false }
}
