// RD-ANALYTICS-12-10 — the Reports workspace presentation foundation.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The page rendered all eight catalogue reports to every caller and only discovered the
// permission problem after a click, as "You do not have permission to view this report".
// A manager saw seven doors and every one of them slammed. It also restated the payout
// statement's PDF-only rule locally, a third copy after the route and the catalogue.
//
// ═══ WHAT THESE TESTS ARE, AND ARE NOT ═══════════════════════════════════════
// The permission RULE is exercised against the real matrix: `ROLE_PERMISSIONS` from
// lib/team/types is what the SERVER authorizes with, and the filter is applied to the real
// catalogue. What is asserted is the projection — which reports a role may see — not the
// DOM. The page's markup is checked only where a claim would otherwise be unverifiable
// (that the local list is gone, that descriptions come from metadata).
//
// UI filtering is NOT authorization, and the last block pins that the server-side checks
// this phase must not have touched are still in place.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPORT_CATALOG, REPORT_DEFINITIONS } from '@/lib/reports/catalog'
import { ROLE_PERMISSIONS, type TeamRole, type TeamPermission } from '@/lib/team/types'
import type { ReportDefinition } from '@/lib/reports/types'

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const src = (p: string) =>
  raw(p).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const PAGE = 'app/(dashboard)/dashboard/finance/reports/page.tsx'
const UI = src(PAGE)

/**
 * The page's filter, restated here over the REAL role matrix.
 *
 * `useWorkspacePermissions` is a hook and cannot run outside React, but it is documented as
 * "a projection of the server's matrix, not a copy" — it derives `permissions` from
 * `ROLE_PERMISSIONS[role]`. Driving the same predicate from that array tests the rule the
 * page applies, against the same source the server authorizes with.
 */
const visibleFor = (role: TeamRole): ReportDefinition[] => {
  const held: TeamPermission[] = ROLE_PERMISSIONS[role]
  return REPORT_DEFINITIONS.filter(r => held.includes(r.permission))
}

// ─── A–D · the catalogue drives discovery ─────────────────────────────────────

describe('RD-ANALYTICS-12-10 · discovery comes from the catalogue', () => {
  it('1 · A · the page renders the catalogue, not a list of its own', () => {
    expect(UI).toContain('REPORT_DEFINITIONS')
    expect(UI).toContain("from '@/lib/reports/catalog'")
  })

  it('2 · B · no second report-definition array exists in the page', () => {
    expect(UI).not.toMatch(/kind:\s*'transactions'/)
    expect(UI).not.toMatch(/label:\s*'Transactions'/)
    expect(UI).not.toMatch(/label:\s*'Payout Statement'/)
    // …and no hardcoded description or format list either.
    expect(UI).not.toMatch(/\['csv',\s*'xlsx',\s*'pdf'\]/)
  })

  it('3 · C · catalogue order is the display order', () => {
    expect(REPORT_DEFINITIONS.map(d => d.kind)).toEqual([
      'transactions', 'settlements', 'wallet-ledger', 'donations',
      'refunds', 'broadcast-usage', 'gst', 'payout-statement',
    ])
  })

  it('4 · D · descriptions and formats are read from metadata', () => {
    expect(UI).toContain('r.description')
    expect(UI).toContain('r.formats')
    expect(UI).toContain('const formats = def.formats')
    for (const d of REPORT_DEFINITIONS) expect(d.description.length).toBeGreaterThan(0)
  })
})

// ─── E · permission-filtered visibility ───────────────────────────────────────

describe('RD-ANALYTICS-12-10 · only permitted reports are offered', () => {
  it('5 · the page filters on the catalogue permission via the shared hook', () => {
    expect(UI).toContain('useWorkspacePermissions')
    expect(UI).toContain('has(r.permission)')
  })

  it('6 · owner sees every report', () => {
    expect(visibleFor('owner')).toHaveLength(REPORT_DEFINITIONS.length)
  })

  it('7 · finance sees every report — its grant covers all three permissions in use', () => {
    const kinds = visibleFor('finance').map(r => r.kind)
    expect(kinds).toEqual(REPORT_DEFINITIONS.map(r => r.kind))
  })

  it('8 · admin sees NONE — it holds events, never transactions/settlements/wallet', () => {
    expect(visibleFor('admin')).toHaveLength(0)
  })

  it('9 · manager sees NONE — the role the old page showed seven dead doors to', () => {
    expect(visibleFor('manager')).toHaveLength(0)
  })

  it('10 · gate roles see NONE', () => {
    expect(visibleFor('checkin_staff')).toHaveLength(0)
    expect(visibleFor('checkin_lead')).toHaveLength(0)
  })

  it('11 · the rule is permission-driven, not role-driven', () => {
    // No role name is hardcoded in the page — the filter reads a permission.
    for (const role of ['owner', 'finance', 'admin', 'manager', 'checkin_staff', 'checkin_lead']) {
      expect(UI, role).not.toContain(`'${role}'`)
    }
  })

  it('12 · every visible report\'s permission is genuinely held by that role', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as TeamRole[]) {
      for (const r of visibleFor(role)) {
        expect(ROLE_PERMISSIONS[role], `${role} → ${r.kind}`).toContain(r.permission)
      }
    }
  })
})

// ─── F · UI filtering is not authorization ────────────────────────────────────

describe('RD-ANALYTICS-12-10 · the server remains authoritative', () => {
  it('13 · the sync route still authorizes on the registry permission before building', () => {
    const route = src('app/api/organizer/reports/[kind]/route.ts')
    const auth  = route.indexOf('authorizeWorkspace(req, meta.permission)')
    const build = route.indexOf('meta.build(')
    expect(auth).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(auth)
  })

  it('14 · export creation still authorizes on the report permission', () => {
    expect(src('app/api/organizer/reports/exports/route.ts'))
      .toContain('authorizeWorkspace(req, meta.permission)')
  })

  it('15 · poll, process, cancel and download still re-check it', () => {
    for (const p of ['route', 'process/route', 'cancel/route', 'download/route']) {
      expect(src(`app/api/organizer/reports/exports/[jobId]/${p}.ts`), p)
        .toContain('permissionForExportJob(job)')
    }
  })

  it('16 · the payout-statement route still enforces settlements', () => {
    expect(src('app/api/organizer/reports/payout-statement/route.ts'))
      .toContain("authorizeWorkspace(req, 'settlements')")
  })

  it('17 · the page contains no authorization decision of its own', () => {
    expect(UI).not.toMatch(/authorizeWorkspace|permissionForExportJob|ROLE_PERMISSIONS/)
  })
})

// ─── G/H · categories, and why there is no filter ─────────────────────────────

describe('RD-ANALYTICS-12-10 · no empty category scaffolding', () => {
  it('18 · every catalogued report is financial, so a category filter would be redundant', () => {
    const categories = new Set(REPORT_DEFINITIONS.map(d => d.category))
    expect([...categories]).toEqual(['financial'])
  })

  it('19 · no premature category tabs were added', () => {
    for (const c of ['Registrations', 'Operations', 'Communications', 'Participants']) {
      expect(UI, c).not.toContain(`>${c}<`)
    }
  })
})

// ─── I/J · specialized vs generic ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-10 · payout-statement stays specialized', () => {
  it('20 · the UI branches on catalogue output, not a local flag', () => {
    expect(UI).toContain("def.output === 'statement'")
    expect(UI).not.toMatch(/statement\?:\s*boolean/)
  })

  it('21 · it keeps its own endpoint', () => {
    expect(UI).toContain("'/api/organizer/reports/payout-statement'")
    expect(REPORT_CATALOG['payout-statement'].output).toBe('statement')
  })

  it('22 · PDF-only now comes from metadata, not a restated rule', () => {
    expect(REPORT_CATALOG['payout-statement'].formats).toEqual(['pdf'])
    expect(UI).not.toMatch(/isStatement\(def\)\s*\?\s*\['pdf'\]/)
  })

  it('23 · K · the seven generic reports remain generic', () => {
    for (const d of REPORT_DEFINITIONS.filter(r => r.kind !== 'payout-statement')) {
      expect(d.output, d.kind).toBe('table')
      expect(d.formats.sort(), d.kind).toEqual(['csv', 'pdf', 'xlsx'])
    }
  })
})

// ─── L · the execution spine is untouched ─────────────────────────────────────

describe('RD-ANALYTICS-12-10 · execution, filters and dates are preserved', () => {
  it('24 · preview, sync download, background export, polling and cancel are all still wired', () => {
    // `loadPreview` is a useCallback const; the rest are function declarations. Matching the
    // definition rather than one syntax, so this asserts existence and not spelling.
    for (const fn of ['loadPreview', 'download', 'generateBackground', 'driveExport', 'cancelExport', 'downloadExport']) {
      expect(UI, fn).toMatch(new RegExp(`(function|const)\\s+${fn}\\b`))
    }
  })

  it('25 · the background export posts the EFFECTIVE report', () => {
    // A selection corrected by permissions must export what is on screen, not the raw intent.
    expect(UI).toContain('kind: def.kind')
    expect(UI).not.toMatch(/JSON\.stringify\(\{ kind, format, filters \}\)/)
  })

  it('26 · event, campaign and status filters survive, and only for table reports', () => {
    for (const f of ['setEvent', 'setCampaign', 'setStatus']) expect(UI, f).toContain(f)
    expect(UI).toContain('!isStatement(def) && <>')
  })

  it('27 · date handling is unchanged — no presets, no timezone conversion', () => {
    expect(UI).toContain('daysAgo(30)')
    expect(UI).not.toMatch(/PRESET_DAYS|presetRange|dateRange|IST|Asia\/Kolkata/)
  })

  it('28 · no event SCOPE was introduced', () => {
    expect(UI).not.toMatch(/EventSelector|EventContextProvider|useEventContext/)
  })

  /**
   * SUPERSEDED BY RD-ANALYTICS-12-11 — deliberately rewritten rather than deleted.
   *
   * This case guarded 12-10's scope: History belonged to a later phase and must not appear
   * early. 12-11 then implemented it, so asserting its absence would now pin the product
   * backwards. What is still worth defending is the SHAPE the guard was protecting: History
   * arrived as a mode of this page, and it did not reach into Firestore or grow a route.
   */
  it('29 · History (RD-12-11) arrived as a mode of this page, not as a second system', () => {
    // Still true, and the reason the client cannot read the collection itself.
    expect(UI).not.toContain('reportExportJobs')
    expect(UI).not.toMatch(/from 'firebase\/firestore'/)
    // It reads the server, on the same route.
    expect(UI).toContain('/api/organizer/reports/history')
    expect(UI).toMatch(/'reports'\s*\|\s*'history'/)
  })
})

// ─── N · empty state, and accessibility ───────────────────────────────────────

describe('RD-ANALYTICS-12-10 · empty state and semantics', () => {
  it('30 · N · a caller with no permitted reports gets an explanation, not a blank list', () => {
    expect(UI).toContain('No reports available')
    expect(UI).toContain('available.length === 0')
    // Not shown while permissions are still resolving — the hook is optimistic until then.
    expect(UI).toContain('!perms.loading')
  })

  it('30b · with nothing available, the controls that act on a report are gone too', () => {
    // Found in BROWSER QA, not by these tests: hiding only the report list left a manager
    // reading "No reports available" directly above a filter bar, three download buttons,
    // a background-export panel, and "You do not have permission to view this report" —
    // controls for a report they cannot open, and an error for a request made on their
    // behalf. The page body is now gated on the same condition as the list.
    expect(UI).toContain('const noneAvailable = !perms.loading && available.length === 0')
    // RD-12-11 added `mode === 'reports'` to the same guard when History became a sibling
    // tab; the `noneAvailable` half — the part this case exists for — is unchanged.
    expect(UI).toContain("{!noneAvailable && mode === 'reports' && <>")
    // …and no preview is fetched for a report the caller cannot open.
    expect(UI).toContain('if (!u || noneAvailable) return')
  })

  it('31 · the empty state names no report the caller may not see', () => {
    const block = UI.slice(UI.indexOf('No reports available'), UI.indexOf('No reports available') + 400)
    for (const d of REPORT_DEFINITIONS) expect(block, d.kind).not.toContain(d.label)
  })

  it('32 · selection uses real buttons with pressed state and a focus ring', () => {
    expect(UI).toContain('type="button"')
    expect(UI).toContain('aria-pressed={selected}')
    expect(UI).toContain('focus-visible:ring-2')
    expect(UI).toContain('role="group"')
  })

  it('33 · selection is not signalled by colour alone', () => {
    // Border, tint and font-weight all change with `selected`.
    expect(UI).toContain("selected ? 'font-semibold text-primary' : 'font-medium text-foreground'")
    expect(UI).toContain("'border-primary bg-primary/[0.06]'")
  })
})
