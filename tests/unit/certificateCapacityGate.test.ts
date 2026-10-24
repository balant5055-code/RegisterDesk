// RD-CERT-CAPACITY-UX-01 — only CREATING a new certificate needs certificate capacity. The Issue &
// Bulk panel is gated from the server's capacity state; nothing that serves EXISTING certificates
// (Recipients, email, download, regenerate, attendee download/lookup, public verification) is.
// Real-ledger behaviour: tests/emulator/certificateCapacityStatus.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { certificateIssueGate } from '@/lib/certificates/capacityGate'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const status = (state: 'available' | 'none' | 'exhausted', purchased = 10, available = 4) =>
  ({ state, purchased, used: purchased - available, available, manageHref: '/dashboard/events/new/visibility?draftId=d1&step=license&service=certificates' })

describe('RD-CERT-CAPACITY-UX-01 · certificateIssueGate', () => {
  it('loading: no message, not blocked', () => {
    expect(certificateIssueGate(undefined)).toEqual({ blocked: false, tone: 'none', message: null, href: null })
  })
  it('unknown (read failed): warns, never claims availability, does not block on a guess', () => {
    const g = certificateIssueGate(null)
    expect(g).toMatchObject({ blocked: false, tone: 'warning', href: null })
    expect(g.message).toContain('couldn’t be checked')
  })
  it('no entitlement: blocked, purchase link, existing certificates reassured', () => {
    const g = certificateIssueGate(status('none', 0, 0))
    expect(g).toMatchObject({ blocked: true, tone: 'warning', href: status('none').manageHref })
    expect(g.message).toContain('no certificate capacity')
    expect(g.message).toContain('already issued stay available')
  })
  it('exhausted: blocked with the count used', () => {
    const g = certificateIssueGate(status('exhausted', 25, 0))
    expect(g.blocked).toBe(true)
    expect(g.message).toContain('All 25 certificates')
  })
  it('available (purchased or carried-in): not blocked, shows the remainder', () => {
    const g = certificateIssueGate(status('available', 10, 4))
    expect(g).toMatchObject({ blocked: false, tone: 'info' })
    expect(g.message).toContain('4 of 10')
  })
})

describe('RD-CERT-CAPACITY-UX-01 · server contract and scope', () => {
  it('stats decides with the SAME rule generateCertificate uses', () => {
    // RD-CERT-JOB-CAPACITY-01 — the rule moved to one helper shared by stats and the job pre-check.
    const helper = read('lib/certificates/capacity.ts')
    expect(helper).toContain("decideReserve(ledger, false, 'certificates', 1).mode")
    expect(helper).toContain("mode === 'allowance' ? 'available'")
    const s = read('app/api/organizer/events/[eventId]/certificates/stats/route.ts')
    expect(s).toContain('await readCertificateCapacity(eventId).catch(() => null)')   // unreadable ⇒ null (unknown)
    expect(read('lib/certificates/generate.ts')).toContain('throw new CertificateAllowanceExhaustedError()')
  })
  it('the issue route keeps 402 and adds a machine-readable code', () => {
    expect(read('app/api/organizer/events/[eventId]/certificates/issue/route.ts'))
      .toContain("{ error: err.message, code: 'CERTIFICATE_CAPACITY_REQUIRED' }, { status: 402 }")
  })
  it('only the Issue & Bulk panel is gated — every generate control', () => {
    const p = read('components/certificates/hub/IssueBulkPanel.tsx')
    expect(p).toContain('const gate = certificateIssueGate(capacity)')
    expect(p.match(/disabled=\{busy \|\| gate\.blocked/g)?.length).toBe(5)
  })
  it.each([
    'components/certificates/hub/RecipientsPanel.tsx',
    'components/certificates/hub/OverviewPanel.tsx',
    'components/certificates/hub/TemplatesPanel.tsx',
    'components/certificates/hub/SettingsPanel.tsx',
    'app/api/certificates/download/[registrationId]/route.ts',
    'app/api/events/[slug]/certificates/lookup/route.ts',
    'app/api/verify/certificate/[certificateId]/route.ts',
  ])('%s is not capacity-gated (existing certificates and attendee access stay available)', p => {
    const s = read(p)
    expect(s).not.toContain('certificateIssueGate')
    expect(s).not.toContain('certificateCapacity')
    expect(s).not.toMatch(/reserveServiceUnits|decideReserve/)
  })
})
