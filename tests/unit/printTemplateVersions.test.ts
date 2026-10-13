// RD-PRINT-P1 — immutable template versions: pure behaviour + source contracts.
// Behaviour on real Firestore: tests/emulator/printTemplateVersioning.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'

// The pure helpers under test need no database; the module imports the admin SDK only
// for its transaction functions, which the emulator suite exercises.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { layoutHash, cardSpecOf, versionDocId } from '@/lib/printAssets/versions'
import { emptyDesign, defaultCanvas } from '@/lib/printAssets/types'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n)
  if (n === 'node_modules' || n.startsWith('.next')) return []
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p.replace(/\\/g, '/')] : []
})

describe('layout hash', () => {
  const card = cardSpecOf(defaultCanvas())
  it('is independent of object key order', () => {
    const d = emptyDesign()
    const reordered = { elements: d.elements, canvas: { ...d.canvas }, version: d.version }
    expect(layoutHash(card, reordered as never)).toBe(layoutHash(card, d))
  })
  it('changes when the card changes (custom sizes are part of the version)', () => {
    const d = emptyDesign()
    for (const change of [{ width: 55 }, { height: 90 }, { unit: 'in' as const }, { orientation: 'landscape' as const }]) {
      expect(layoutHash({ ...card, ...change }, d)).not.toBe(layoutHash(card, d))
    }
  })
  it('changes when the design changes', () => {
    const d = emptyDesign()
    expect(layoutHash(card, { ...d, canvas: { ...d.canvas, background: '#000000' } })).not.toBe(layoutHash(card, d))
  })
  it('the card spec is exactly the canvas fields', () => {
    expect(Object.keys(cardSpecOf(defaultCanvas())).sort()).toEqual(['height', 'orientation', 'preset', 'unit', 'width'])
    expect(versionDocId('abc', 3)).toBe('abc_v3')
  })
})

describe('versions are immutable', () => {
  const V = code(read('lib/printAssets/versions.ts'))
  it('versions.ts writes a version ONLY with create() — never set/update', () => {
    expect(V.match(/tx\.create\(versions\.doc\(/g)?.length).toBe(2)          // legacy snapshot + new version
    expect(V).not.toMatch(/versions\.doc\([^)]*\)\)?\s*,?\s*\{[^}]*\}\s*,\s*\{\s*merge/)
    expect(V).not.toMatch(/tx\.(set|update)\(versions\./)
  })
  it('no other module in the app writes to printTemplateVersions', () => {
    const writers = walk('app').concat(walk('lib'), walk('features'))
      .filter(f => !f.endsWith('lib/printAssets/versions.ts'))
      .filter(f => /printTemplateVersions|PRINT_TEMPLATE_VERSIONS/.test(code(read(f))))
    // Only the event-deletion manifest may name it (to delete versions with their event).
    expect(writers).toEqual(['lib/events/eventDeletion.ts'])
  })
  it('event deletion removes versions with their event', () => {
    expect(read('lib/events/eventDeletion.ts')).toContain("byEventId('printTemplateVersions')")
  })
})

describe('every layout change commits a version; jobs pin one', () => {
  const F = code(read('lib/printAssets/firestore.ts'))
  it('design saves, re-sizes and duplicates go through commitTemplateVersion', () => {
    expect(F).toContain("commitTemplateVersion({ templateId: id, actorUid: opts.actorUid, source: opts.source ?? 'save'")
    expect(F).toContain("if (canvas) await commitTemplateVersion({ templateId: id, actorUid, source: 'resize', canvas })")
    expect(F).toContain("source: 'duplicate'")
    expect(F).toContain('copiedFrom: { templateId: source.id, version: pinned.version }')
    expect(F).not.toMatch(/update\(\{\s*design/)                              // no un-versioned design write
  })
  it('the create-job route pins the current version before creating the job', () => {
    const R = code(read('app/api/organizer/print-jobs/route.ts'))
    const pin = R.indexOf('ensureCurrentVersion(template.id, authz.workspaceUid, authz.callerUid)')
    expect(pin).toBeGreaterThan(-1)
    expect(pin).toBeLessThan(R.indexOf('createPrintGenerationJob({'))
    expect(R).toContain('templateVersion: pin.version, templateVersionHash: pin.hash')
  })
  it('a pinned job renders its version, never the live template', () => {
    const G = code(read('lib/printAssets/generationJob.ts'))
    const ctx = G.slice(G.indexOf('async loadContext(job)'))
    expect(ctx.indexOf('if (job.templateVersion) {')).toBeGreaterThan(-1)
    expect(ctx.indexOf('getTemplateVersion(job.templateId, job.templateVersion)')).toBeLessThan(ctx.indexOf('getPrintTemplate(job.templateId)'))
    expect(ctx).toContain('version.organizerUid !== job.organizerUid')
  })
  it('versions carry layout only — the version type has no output or attendee fields', () => {
    const T = read('lib/printAssets/types.ts')
    const type = T.slice(T.indexOf('export interface PrintTemplateVersion'), T.indexOf('// ─── Write-side input shapes'))
    for (const forbidden of ['url', 'path', 'bytes', 'attendee', 'email', 'phone', 'ticket', 'qr']) {
      expect(type.toLowerCase(), forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\w*\\s*[?:]`))
    }
  })
})

describe('archived templates cannot start a new print job (RD-PRINT-P1)', () => {
  it('one rule: archived is refused; draft and published are printable', async () => {
    const { isPrintableTemplateStatus, printTemplatePickerLabel } = await import('@/lib/printAssets/types')
    expect(isPrintableTemplateStatus('archived')).toBe(false)
    expect(isPrintableTemplateStatus('draft')).toBe(true)
    expect(isPrintableTemplateStatus('published')).toBe(true)
    expect(printTemplatePickerLabel({ name: 'Badge', status: 'draft' })).toBe('Badge (Draft)')
    expect(printTemplatePickerLabel({ name: 'Badge', status: 'published' })).toBe('Badge')
  })
  it('the create-job route refuses an archived template BEFORE pinning a version or creating a job', () => {
    const R = code(read('app/api/organizer/print-jobs/route.ts'))
    const gate = R.indexOf('if (!isPrintableTemplateStatus(template.status)) {')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(R.indexOf('ensureCurrentVersion('))
    expect(gate).toBeLessThan(R.indexOf('createPrintGenerationJob({'))
    expect(R).toContain("code: 'TEMPLATE_ARCHIVED'")
  })
  it('jobs already pinned keep working — no other print route consults template status', () => {
    for (const f of walk('app/api/organizer/print-jobs').concat(walk('app/api/organizer/print-packages'), walk('app/api/cron')))
      if (!f.endsWith('print-jobs/route.ts')) expect(code(read(f)), f).not.toContain('isPrintableTemplateStatus')
  })
  it('both print pickers hide archived templates and label drafts', () => {
    for (const f of ['app/(dashboard)/dashboard/check-in/operations/BulkActionBar.tsx', 'app/(dashboard)/dashboard/check-in/operations/Participant360Drawer.tsx']) {
      const src = code(read(f))
      expect(src, f).toContain('isPrintableTemplateStatus(t.status)')
      expect(src, f).toContain('printTemplatePickerLabel(t)')
    }
  })
})
