// Issuing a certificate MUST persist the generated PDF as a durable artifact.
//
// ═══ THIS FILE'S INTENT WAS DELIBERATELY INVERTED ════════════════════════════
// It used to assert the opposite — that no upload happened — because generated PDFs were
// dropped and every download re-rendered them from the `data` snapshot. That traded a
// one-time write for an unbounded recurring cost: ~155 ms of CPU per download on a path
// that barely parallelises, so 10,000 attendees downloading became a rendering queue. It
// also made a certificate reproducible only while its TEMPLATE still existed and still
// rendered.
//
// The snapshot is still persisted and still authoritative — regeneration and legacy
// records depend on it — so this file pins BOTH halves: the artifact is stored, AND the
// snapshot that can rebuild it is not lost.
//
// The legacy Firebase Storage path (`uploadServerFile` → `fileUrl`) must stay unused: new
// certificates are addressed by `fileKey` in platform storage, and a record that wrote both
// would be ambiguous about which artifact is canonical.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const legacyUploads: string[] = []
const platformUploads: Array<{ id: string; eventSlug: string; mimeType: string; visibility?: string }> = []
const created: Record<string, unknown>[] = []

// The LEGACY surface — must stay empty.
vi.mock('@/lib/firebase/storage/admin', () => ({
  uploadServerFile: async (path: string) => { legacyUploads.push(path); return { url: `https://storage.test/${path}` } },
}))

// The CURRENT surface — must receive exactly one PDF.
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (input: { id: string; eventSlug: string; body: Uint8Array; mimeType: string; visibility?: string }) => {
        platformUploads.push({ id: input.id, eventSlug: input.eventSlug, mimeType: input.mimeType, visibility: input.visibility })
        return { metadata: { path: `events/${input.eventSlug}/certificates/${input.id}`, size: input.body.byteLength } }
      },
      delete: async () => {},
      download: async () => ({ body: new Uint8Array([1]), mimeType: 'application/pdf', size: 1 }),
      generateSignedUrl: async () => 'https://r2.test/signed',
    },
  }
})

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
  setCertificateArtifact: async () => {},
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
  fileUrl: 'https://storage.test/templates/TPL-1.png', isActive: true,
  // RD-CERT-2E: issuance now requires a designed template, so this fixture carries one
  // element. Nothing in this suite asserts on the layout — it is about artifact persistence.
  layout: {
    version: 1, canvas: { width: 1492, height: 1054, unit: 'px' },
    elements: [{ id: 'e1', type: 'text', content: '{{participantName}}', zIndex: 1, x: 0.1, y: 0.4,
      width: 0.8, fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal', color: '#111111', align: 'center' }],
  },
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

beforeEach(() => { legacyUploads.length = 0; platformUploads.length = 0; created.length = 0 })

describe('certificate issuance PERSISTS the generated PDF', () => {
  it('1 · uploads exactly one PDF to platform storage', async () => {
    await run()
    expect(platformUploads).toHaveLength(1)
    expect(platformUploads[0].mimeType).toBe('application/pdf')
    expect(platformUploads[0].id).toBe('RDC-2026-AB12CD.pdf')
    expect(platformUploads[0].eventSlug).toBe('noyyal-marathon-2026')
  })

  it('2 · requests SIGNED_URL visibility — a certificate is never PUBLIC', async () => {
    await run()
    // Names a participant and their result; the storage layer refuses PUBLIC for this
    // asset type outright, and issuance must not even ask for it.
    expect(platformUploads[0].visibility).toBe('SIGNED_URL')
  })

  it('3 · does NOT use the legacy Firebase Storage path', async () => {
    await run()
    expect(legacyUploads).toEqual([])
  })

  it('4 · persists fileKey + fileSize, and leaves the legacy fileUrl null', async () => {
    await run()
    expect(created).toHaveLength(1)
    expect(created[0].fileKey).toBe('events/noyyal-marathon-2026/certificates/RDC-2026-AB12CD.pdf')
    expect(created[0].fileSize).toBe(4)
    expect(created[0].fileUrl).toBeNull()
  })

  it('5 · STILL persists the placeholder snapshot — regeneration and legacy records need it', async () => {
    await run()
    const data = created[0].data as Record<string, string>

    // issueDate in particular: without it a later re-render would stamp today's date.
    expect(data.participantName).toBe('Bala Ganapathy')
    expect(data.eventName).toBe('Noyyal Marathon 2026')
    expect(data.eventDate).toBe('15 June 2026')
    expect(data.bibNumber).toBe('1234')
    expect(data.finishTime).toBe('00:52:10')
    expect(data.position).toBe('7')
    expect(data.issueDate).toBeTruthy()
  })

  it('6 · still records identity, verification and attribution fields', async () => {
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
})
