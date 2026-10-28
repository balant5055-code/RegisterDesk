// RichText — the event description, rendered as the SAFE Markdown subset the wizard promises.
//
// RD-MARKDOWN-01. The event wizard labels Full Description "markdown supported", but every template
// printed it as raw text, so `**bold**` arrived on the page with its asterisks. This renders:
//
//   blocks:  paragraphs (blank-line separated; a single newline is a line break) · `#`–`######`
//            headings · `- ` / `* ` bullet lists · `1. ` numbered lists
//   inline:  **bold** · *italic* / _italic_ · [text](https://…) links
//
// SAFE BY CONSTRUCTION: it builds React elements from text — there is no dangerouslySetInnerHTML
// and no HTML pass-through, so any `<tag>` the organizer typed is shown as text. A link is rendered
// only for an http(s) or mailto target; anything else (javascript:, data:, relative) stays plain
// text. Links open in a new tab with rel="noopener noreferrer nofollow ugc".
//
// STYLING is inherited: the caller passes the classes its old <p> had (colour, size, leading), so a
// plain-text description looks exactly as before. Headings and lists only add weight and indent.
//
// No 'use client' and no hooks — Server and Client Components can both use it.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export type MdBlock =
  | { kind: 'h';  level: number; text: string }
  | { kind: 'p';  lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const BULLET  = /^[-*•]\s+(.+)$/
const NUMBER  = /^\d{1,3}[.)]\s+(.+)$/

/** PURE. Markdown source → blocks. Plain text without markers becomes paragraphs only. */
export function parseMarkdownBlocks(src: string | null | undefined): MdBlock[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  const flushPara = () => { if (para.length) blocks.push({ kind: 'p', lines: para }); para = [] }
  const flushList = () => { if (list) blocks.push(list); list = null }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flushPara(); flushList(); continue }
    const h = HEADING.exec(line)
    if (h) { flushPara(); flushList(); blocks.push({ kind: 'h', level: h[1].length, text: h[2] }); continue }
    const b = BULLET.exec(line)
    const n = b ? null : NUMBER.exec(line)
    if (b || n) {
      const kind = b ? 'ul' : 'ol'
      flushPara()
      if (list && list.kind !== kind) flushList()
      if (!list) list = { kind, items: [] }
      list.items.push((b ?? n)![1])
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara(); flushList()
  return blocks
}

/** An http(s) / mailto target, else null. */
export function safeHref(raw: string): string | null {
  const s = raw.trim()
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(s)) return s
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

// Earliest-match inline scanner. Order matters only for ties at the same index.
const INLINE: { re: RegExp; kind: 'link' | 'bold' | 'italic' }[] = [
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,                kind: 'link'   },
  { re: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/,            kind: 'bold'   },
  { re: /(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![*\w])/, kind: 'italic' },
  { re: /(?<![\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w])/, kind: 'italic' },
]

/** PURE. Inline Markdown → React nodes (text is never interpreted as HTML). */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let k = 0
  while (rest) {
    let best: { m: RegExpExecArray; kind: 'link' | 'bold' | 'italic' } | null = null
    for (const { re, kind } of INLINE) {
      const m = re.exec(rest)
      if (m && (!best || m.index < best.m.index)) best = { m, kind }
    }
    if (!best) { out.push(rest); break }
    const { m, kind } = best
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const key = `${keyPrefix}-${k++}`
    if (kind === 'bold')   out.push(<strong key={key} className="font-semibold">{renderInline(m[1], key)}</strong>)
    if (kind === 'italic') out.push(<em key={key}>{renderInline(m[1], key)}</em>)
    if (kind === 'link') {
      const href = safeHref(m[2])
      out.push(href
        ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="underline underline-offset-2 hover:opacity-80">{renderInline(m[1], key)}</a>
        : <span key={key}>{m[1]}</span>)
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

/** PURE. The description as plain text — for previews, meta descriptions and clamped snippets. */
export function stripMarkdown(src: string | null | undefined): string {
  return parseMarkdownBlocks(src).map(b =>
    b.kind === 'p' ? b.lines.join(' ') : b.kind === 'h' ? b.text : b.items.join(' · '),
  ).join('\n\n')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*(\S[\s\S]*?\S|\S)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1')
    .replace(/(?<![\w])_([^_\n]+?)_(?![\w])/g, '$1')
}

/** Renders already-parsed blocks (callers that show only the first N use this). */
export function RichBlocks({ blocks, className, blockClassName }: {
  blocks: MdBlock[]
  /** The wrapper — pass the classes the description's old <p> carried. */
  className?: string
  /** Extra classes for each paragraph / list (e.g. a max width). */
  blockClassName?: string
}) {
  if (blocks.length === 0) return null
  return (
    <div className={cn('space-y-[0.9em]', className)}>
      {blocks.map((b, i) => {
        const key = `b${i}`
        if (b.kind === 'h') {
          const cls = cn('font-semibold text-balance', b.level <= 2 ? 'text-[1.15em]' : 'text-[1.05em]', blockClassName)
          return b.level <= 2
            ? <h3 key={key} className={cls}>{renderInline(b.text, key)}</h3>
            : <h4 key={key} className={cls}>{renderInline(b.text, key)}</h4>
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const List = b.kind === 'ul' ? 'ul' : 'ol'
          return (
            <List key={key} className={cn(b.kind === 'ul' ? 'list-disc' : 'list-decimal', 'space-y-1 pl-5', blockClassName)}>
              {b.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}
            </List>
          )
        }
        return (
          <p key={key} className={blockClassName}>
            {b.lines.map((line, j) => (
              <span key={j}>{j > 0 && <br />}{renderInline(line, `${key}-${j}`)}</span>
            ))}
          </p>
        )
      })}
    </div>
  )
}

/** The whole description. Renders nothing for an empty one. */
export function RichText({ text, className, blockClassName }: { text: string | null | undefined; className?: string; blockClassName?: string }) {
  return <RichBlocks blocks={parseMarkdownBlocks(text)} className={className} blockClassName={blockClassName} />
}
