// RD-ANALYTICS-12-08 — the registry is the single source of report metadata.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The registry described a report as `{ kind, label, permission, build }` — enough to
// dispatch it, nothing a UI could render. So `finance/reports/page.tsx` kept its own array of
// the same eight reports with the labels restated, and adding a report meant remembering two
// places. Two definitions of one thing drift; these tests exist so they cannot.
//
// ═══ THE PROPERTY THAT MATTERS MOST ══════════════════════════════════════════
// Consolidating metadata must not move a single byte of RUNTIME behaviour. `ORGANIZER_REPORTS`
// still holds exactly seven kinds with exactly the permissions they had, `payout-statement` is
// still NOT dispatchable through it, and unknown kinds still fail closed.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The registry value-imports the builders, which import firebase-admin. Stubbed so this suite
// can read the real registry without a database.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const { ORGANIZER_REPORTS, ORGANIZER_REPORT_KINDS } = await import('@/lib/reports/registry')
const { REPORT_CATALOG, REPORT_DEFINITIONS } = await import('@/lib/reports/catalog')
const builders = await import('@/lib/reports/builders')

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const src = (p: string) =>
  raw(p).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

/** The seven table kinds and their permissions, as they were before this phase. */
const DISPATCHED: Array<[string, string]> = [
  ['transactions',    'transactions'],
  ['settlements',     'settlements'],
  ['wallet-ledger',   'wallet'],
  ['donations',       'transactions'],
  ['refunds',         'transactions'],
  ['broadcast-usage', 'wallet'],
  ['gst',             'transactions'],
]

// ─── A, D · metadata completeness ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-08 · every catalogued report is fully described', () => {
  it('1 · A · each entry carries every required field', () => {
    for (const def of REPORT_DEFINITIONS) {
      expect(def.kind, 'kind').toBeTruthy()
      expect(def.label, `${def.kind} label`).toBeTruthy()
      expect(def.description, `${def.kind} description`).toBeTruthy()
      expect(def.category, `${def.kind} category`).toBe('financial')
      expect(def.permission, `${def.kind} permission`).toBeTruthy()
      expect(def.formats.length, `${def.kind} formats`).toBeGreaterThan(0)
      expect(['workspace', 'event']).toContain(def.scope)
      expect(typeof def.dateRange).toBe('boolean')
      expect(['table', 'statement']).toContain(def.output)
    }
  })

  it('2 · descriptions are one factual sentence, not marketing copy', () => {
    for (const def of REPORT_DEFINITIONS) {
      expect(def.description.endsWith('.'), def.kind).toBe(true)
      expect(def.description.length, def.kind).toBeLessThan(120)
      expect(def.description, def.kind).not.toMatch(/powerful|seamless|effortless|best-in-class|!/i)
    }
  })

  it('3 · D · the map key and the entry\'s own kind agree, so there are no duplicates', () => {
    for (const [key, def] of Object.entries(REPORT_CATALOG)) expect(def.kind).toBe(key)
    const kinds = REPORT_DEFINITIONS.map(d => d.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('4 · no capability is claimed — every current report is universal', () => {
    // All eight are financial and apply to all nine event types. The field exists for future
    // operational reports and must not be set speculatively.
    for (const def of REPORT_DEFINITIONS) expect(def.capability).toBeUndefined()
  })
})

// ─── B, C, E, F · the runtime map is unchanged ────────────────────────────────

describe('RD-ANALYTICS-12-08 · runtime dispatch is byte-for-byte what it was', () => {
  it('5 · B · exactly the seven table kinds are dispatchable', () => {
    expect(ORGANIZER_REPORT_KINDS.sort()).toEqual(DISPATCHED.map(([k]) => k).sort())
    expect(ORGANIZER_REPORT_KINDS).toHaveLength(7)
  })

  it('6 · E · every permission is the one it was before consolidation', () => {
    for (const [kind, permission] of DISPATCHED) {
      expect(ORGANIZER_REPORTS[kind].permission, kind).toBe(permission)
    }
  })

  it('7 · F · every kind still dispatches to its own builder, by identity', () => {
    expect(ORGANIZER_REPORTS['transactions'].build).toBe(builders.buildTransactions)
    expect(ORGANIZER_REPORTS['settlements'].build).toBe(builders.buildSettlements)
    expect(ORGANIZER_REPORTS['wallet-ledger'].build).toBe(builders.buildWalletLedger)
    expect(ORGANIZER_REPORTS['donations'].build).toBe(builders.buildDonations)
    expect(ORGANIZER_REPORTS['refunds'].build).toBe(builders.buildRefunds)
    expect(ORGANIZER_REPORTS['broadcast-usage'].build).toBe(builders.buildBroadcastUsage)
    expect(ORGANIZER_REPORTS['gst'].build).toBe(builders.buildGst)
  })

  it('8 · label and permission have ONE definition — the map is derived from the catalogue', () => {
    for (const [kind] of DISPATCHED) {
      expect(ORGANIZER_REPORTS[kind].label).toBe(REPORT_CATALOG[kind].label)
      expect(ORGANIZER_REPORTS[kind].permission).toBe(REPORT_CATALOG[kind].permission)
    }
    // Structural proof rather than coincidence: the registry reads the catalogue.
    expect(src('lib/reports/registry.ts')).toContain('REPORT_CATALOG[kind]')
  })

  it('9 · J · an unknown kind fails closed in the map and in the route', () => {
    expect(ORGANIZER_REPORTS['not-a-report']).toBeUndefined()
    const route = src('app/api/organizer/reports/[kind]/route.ts')
    expect(route).toContain('if (!meta) return')
  })
})

// ─── C, §18 · payout-statement ────────────────────────────────────────────────

describe('RD-ANALYTICS-12-08 · payout-statement is registered without being rewritten', () => {
  it('10 · C · it appears exactly once — described, not dispatched', () => {
    expect(REPORT_CATALOG['payout-statement']).toBeDefined()
    expect(REPORT_DEFINITIONS.filter(d => d.kind === 'payout-statement')).toHaveLength(1)
    // Deliberately absent from the table dispatch map: it returns a PayoutStatement, not a
    // ReportTable, so `meta.build` would hand every consumer the wrong shape.
    expect(ORGANIZER_REPORTS['payout-statement']).toBeUndefined()
    expect(ORGANIZER_REPORT_KINDS).not.toContain('payout-statement')
  })

  it('11 · its permission is unchanged, and matches the route that enforces it', () => {
    expect(REPORT_CATALOG['payout-statement'].permission).toBe('settlements')
    const route = src('app/api/organizer/reports/payout-statement/route.ts')
    expect(route).toContain("authorizeWorkspace(req, 'settlements')")
  })

  it('12 · its builder is untouched and not duplicated', () => {
    // One implementation, in the shared builders module, still returning a PayoutStatement.
    expect(typeof builders.buildPayoutStatement).toBe('function')
    const route = src('app/api/organizer/reports/payout-statement/route.ts')
    expect(route).toContain('buildPayoutStatement(authz.workspaceUid, filters)')
    // No second copy anywhere.
    expect(src('lib/reports/catalog.ts')).not.toMatch(/buildPayoutStatement|grossRevenuePaise/)
    expect(src('lib/reports/registry.ts')).not.toMatch(/buildPayoutStatement/)
  })

  it('13 · its route still answers on its own path, unchanged', () => {
    const route = src('app/api/organizer/reports/payout-statement/route.ts')
    expect(route).toContain('payoutStatementPdf(stmt)')
    expect(route).toContain("Only PDF export is supported.")
  })
})

// ─── G · formats reflect reality ──────────────────────────────────────────────

describe('RD-ANALYTICS-12-08 · format metadata matches what the exporters actually do', () => {
  it('14 · table reports offer csv, xlsx and pdf', () => {
    for (const [kind] of DISPATCHED) {
      expect(REPORT_CATALOG[kind].formats.sort()).toEqual(['csv', 'pdf', 'xlsx'])
    }
  })

  it('15 · payout-statement offers PDF alone, because its route rejects the rest', () => {
    expect(REPORT_CATALOG['payout-statement'].formats).toEqual(['pdf'])
    const route = src('app/api/organizer/reports/payout-statement/route.ts')
    expect(route).toContain("format !== 'pdf'")
  })

  it('16 · json is NOT listed as a format — it is preview, not a download', () => {
    for (const def of REPORT_DEFINITIONS) {
      expect(def.formats as string[], def.kind).not.toContain('json')
    }
    // …and every route still answers it, which is why it is documented rather than dropped.
    expect(src('app/api/organizer/reports/[kind]/route.ts')).toContain("formatParam === 'json'")
  })
})

// ─── H · the UI no longer keeps its own list ──────────────────────────────────

describe('RD-ANALYTICS-12-08 · the finance page reads the registry', () => {
  const UI = src('app/(dashboard)/dashboard/finance/reports/page.tsx')

  it('17 · H · the hardcoded report array is gone', () => {
    expect(UI).toContain('REPORT_DEFINITIONS')
    // The old shape: a literal list of kinds with their labels restated.
    expect(UI).not.toMatch(/kind:\s*'transactions',\s*label:/)
    expect(UI).not.toMatch(/kind:\s*'payout-statement'\s*,?\s*label:/)
    expect(UI).not.toMatch(/statement\?:\s*boolean/)
  })

  it('18 · it imports the PURE catalogue, never the builder-bearing registry', () => {
    // page.tsx is a client component; '@/lib/reports/registry' value-imports the builders,
    // which import firebase-admin. Importing it here would bundle server code for the browser.
    expect(UI).toContain("from '@/lib/reports/catalog'")
    expect(UI).not.toContain("from '@/lib/reports/registry'")
  })

  it('19 · the catalogue really is pure', () => {
    const cat = src('lib/reports/catalog.ts')
    expect(cat).not.toMatch(/firebase|adminDb|from '@\/lib\/reports\/builders'/)
  })

  it('20 · order is preserved — declaration order is display order', () => {
    expect(REPORT_DEFINITIONS.map(d => d.kind)).toEqual([
      'transactions', 'settlements', 'wallet-ledger', 'donations',
      'refunds', 'broadcast-usage', 'gst', 'payout-statement',
    ])
  })

  it('21 · the statement branch is driven by metadata, not a local flag', () => {
    expect(UI).toContain("def.output === 'statement'")
    expect(UI).not.toMatch(/def\.statement/)
  })
})

// ─── UI filtering is not authorization ────────────────────────────────────────

describe('RD-ANALYTICS-12-08 · the server still authorizes', () => {
  it('22 · the sync route resolves its permission from the registry, before building', () => {
    const route = src('app/api/organizer/reports/[kind]/route.ts')
    const authIdx  = route.indexOf('authorizeWorkspace(req, meta.permission)')
    const buildIdx = route.indexOf('meta.build(')
    expect(authIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeGreaterThan(authIdx)     // authorization precedes the read
  })

  it('23 · the export-job path still resolves permission from the registry', () => {
    expect(src('lib/reports/exportJob.ts')).toContain('ORGANIZER_REPORTS[job.kind]?.permission')
  })

  it('24 · no second permission map was introduced', () => {
    // The catalogue is the only other place a permission appears, and the registry derives
    // from it rather than restating it.
    expect(src('lib/reports/registry.ts')).not.toMatch(/permission:\s*'(transactions|settlements|wallet)'/)
  })
})
