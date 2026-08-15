// RD-CERT-ARTIFACT-01 — the write path: the canonical PDF is persisted to object storage
// BEFORE the Firestore record exists, and the two can never disagree.
//
// THE INVARIANT UNDER TEST: a certificate record exists ⟹ its artifact exists.
//
// That is why ORDER is asserted directly rather than inferred from end state. A test that
// only checked "upload happened and record happened" would pass just as happily if the
// record were written first — and that ordering is precisely the bug, because a record
// pointing at bytes that are not there is unrepairable: findCertificate would return it and
// generation would never run again.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Ordered log of the side effects whose SEQUENCE is the safety property. */
const events: string[] = []
const uploaded: Array<{ key: string; bytes: number }> = []
const deleted:  string[] = []
const created:  Record<string, unknown>[] = []

let uploadShouldFail = false
let createShouldFail = false

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (input: { id: string; eventSlug: string; body: Uint8Array }) => {
        if (uploadShouldFail) { events.push('upload:FAIL'); throw new Error('R2 unavailable') }
        const key = `events/${input.eventSlug}/certificates/${input.id}`
        events.push('upload')
        uploaded.push({ key, bytes: input.body.byteLength })
        return { metadata: { path: key, size: input.body.byteLength } }
      },
      delete: async (key: string) => { events.push('delete'); deleted.push(key) },
      download: async () => ({ body: new Uint8Array([1]), mimeType: 'application/pdf', size: 1 }),
      generateSignedUrl: async () => 'https://r2.test/signed',
    },
  }
})

vi.mock('@/lib/certificates/render', () => ({
  renderCertificatePdf: async () => { events.push('render'); return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) },
}))

vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => new Uint8Array([1, 2, 3]),
  validateEventTemplateUrl:  () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }),
  validateGeneratedCertificateUrl: () => ({ ok: true }),
}))

const released: string[] = []
vi.mock('@/lib/certificates/firestore', () => ({
  assertRegistrationEligibleForCertificate: async () => {},
  findCertificate:      async () => null,
  reserveCertificateId: async () => ({ certificateId: 'RDC-2026-AB12CD', owned: true }),
  createCertificate:    async (input: Record<string, unknown>) => {
    if (createShouldFail) { events.push('create:FAIL'); throw new Error('firestore unavailable') }
    events.push('create')
    created.push(input)
    return { ...input, status: 'generated' }
  },
  getCertificate:       async () => null,
  getActiveTemplate:    async () => null,
  getTemplateById:      async () => null,
  recordCertificateRegeneration: async () => {},
  releaseCertificateClaim: async (_e: string, r: string) => { events.push('release'); released.push(r) },
  setCertificateArtifact: async () => {},
  getSettings:          async () => null,
  recordTemplateUsage:  async () => {},
}))

vi.mock('@/lib/certificates/billing',  () => ({ chargeCertificate: async () => { events.push('charge'); return { charged: false } } }))
vi.mock('@/lib/certificates/email',    () => ({ emailCertificate: async () => ({ success: true, skipped: true }) }))
vi.mock('@/lib/certificates/whatsapp', () => ({ sendCertificateWhatsApp: async () => {} }))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service',           () => ({ crmRecordCertificate: async () => {} }))
vi.mock('@/lib/email/appUrl',          () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/monitoring/sentry',     () => ({ captureError: () => {}, captureFinancialError: () => {} }))

import { generateCertificate } from '@/lib/certificates/generate'
import { certificateObjectKey } from '@/lib/certificates/artifact'

const TEMPLATE = {
  templateId: 'TPL-1', organizerUid: 'org-1', eventId: 'draft-1',
  templateType: 'png', dimensions: { width: 1492, height: 1054, unit: 'px' },
  fileUrl: 'https://storage.test/templates/TPL-1.png', layout: { elements: [] }, isActive: true,
} as never

const INPUT = {
  eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026', organizerUid: 'org-1',
  eventName: 'Noyyal Marathon 2026', eventDate: '15 June 2026', eventLocation: 'Coimbatore',
  organizerName: 'RegisterDesk', registrationId: 'reg-1',
  attendeeName: 'Bala Ganapathy', attendeeEmail: 'a@example.com',
  ticketCode: 'TKT-1', passName: '10K',
  bibNumber: '1234', distance: '10K', finishTime: '00:52:10', position: '7', category: 'M',
} as never

const run = () => generateCertificate({
  input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE,
} as never)

beforeEach(() => {
  events.length = 0; uploaded.length = 0; deleted.length = 0
  created.length = 0; released.length = 0
  uploadShouldFail = false; createShouldFail = false
})

describe('A · the artifact exists before the record', () => {
  it('uploads BEFORE createCertificate — asserted on ORDER, not just occurrence', async () => {
    await run()
    const upload = events.indexOf('upload')
    const create = events.indexOf('create')
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThanOrEqual(0)
    expect(upload).toBeLessThan(create)
  })

  it('renders, then uploads, then records, then bills', async () => {
    await run()
    expect(events.filter(e => ['render', 'upload', 'create', 'charge'].includes(e)))
      .toEqual(['render', 'upload', 'create', 'charge'])
  })

  it('persists fileKey + fileSize on the record, and leaves legacy fileUrl null', async () => {
    await run()
    expect(created).toHaveLength(1)
    expect(created[0].fileKey).toBe('events/noyyal-marathon-2026/certificates/RDC-2026-AB12CD.pdf')
    expect(created[0].fileSize).toBe(5)
    expect(created[0].fileUrl).toBeNull()
  })

  it('uses the DETERMINISTIC key helper — the record and the object cannot drift', async () => {
    await run()
    expect(uploaded[0].key).toBe(certificateObjectKey('noyyal-marathon-2026', 'RDC-2026-AB12CD'))
    expect(created[0].fileKey).toBe(uploaded[0].key)
  })

  it('still persists the placeholder snapshot re-rendering depends on', async () => {
    await run()
    const data = created[0].data as Record<string, string>
    expect(data.participantName).toBe('Bala Ganapathy')
    expect(data.eventDate).toBe('15 June 2026')
    expect(data.finishTime).toBe('00:52:10')
    expect(data.issueDate).toBeTruthy()   // never re-derived to "today" on a later render
  })
})

describe('B · upload failure creates NO record and releases the claim', () => {
  beforeEach(() => { uploadShouldFail = true })

  it('throws, writes no certificate, and releases the claim so a retry can recover', async () => {
    await expect(run()).rejects.toThrow(/R2 unavailable/)
    expect(created).toEqual([])          // ← the invariant: no record without an artifact
    expect(released).toEqual(['reg-1'])
  })

  it('never bills for a certificate that was not issued', async () => {
    await expect(run()).rejects.toThrow()
    expect(events).not.toContain('charge')
  })

  it('a retry after a transient upload failure succeeds and reuses the SAME key', async () => {
    await expect(run()).rejects.toThrow()
    uploadShouldFail = false
    await run()
    expect(created).toHaveLength(1)
    expect(created[0].fileKey).toBe(certificateObjectKey('noyyal-marathon-2026', 'RDC-2026-AB12CD'))
  })
})

describe('C · Firestore failure after upload cleans up the object', () => {
  beforeEach(() => { createShouldFail = true })

  it('deletes the deterministic object it just wrote, then releases the claim', async () => {
    await expect(run()).rejects.toThrow(/firestore unavailable/)
    expect(deleted).toEqual([certificateObjectKey('noyyal-marathon-2026', 'RDC-2026-AB12CD')])
    expect(released).toEqual(['reg-1'])
  })

  it('cleans up BEFORE releasing the claim, so a retry never races its own leftover', async () => {
    await expect(run()).rejects.toThrow()
    expect(events.indexOf('delete')).toBeLessThan(events.indexOf('release'))
  })

  it('leaves no certificate record behind', async () => {
    await expect(run()).rejects.toThrow()
    expect(created).toEqual([])
  })
})

describe('D · the key is deterministic', () => {
  it('is a pure function of (eventSlug, certificateId)', () => {
    expect(certificateObjectKey('noyyal-marathon-2026', 'RDC-2026-AB12CD'))
      .toBe('events/noyyal-marathon-2026/certificates/RDC-2026-AB12CD.pdf')
    // Same inputs → same key, every time. This is what makes a retried upload overwrite
    // its own leftover instead of accumulating orphans.
    expect(certificateObjectKey('e', 'RDC-2026-AAAAAA'))
      .toBe(certificateObjectKey('e', 'RDC-2026-AAAAAA'))
  })

  it('separates events and certificates', () => {
    expect(certificateObjectKey('a', 'RDC-2026-AAAAAA'))
      .not.toBe(certificateObjectKey('b', 'RDC-2026-AAAAAA'))
    expect(certificateObjectKey('a', 'RDC-2026-AAAAAA'))
      .not.toBe(certificateObjectKey('a', 'RDC-2026-BBBBBB'))
  })
})
