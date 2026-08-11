// Issuing a certificate must NOT upload the generated PDF to Storage.
//
// WHY. Every generated certificate used to be uploaded and then re-read on every download.
// At event scale that is ~2.9 MB × 10,000 ≈ 29 GB written once and re-read forever, for an
// artifact the download endpoint can rebuild deterministically from the `data` snapshot.
// The snapshot is what makes the stored copy redundant — so this file pins BOTH halves:
// no upload happens, AND the snapshot that replaces it is still persisted.
//
// Template/background assets are a different thing entirely and MUST stay in Storage; the
// render still fetches them, and that fetch is mocked here rather than asserted against.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const uploads: string[] = []
const created: Record<string, unknown>[] = []

// THE assertion surface: any generated-PDF upload lands here.
vi.mock('@/lib/firebase/storage/admin', () => ({
  uploadServerFile: async (path: string) => { uploads.push(path); return { url: `https://storage.test/${path}` } },
}))

vi.mock('@/lib/certificates/render', () => ({
  renderCertificatePdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),   // "%PDF"
}))

// Template + asset loading still reads Storage — expected and out of scope.
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => new Uint8Array([1, 2, 3]),
  validateEventTemplateUrl:  () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }),
  validateGeneratedCertificateUrl: () => ({ ok: true }),
}))

vi.mock('@/lib/certificates/firestore', () => ({
  assertRegistrationEligibleForCertificate: async () => {},
  findCertificate:      async () => null,
  reserveCertificateId: async () => ({ certificateId: 'RDC-2026-AB12CD', owned: true }),
  createCertificate:    async (input: Record<string, unknown>) => { created.push(input); return { ...input, status: 'generated' } },
  getCertificate:       async () => null,
  getActiveTemplate:    async () => null,
  getTemplateById:      async () => null,
  recordCertificateRegeneration: async () => {},
  releaseCertificateClaim: async () => {},
  getSettings:          async () => null,
  recordTemplateUsage:  async () => {},
}))

// Side-effects that must remain untouched by this change — stubbed, not removed.
vi.mock('@/lib/certificates/billing',  () => ({ chargeCertificate: async () => ({ charged: false }) }))
vi.mock('@/lib/certificates/email',    () => ({ emailCertificate: async () => ({ success: true, skipped: true }) }))
vi.mock('@/lib/certificates/whatsapp', () => ({ sendCertificateWhatsApp: async () => {} }))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service',           () => ({ crmRecordCertificate: async () => {} }))
vi.mock('@/lib/email/appUrl',          () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/monitoring/sentry',     () => ({ captureError: () => {}, captureFinancialError: () => {} }))

import { generateCertificate } from '@/lib/certificates/generate'

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

beforeEach(() => { uploads.length = 0; created.length = 0 })

describe('certificate issuance no longer stores the generated PDF', () => {
  it('1 · performs NO Storage upload', async () => {
    await generateCertificate({ input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE } as never)
    expect(uploads).toEqual([])
  })

  it('2/3 · persists fileUrl = null and fileSize = null', async () => {
    await generateCertificate({ input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE } as never)
    expect(created).toHaveLength(1)
    expect(created[0].fileUrl).toBeNull()
    expect(created[0].fileSize).toBeNull()
  })

  it('4 · still persists the placeholder snapshot that on-demand rendering depends on', async () => {
    await generateCertificate({ input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE } as never)
    const data = created[0].data as Record<string, string>

    // Without these the certificate could never be re-rendered faithfully. issueDate in
    // particular: if it were not snapshotted, a later download would stamp today's date.
    expect(data.participantName).toBe('Bala Ganapathy')
    expect(data.eventName).toBe('Noyyal Marathon 2026')
    expect(data.eventDate).toBe('15 June 2026')
    expect(data.bibNumber).toBe('1234')
    expect(data.finishTime).toBe('00:52:10')
    expect(data.position).toBe('7')
    expect(data.issueDate).toBeTruthy()
  })

  it('still records identity, verification and attribution fields', async () => {
    await generateCertificate({ input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE, jobId: 'job-9' } as never)
    const c = created[0]
    for (const k of ['certificateId', 'verificationToken', 'eventId', 'eventSlug', 'organizerUid',
                     'issuedBy', 'registrationId', 'attendeeName', 'attendeeEmail', 'eventName',
                     'eventDate', 'certificateType', 'templateId', 'source', 'data']) {
      expect(c[k], `missing ${k}`).toBeDefined()
    }
    expect(c.jobId).toBe('job-9')
    expect(c.templateId).toBe('TPL-1')
  })

  it('still RENDERS at issuance — a broken template must fail before the record is written', async () => {
    // Rendering is retained deliberately: it proves the certificate is producible before a
    // record exists and the wallet is charged. Only the upload was removed.
    vi.resetModules()
    vi.doMock('@/lib/certificates/render', () => ({
      renderCertificatePdf: async () => { throw new Error('template unreadable') },
    }))
    const { generateCertificate: gen } = await import('@/lib/certificates/generate')
    await expect(
      gen({ input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE } as never),
    ).rejects.toThrow()
    vi.doUnmock('@/lib/certificates/render')
    vi.resetModules()
  })
})
