// RD-COMMS-TABS-01 (unit, source contract) — every <Link> rendered inside the Communication Center
// that points back at /dashboard/communications must carry prefetch={false}.
//
// Why: the tabs are the URL (?tab=, router.replace). In Next 16.2.7 a viewport PREFETCH of the same
// static route, on a page hard-loaded WITH a query string (?eventId=… from the event selector),
// makes the router silently drop every later same-route navigation — the tab buttons stop working
// while cross-route links still do. Reproduced on a production build; blocking only the prefetch
// requests restored every tab. The links still navigate normally; only the prefetch is off.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const PAGE_DIR = 'app/(dashboard)/dashboard/communications'
const OV = 'components/communications/overview/CommunicationOverview.tsx'
const AN = 'components/communications/analytics/AnalyticsDashboard.tsx'

/** Files whose components render INSIDE the Communication Center page (page.tsx embeds these). */
function scannedFiles(): string[] {
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap(name => {
    const rel = `${dir}/${name}`
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : rel.endsWith('.tsx') ? [rel] : []
  })
  return [
    ...walk('components/communications'),
    `${PAGE_DIR}/page.tsx`,
    `${PAGE_DIR}/notifications/page.tsx`,
    `${PAGE_DIR}/reminders/page.tsx`,
    ...walk(`${PAGE_DIR}/broadcasts`),
  ]
}

/**
 * Links whose href is an expression that is known to leave the Communication Center, so a
 * prefetch there is harmless. Every entry needs a reason; anything not listed is treated as
 * same-page, which fails safe (a missing prefetch={false} is reported, never assumed fine).
 */
const OFF_PAGE: Record<string, string> = {
  'components/communications/CommUsage.tsx::usage.manageHref': "the event's License & Services page (increase limit)",
}

interface LinkTag { file: string; line: number; tag: string; href: string | null; literal: boolean }

/** Every `<Link …>` opening tag, read up to its closing `>` at brace depth 0 (so `=>` inside `{}` is skipped). */
function findLinks(file: string, src: string): LinkTag[] {
  const out: LinkTag[] = []
  const re = /<Link[\s>]/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0, quote: string | null = null, i = m.index + 5
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) { if (c === quote) quote = null; continue }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    const tag = src.slice(m.index, i + 1)
    const lit = /\bhref="([^"]*)"/.exec(tag)
    const expr = /\bhref=\{([^}]*)\}/.exec(tag)
    out.push({
      file, line: src.slice(0, m.index).split('\n').length, tag,
      href: lit ? lit[1] : expr ? expr[1].trim() : null, literal: Boolean(lit),
    })
  }
  return out
}

const isSamePageLiteral = (href: string) => /^\/dashboard\/communications(?:[?#]|$)/.test(href)
const isSamePage = (l: LinkTag) => l.literal ? isSamePageLiteral(l.href!) : !OFF_PAGE[`${l.file}::${l.href}`]
const hasPrefetchOff = (tag: string) => /\bprefetch=\{false\}/.test(tag)

const files = scannedFiles()
const links = files.flatMap(f => findLinks(f, readFileSync(join(ROOT, f), 'utf8')))

describe('same-page Communication Center links never prefetch', () => {
  it('the scan reaches the embedded tabs and finds their links (the checker is not silently empty)', () => {
    expect(files).toContain(`${PAGE_DIR}/notifications/page.tsx`)
    expect(files).toContain(`${PAGE_DIR}/reminders/page.tsx`)
    expect(files).toContain(OV)
    expect(files).toContain(AN)
    expect(links.length).toBeGreaterThanOrEqual(9)
    expect(links.every(l => l.href !== null)).toBe(true)
  })

  it('every same-page <Link> has prefetch={false}', () => {
    const offenders = links.filter(l => isSamePage(l) && !hasPrefetchOff(l.tag)).map(l => `${relative(ROOT, join(ROOT, l.file))}:${l.line} href=${l.href}`)
    expect(offenders).toEqual([])
  })

  it('the links that triggered the production bug are covered', () => {
    const at = (file: string, href: string) => links.find(l => l.file === file && l.href === href)
    for (const [file, href] of [
      [OV, '/dashboard/communications?tab=analytics'], [OV, '/dashboard/communications?tab=usage'], [OV, 'a.href'],
      [AN, 'i.href'], [AN, 'usageHref'], [AN, 't.href'],
      [`${PAGE_DIR}/reminders/page.tsx`, '/dashboard/communications'],
      [`${PAGE_DIR}/notifications/page.tsx`, 'COMMUNICATION_USAGE_HREF'],
    ] as const) {
      const l = at(file, href)
      expect(l, `${file} href=${href}`).toBeDefined()
      expect(hasPrefetchOff(l!.tag), `${file} href=${href}`).toBe(true)
    }
  })

  it('the expression hrefs treated as same-page really do target this page', () => {
    const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
    expect(src('lib/wallet/communicationBalance.ts')).toMatch(/COMMUNICATION_USAGE_HREF = '\/dashboard\/communications\?tab=usage'/)
    expect(src('lib/communications/overviewModel.ts')).toMatch(/MESSAGES_TAB = '\/dashboard\/communications\?tab=messages'/)
    expect(src(AN)).toMatch(/const usageHref = `\/dashboard\/communications\?tab=usage/)
    const computeHrefs = src('lib/communications/organizerAnalytics/compute.ts').match(/href(?: = |: )(?:href \?\? )?`[^`]*`/g) ?? []
    expect(computeHrefs.length).toBeGreaterThan(0)
    for (const h of computeHrefs) expect(h).toMatch(/`\/dashboard\/communications\?tab=/)
  })

  it('the checker flags a same-page link without prefetch={false} and ignores off-page literals', () => {
    const fixture = [
      '<Link href="/dashboard/communications?tab=usage" className="x">Usage</Link>',
      '<Link href={x.href} onClick={() => go()} className="y">Go</Link>',
      '<Link href="/dashboard/events" className="z">Events</Link>',
      '<Link href="/dashboard/communications" prefetch={false}>Back</Link>',
    ].join('\n')
    const found = findLinks('fixture.tsx', fixture)
    expect(found.map(l => l.href)).toEqual(['/dashboard/communications?tab=usage', 'x.href', '/dashboard/events', '/dashboard/communications'])
    expect(found.filter(l => isSamePage(l) && !hasPrefetchOff(l.tag)).map(l => l.line)).toEqual([1, 2])
  })
})
