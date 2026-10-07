// RD-ANALYTICS-12-11 — the History surface on the Reports workspace.
//
// ═══ WHAT THESE COVER, AND WHAT THEY DELIBERATELY DO NOT ═════════════════════
// The behaviour that MATTERS is server-side and is tested against the real handler in
// tests/unit/reportHistoryReader.test.ts — tenancy, permission filtering, projection,
// bounds. Nothing here re-tests any of that, because a client assertion cannot prove a
// security property.
//
// What is left for this file is the set of claims about the PAGE that are otherwise
// unverifiable: that History is a mode of the existing workspace rather than a second page,
// that it reuses the existing download route rather than minting its own, that it never
// touches Firestore directly, and that the states a list needs — loading, empty, error,
// end-of-feed — actually exist. These are source contracts, which is the right instrument:
// each one is a decision that could be silently reversed by an edit, and none of them is a
// DOM structure that will churn.
//
// The one thing NOT asserted by reading source is the rendering itself. That was validated
// in a real browser, which is also where 12-10's genuine defect was found.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPORT_CATALOG } from '@/lib/reports/catalog'

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments stripped — explanatory prose about a rule must not satisfy the rule's own guard. */
const src = (p: string) =>
  raw(p).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const PAGE = 'app/(dashboard)/dashboard/finance/reports/page.tsx'
const UI   = src(PAGE)

// ─── A–B · one workspace, two modes ───────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · History is a mode of the Reports workspace', () => {
  it('1 · B · a History mode exists on the existing page', () => {
    expect(UI).toMatch(/'reports'\s*\|\s*'history'/)
    expect(UI).toContain('HistoryPanel')
  })

  it('2 · A · the Reports mode still owns discovery, filters, execution and export', () => {
    // Everything 12-10 and OE-3 built must still be reachable — behind the Reports tab,
    // not removed.
    expect(UI).toContain("mode === 'reports'")
    expect(UI).toContain('REPORT_DEFINITIONS')
    expect(UI).toContain('visibleReports')
    expect(UI).toContain('loadPreview')
    expect(UI).toContain('generateBackground')
    expect(UI).toContain('driveExport')
    expect(UI).toContain('cancelExport')
  })

  it('3 · the active-export panel is untouched and still lives on the Reports tab', () => {
    expect(UI).toContain('Large dataset?')
    expect(UI).toContain('exportJob')
    // It still drives its own job rather than reading the History feed.
    expect(UI).toMatch(/setExportJob\(/)
  })

  it('4 · no new route was created — History has no page of its own', () => {
    let exists = true
    try { raw('app/(dashboard)/dashboard/finance/reports/history/page.tsx') } catch { exists = false }
    expect(exists, 'History must not become its own route').toBe(false)
    // /dashboard/reports is ANALYTICS under the approved architecture and must keep
    // existing — untouched, and with none of this phase's work in it.
    expect(raw('app/(dashboard)/dashboard/reports/page.tsx')).not.toContain('HistoryPanel')
    expect(raw('app/(dashboard)/dashboard/reports/page.tsx')).not.toContain('reports/history')
  })

  it('5 · navigation was not touched', () => {
    const nav = src('config/workspaceNav.ts')
    // History is a MODE of the Reports workspace, never a navigation destination of its own.
    expect(nav).not.toContain('reports/history')
    expect(nav).not.toContain("label: 'History'")
    /**
     * RD-ANALYTICS-12-13 · was `expect(nav).toContain("href: '/dashboard/reports'")`.
     *
     * That asserted the Analytics row's destination, which was 12-11's way of saying "this
     * phase migrated no route". 12-13 then legitimately repointed that row at the canonical
     * Analytics workspace and gave Reports a row of its own — so the old assertion would now
     * pin the navigation backwards. What this case is really defending is that the REPORTS
     * workspace has one canonical URL and History did not become a second one.
     */
    expect(nav).toContain("href: '/dashboard/finance/reports'")
  })

  it('6 · the tab is a real tablist with semantic buttons, not clickable divs', () => {
    expect(UI).toContain('role="tablist"')
    expect(UI).toContain('role="tab"')
    expect(UI).toContain('aria-selected')
    // And selection is not carried by colour alone.
    expect(UI).toMatch(/border-primary font-semibold text-primary/)
  })

  it('7 · History is hidden when the caller has no finance report at all', () => {
    // 12-10's empty state ends the page; a History tab there would only invite a click
    // that proves a negative.
    expect(UI).toMatch(/!noneAvailable && mode === 'history'/)
    expect(UI).toMatch(/\{!noneAvailable && \(\s*<div role="tablist"/)
  })
})

// ─── C–E · the states a list needs ────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · loading, empty, error and end states', () => {
  it('8 · D · a loading state exists for the first read', () => {
    expect(UI).toMatch(/loading && rows === null/)
    expect(UI).toContain('animate-spin')
  })

  it('9 · C · the empty state explains without naming anything hidden', () => {
    expect(UI).toContain('No report exports yet')
    // It must not imply that reports exist which this caller may not see.
    expect(UI).not.toMatch(/permission denied|unauthori[sz]ed|not allowed to see/i)
  })

  it('10 · E · an error state exists, with a retry, and shows no server internals', () => {
    expect(UI).toContain('Could not load report history.')
    expect(UI).toContain('Try again')
    // The caught error is never rendered — only the fixed message above.
    expect(UI).not.toMatch(/\{\s*(err|e)\.message\s*\}/)
  })

  it('11 · an end-of-feed state exists, so "load more" does not simply vanish', () => {
    expect(UI).toContain('End of history')
  })
})

// ─── F–G · status and lifecycle rendering ─────────────────────────────────────

describe('RD-ANALYTICS-12-11 · statuses are the real ones', () => {
  it('12 · F · every real job status has a label, and none is invented', () => {
    for (const s of ['pending', 'processing', 'completed', 'failed', 'cancelled']) {
      expect(UI, s).toContain(`${s}:`)
    }
    // `expired` is a DOWNLOAD state, never a job status — there is no such status in storage.
    expect(UI).not.toMatch(/expired:\s*'/)
    expect(UI).not.toMatch(/status === 'expired'/)
  })

  it('13 · G · an expired artifact renders as unavailable, not as a download button', () => {
    expect(UI).toContain('Download expired')
    expect(UI).toMatch(/row\.download === 'available' \?/)
  })

  it('14 · status is not carried by colour alone', () => {
    // The pill prints the word; the tint only reinforces it.
    expect(UI).toMatch(/\{label\[status\] \?\? status\}/)
  })
})

// ─── H · download reuse ───────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · downloads go through the one existing route', () => {
  it('15 · H · History calls the existing authenticated download endpoint', () => {
    expect(UI).toMatch(/\/api\/organizer\/reports\/exports\/\$\{jobId\}\/download/)
    expect(UI).toContain('onDownload')
  })

  it('16 · no History-specific download route was created', () => {
    let exists = true
    try { raw('app/api/organizer/reports/history/[jobId]/download/route.ts') } catch { exists = false }
    expect(exists).toBe(false)
  })

  it('17 · no token is ever put in a URL, and no signed URL is stored', () => {
    expect(UI).not.toMatch(/\?token=/)
    expect(UI).not.toMatch(/window\.open\(/)
    expect(UI).not.toMatch(/signedUrl|signed_url/i)
    // The credential travels as a header, as it has since 12-04.
    expect(UI).toContain('Authorization: `Bearer ${token}`')
  })

  it('18 · the download helper is shared, not duplicated for History', () => {
    // Exactly one function performs an export download in this page.
    const hits = UI.match(/exports\/\$\{jobId\}\/download/g) ?? []
    expect(hits.length).toBe(1)
  })
})

// ─── I–J · data source and pagination ─────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · the client reads the server, never Firestore', () => {
  it('19 · History fetches the server endpoint', () => {
    expect(UI).toContain('/api/organizer/reports/history')
  })

  it('20 · the page imports no Firebase client SDK query surface', () => {
    expect(UI).not.toMatch(/from 'firebase\/firestore'/)
    expect(UI).not.toContain('onSnapshot')
    expect(UI).not.toContain('collection(db')
    // And never the server registry, which would drag firebase-admin into the bundle.
    expect(UI).not.toContain("@/lib/reports/registry")
  })

  it('21 · J · pagination is a cursor and a "load more", with no page numbers', () => {
    expect(UI).toContain('Load more')
    expect(UI).toMatch(/cursor=\$\{encodeURIComponent/)
    expect(UI).not.toMatch(/[?&]page=/)
    expect(UI).not.toMatch(/[?&]offset=/)
  })

  it('22 · the raw cursor is never displayed', () => {
    expect(UI).not.toMatch(/\{cursor\}/)
  })

  it('23 · History is server-backed — a refresh cannot lose a job', () => {
    // The defect this phase exists for: the export was only ever in React state.
    expect(UI).toMatch(/useEffect\(\(\) => \{[\s\S]{0,240}load\(null\)/)
  })
})

// ─── K · labels, formats and retired kinds ────────────────────────────────────

describe('RD-ANALYTICS-12-11 · labels come from the catalogue', () => {
  it('24 · K · the row label is resolved from the catalogue, with the raw kind as fallback', () => {
    expect(UI).toMatch(/REPORT_CATALOG\[row\.kind\]\?\.label \?\? row\.kind/)
    expect(UI).toContain("from '@/lib/reports/catalog'")
  })

  it('25 · no report label is hardcoded in the History panel', () => {
    // Scoped to the panel: the payout-statement PREVIEW on the Reports tab legitimately
    // prints line labels such as 'Refunds', and this rule is about History's own rows.
    const panel = UI.slice(UI.indexOf('function HistoryPanel'), UI.indexOf('function StatusPill'))
    expect(panel.length).toBeGreaterThan(500)
    for (const def of Object.values(REPORT_CATALOG)) {
      expect(panel, def.label).not.toContain(`'${def.label}'`)
    }
  })

  it('26 · the format shown is the job\'s stored format, not a local rule', () => {
    expect(UI).toMatch(/\{row\.format\}/)
    // No second copy of the payout statement's PDF-only restriction.
    expect(UI).not.toMatch(/\['pdf'\]/)
  })

  it('27 · a retired kind renders instead of breaking the list', () => {
    expect(UI).toMatch(/\?\? row\.kind \?\? 'Unknown report'/)
  })
})

// ─── the scope guard ──────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · nothing outside History moved', () => {
  it('28 · date semantics are still inclusive UTC day bounds, unchanged', () => {
    const fmt = src('lib/reports/format.ts')
    expect(fmt).toContain("T00:00:00.000Z")
    expect(fmt).toContain("T23:59:59.999Z")
    // No timezone conversion crept into the reader. `\bIST\b` and not `IST`, which is a
    // substring of HISTORY and matched this module's own constant names.
    expect(src('lib/reports/history.ts')).not.toMatch(/Asia\/Kolkata|\bIST\b|toLocaleDate/)
  })

  it('29 · no EventSelector and no EventContextProvider', () => {
    expect(UI).not.toContain('EventSelector')
    expect(UI).not.toContain('EventContextProvider')
    expect(UI).not.toContain('useEventContext')
  })

  it('30 · no retention, cleanup or scheduling was implemented', () => {
    const h = src('lib/reports/history.ts')
    for (const forbidden of ['RETENTION', 'cleanup', 'cron', 'schedule', 'delete']) {
      expect(h.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase())
    }
  })

  it('31 · no filter beyond the feed itself was built', () => {
    // §22 asked for the minimal first version: newest-first, paginated, no filters.
    const route = src('app/api/organizer/reports/history/route.ts')
    expect(route).not.toMatch(/searchParams\.get\(['"](status|kind|creator|event|campaign)['"]\)/)
  })
})
