// RD-PRINT-P0 — source contracts for Print & Assets security and "no stored output".
// Behaviour with real Auth/Firestore/Storage: tests/emulator/printPhase0Security.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(f, 'utf8')
/** Strips comments so an assertion cannot be satisfied (or tripped) by a comment. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p.replace(/\\/g, '/')] : []
})

const PRINT_ROUTES = [
  ...walk('app/api/organizer/print-jobs'),
  ...walk('app/api/organizer/print-packages'),
  ...walk('app/api/organizer/print-ops'),
  ...walk('app/api/organizer/print-templates'),
  ...walk('app/api/organizer/print-runs'),            // RD-PRINT-P3
]

describe('every organizer print route requires `certificates`', () => {
  it('found the routes', () => { expect(PRINT_ROUTES.length).toBeGreaterThanOrEqual(20) })
  for (const f of PRINT_ROUTES) {
    it(f, () => {
      const src = code(read(f))
      expect(src).toContain("authorizeWorkspace(req, 'certificates')")
      expect(src).not.toContain('authorizeAnyWorkspace')
      expect(src).not.toContain('resolveWorkspaceUid(')
    })
  }
})

describe('no login credential in a query string', () => {
  for (const f of PRINT_ROUTES) {
    it(f, () => {
      expect(code(read(f))).not.toMatch(/searchParams\.get\(\s*['"]token['"]\s*\)/)
    })
  }
  it('the clients never put the session token in a print URL', () => {
    for (const f of [
      'app/(dashboard)/dashboard/print-assets/operations/PrintOpsClient.tsx',
      'app/(dashboard)/dashboard/check-in/operations/Participant360Drawer.tsx',
    ]) {
      const src = code(read(f))
      expect(src, f).not.toContain('download?token=')
      expect(src, f).not.toMatch(/window\.open\(`\/api\/organizer\/print/)
    }
  })
})

describe('no print output is stored', () => {
  const LIB = walk('lib/printAssets').filter(f => !f.endsWith('legacyInventory.ts'))
  it('no print module uploads, signs or saves a file', () => {
    for (const f of LIB) {
      const src = code(read(f))
      expect(src, f).not.toContain('uploadServerFile')
      expect(src, f).not.toContain('firebaseStorageDownloadTokens')
      expect(src, f).not.toContain('getSignedUrl')
      expect(src, f).not.toMatch(/\.file\([^)]*\)\.save\(/)
    }
  })
  it('the download routes render on demand and never redirect to a stored URL', () => {
    for (const f of [
      'app/api/organizer/print-jobs/[jobId]/items/[registrationId]/download/route.ts',
      'app/api/organizer/print-packages/[jobId]/download/route.ts',
    ]) {
      const src = code(read(f))
      expect(src, f).not.toContain('redirect(')
      expect(src, f).not.toContain('output.url')
      expect(src, f).toContain("'Cache-Control':          'no-store, private'")
    }
    expect(code(read('app/api/organizer/print-jobs/[jobId]/items/[registrationId]/download/route.ts'))).toContain('renderPrintCard(job, registrationId)')
    expect(code(read('app/api/organizer/print-packages/[jobId]/download/route.ts'))).toContain('buildPrintPackageZip(job)')
  })
  it('a generation item stores selection metadata only — no attendee copy', () => {
    const src = code(read('lib/printAssets/generationJob.ts'))
    const seed = src.slice(src.indexOf('function buildPrintItemSeed('), src.indexOf('export function printCardFieldsFor('))
    expect(seed).toContain('registrationId,')
    for (const forbidden of ['attendee', 'ticketCode', 'qrValue', 'email', 'phone', 'formResponses', 'bibNumber']) {
      expect(seed, forbidden).not.toContain(forbidden)
    }
    // The only item writes after seeding are metadata.
    expect(src).toContain("ref.update({ rendered: true, renderedAt: FieldValue.serverTimestamp(), error: null })")
    expect(src).toContain("ref.update({ rendered: false, error: message })")   // message = safeCardError(...) (RD-PRINT-AUDIT)
    expect(src).toContain('batch.update(col.doc(ids[j]), { rendered: false, error: null })')
  })
  it('a package job writes stats only — no output', () => {
    const src = code(read('lib/printAssets/packageJob.ts'))
    expect(src).toContain('.update({ stats, failures: failures.slice(0, 200) })')
    expect(src).not.toMatch(/update\(\{[^}]*output/)
  })
  it('views never return a stored path or URL', () => {
    const g = code(read('lib/printAssets/generationJob.ts'))
    const view = g.slice(g.indexOf('export function toPrintItemView('))
    expect(view).not.toMatch(/output\??\.(url|path)/)
    const p = code(read('lib/printAssets/packageJob.ts'))
    const pview = p.slice(p.indexOf('export function toPackageJobView('))
    expect(pview).not.toMatch(/output\??\.(url|path)/)
  })
})

describe('the legacy inventory is read-only', () => {
  const src = code(read('lib/printAssets/legacyInventory.ts'))
  it('only lists and counts', () => {
    for (const write of ['.set(', '.update(', '.delete(', 'deleteFiles', '.batch(', 'runTransaction', '.save(', '.download(', 'recursiveDelete', 'getSignedUrl']) {
      expect(src, write).not.toContain(write)
    }
    expect(src).toContain('getFiles({ prefix, maxResults: LIST_PAGE, autoPaginate: false, pageToken })')
  })
  it('reports presence of a download token, never its value', () => {
    expect(src).toContain('inv.withDownloadToken++')
    expect(src).not.toMatch(/withDownloadToken\s*[:=].*firebaseStorageDownloadTokens/)
  })
})

describe('navigation matches the API permission', () => {
  it('the Print & Assets row and setup item require `certificates`', () => {
    expect(read('config/workspaceNav.ts')).toMatch(/key: 'print-assets',[^\n]*permission: 'certificates'/)
    expect(read('lib/eventSetup/readiness.ts')).toContain("print_assets:   { permission: 'certificates' }")
  })
})
