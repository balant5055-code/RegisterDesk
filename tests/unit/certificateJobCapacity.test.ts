// RD-CERT-JOB-CAPACITY-01 + RD-BCAST-COST-01 — pure decisions and source contracts.
// Real Firestore: tests/emulator/certificateJobCapacity.emu.test.ts and
// tests/emulator/broadcastEstimateStates.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
const { certificateJobCapacityDecision } = await import('@/lib/certificates/capacity')

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const cap = (available: number, state: 'available' | 'none' | 'exhausted' = available > 0 ? 'available' : 'exhausted') =>
  ({ state, purchased: 10, used: 10 - available, available, manageHref: '/dashboard/events/new/visibility?draftId=d&step=license&service=certificates' })

describe('RD-CERT-JOB-CAPACITY-01 · certificateJobCapacityDecision', () => {
  it('unboundable (null) or nothing new needed ⇒ accepted, whatever the capacity', () => {
    expect(certificateJobCapacityDecision(cap(0, 'none'), null)).toEqual({ ok: true })
    expect(certificateJobCapacityDecision(cap(0, 'none'), 0)).toEqual({ ok: true })
  })
  it('enough ⇒ accepted (exactly enough included)', () => {
    expect(certificateJobCapacityDecision(cap(5), 5)).toEqual({ ok: true })
  })
  it('zero capacity ⇒ refused with the issue route\'s code and message', () => {
    const d = certificateJobCapacityDecision(cap(0, 'none'), 3)
    expect(d).toMatchObject({ ok: false, body: { code: 'CERTIFICATE_CAPACITY_REQUIRED', capacity: { required: 3, available: 0, shortfall: 3 } } })
    if (!d.ok) expect(d.body.error).toBe('Certificate capacity is required. Purchase certificate capacity in License & Services.')
  })
  it('insufficient ⇒ refused with the shortfall', () => {
    const d = certificateJobCapacityDecision(cap(2), 5)
    expect(d).toMatchObject({ ok: false, body: { capacity: { required: 5, available: 2, shortfall: 3 } } })
  })
})

describe('RD-CERT-JOB-CAPACITY-01 · route contract', () => {
  const route = read('app/api/organizer/events/[eventId]/certificates/jobs/route.ts')
  it('checks BEFORE creating the job, refuses with 402, and treats an unreadable ledger as "accept" (reservation decides)', () => {
    const check = route.indexOf('certificateJobCapacityDecision(capacity, needAtLeast)')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(route.indexOf('const job = await createJob('))
    expect(route).toContain('if (!decision.ok) return NextResponse.json(decision.body, { status: 402 })')
    expect(route).toContain('await readCertificateCapacity(eventId).catch(() => null)')
    expect(route).toContain('programFilter: assignmentFilter !== null')
  })
  it('the per-certificate reservation is still the authority', () => {
    expect(read('lib/certificates/generate.ts')).toMatch(/reserveServiceUnits\(\{ draftId: allowanceDraftId, service: 'certificates'/)
  })
  it('existing-certificate operations are not pre-checked', () => {
    for (const p of [
      'app/api/organizer/events/[eventId]/certificates/email-jobs/route.ts',
      'app/api/organizer/events/[eventId]/certificates/download/route.ts',
      'app/api/organizer/events/[eventId]/certificates/regenerate/route.ts',
      'app/api/certificates/download/[registrationId]/route.ts',
      'app/api/verify/certificate/[certificateId]/route.ts',
    ]) expect(read(p), p).not.toContain('certificateJobCapacityDecision')
  })
})

describe('RD-BCAST-COST-01 · estimatedCostPaise cannot claim a wallet charge that billing will not make', () => {
  const route = read('app/api/organizer/broadcasts/route.ts')
  it('the estimate follows the SAME funding quote that gates the send', () => {
    expect(route).toContain('waFundedBy = capacity.fundedBy')
    expect(route).toContain("const estimatedCostPaise = chosenChannel === 'whatsapp' && waFundedBy === 'legacy_balance'")
  })
  it('a prepaid-capacity start writes no money (the estimate\'s 0 matches billing)', () => {
    expect(read('lib/communications/billing.ts')).toContain("status: 'sending', actualCostPaise: 0, fundedBy: 'prepaid_allowance'")
  })
  it('no finance, report or analytics code reads estimatedCostPaise from broadcast campaigns', () => {
    for (const p of ['lib/reports/builders.ts', 'lib/analytics/adminCommunications.ts', 'lib/communications/usage.ts', 'lib/broadcasts/finalize.ts']) {
      expect(read(p), p).not.toContain('estimatedCostPaise')
    }
  })
})

describe('RD-CERT-JOB-CAPACITY-01 · a job that ran out of capacity is actionable', () => {
  it('the job card offers the purchase path next to the capacity error', () => {
    const p = read('components/certificates/hub/IssueBulkPanel.tsx')
    expect(p).toContain('{j.error === CERTIFICATE_CAPACITY_REQUIRED && gate.href && (')
  })
  it('generation never emails, so re-running a partially completed job cannot re-send', () => {
    const jobs = read('lib/certificates/jobs.ts')
    expect(jobs).toContain('GENERATION NO LONGER SENDS EMAIL')
    expect(jobs).not.toMatch(/emailCertificate\(/)
  })
})
