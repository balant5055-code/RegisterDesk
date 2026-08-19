// RD-CERT-PHOTO-01 — the GENERATION side of the attendee photo.
//
// The sibling suite (certificatePersonalizedRender) covers the on-demand download path and
// its override. This one covers what happens at ISSUANCE and at REGENERATION:
//
//   • a template with no photo area must perform NO storage read at all — the feature has to
//     be free for the events that do not use it, and a per-certificate read in a 10,000-strong
//     bulk job would be 10,000 reads nobody asked for;
//   • the photo KEY is snapshotted alongside the placeholder values, so a re-render can
//     reproduce the certificate as issued;
//   • REGENERATION uses that snapshot. This is the case that silently loses data if missed:
//     regenerate overwrites the stored artifact, so a photo-less re-render permanently
//     replaces a good certificate.
//
// Storage is mocked at the module boundary — the same shape the artifact-persistence suite
// uses. No LocalStorageProvider, no RD-STORAGE-02.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Every key the generation path asked storage to download. */
const downloads: string[] = []
const rendered:  Array<{ attendeePhoto?: Uint8Array; layout: unknown }> = []
const created:   Record<string, unknown>[] = []
const regenerated: Array<Record<string, unknown>> = []

const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01])
let downloadShouldFail = false
let certificateDoc: Record<string, unknown> | null = null
let activeTemplate: unknown = null

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (input: { id?: string; eventSlug: string; body: Uint8Array }) => ({
        metadata: { path: `events/${input.eventSlug}/certificates/${input.id ?? 'x'}`, size: input.body.byteLength },
      }),
      delete: async () => {},
      download: async (key: string) => {
        downloads.push(key)
        if (downloadShouldFail) throw new Error('object missing')
        return { body: PHOTO_BYTES, mimeType: 'image/jpeg', size: PHOTO_BYTES.byteLength }
      },
      generateSignedUrl: async () => 'https://r2.test/signed',
    },
  }
})

vi.mock('@/lib/certificates/render', () => ({
  renderCertificatePdf: async (input: { attendeePhoto?: Uint8Array; layout: unknown }) => {
    rendered.push({ attendeePhoto: input.attendeePhoto, layout: input.layout })
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
  },
}))

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
  getCertificate:       async () => certificateDoc,
  getActiveTemplate:    async () => activeTemplate,
  getTemplateById:      async () => activeTemplate,
  recordCertificateRegeneration: async (_id: string, patch: Record<string, unknown>) => { regenerated.push(patch) },
  releaseCertificateClaim: async () => {},
  setCertificateArtifact: async () => {},
  getSettings:          async () => null,
  recordTemplateUsage:  async () => {},
}))

vi.mock('@/lib/certificates/billing',  () => ({ chargeCertificate: async () => ({ charged: false }) }))
vi.mock('@/lib/certificates/email',    () => ({ emailCertificate: async () => ({ success: true, skipped: true }) }))
vi.mock('@/lib/certificates/whatsapp', () => ({ sendCertificateWhatsApp: async () => {} }))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service',           () => ({ crmRecordCertificate: async () => {} }))
vi.mock('@/lib/email/appUrl',          () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/monitoring/sentry',     () => ({ captureError: () => {}, captureFinancialError: () => {} }))

import { generateCertificate, regenerateCertificate, assertTemplateIsDesigned, CertificateTemplateNotDesignedError }
  from '@/lib/certificates/generate'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CANVAS = { width: 1492, height: 1054, unit: 'px' }
const TEXT_EL = {
  id: 'e1', type: 'text', content: '{{participantName}}', zIndex: 1, x: 0.1, y: 0.4, width: 0.8,
  fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal', color: '#111111', align: 'center',
}
const PHOTO_EL = {
  id: 'p1', type: 'image', assetUrl: '', source: 'attendeePhoto', fit: 'contain',
  zIndex: 2, x: 0.1, y: 0.1, width: 0.2, height: 0.25,
}
const STATIC_EL = {
  id: 's1', type: 'image', assetUrl: 'https://storage.test/logo.png', fit: 'contain',
  zIndex: 2, x: 0.6, y: 0.1, width: 0.2, height: 0.1,
}

const templateWith = (...elements: unknown[]) => ({
  templateId: 'TPL-1', organizerUid: 'org-1', eventId: 'draft-1',
  templateType: 'png', dimensions: CANVAS,
  fileUrl: 'https://storage.test/templates/TPL-1.png', isActive: true,
  layout: { version: 1, canvas: CANVAS, elements },
}) as never

const PHOTO_KEY = 'events/noyyal-marathon-2026/attendee-photos/reg-1/photo.jpg'

const inputWith = (attendeePhotoKey?: string) => ({
  eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026', organizerUid: 'org-1',
  eventName: 'Noyyal Marathon 2026', eventDate: '15 June 2026', eventLocation: 'Coimbatore',
  organizerName: 'Noyyal Trust', registrationId: 'reg-1',
  attendeeName: 'Bala Kumar', attendeeEmail: 'bala@example.com',
  ticketCode: 'TKT-1', passName: '10K',
  bibNumber: '1234', distance: '10K', finishTime: '00:52:10', position: '7', category: 'M',
  ...(attendeePhotoKey ? { attendeePhotoKey } : {}),
}) as never

const generate = (template: unknown, attendeePhotoKey?: string) => generateCertificate({
  input: inputWith(attendeePhotoKey), certificateType: 'participation', source: 'manual', template,
} as never)

beforeEach(() => {
  downloads.length = 0; rendered.length = 0; created.length = 0; regenerated.length = 0
  downloadShouldFail = false; certificateDoc = null; activeTemplate = null
})

// ─── 1–3. When the photo is (and is not) read ─────────────────────────────────

describe('1 · a template with NO photo element performs no storage read', () => {
  it('does not download the photo even when the registration HAS a key', async () => {
    await generate(templateWith(TEXT_EL, STATIC_EL), PHOTO_KEY)
    expect(downloads).toEqual([])
    expect(rendered[0].attendeePhoto).toBeUndefined()
  })

  it('does not download when there is neither an element nor a key', async () => {
    await generate(templateWith(TEXT_EL))
    expect(downloads).toEqual([])
  })
})

describe('2 · photo element + key → the right object is downloaded', () => {
  it('downloads exactly that key, once', async () => {
    await generate(templateWith(TEXT_EL, PHOTO_EL), PHOTO_KEY)
    expect(downloads).toEqual([PHOTO_KEY])
  })

  it('4 · passes the resulting BYTES to the renderer', async () => {
    await generate(templateWith(TEXT_EL, PHOTO_EL), PHOTO_KEY)
    expect(rendered[0].attendeePhoto).toEqual(PHOTO_BYTES)
  })
})

describe('3 · photo element + MISSING key → renders without a photo', () => {
  it('performs no read and renders with attendeePhoto undefined', async () => {
    const r = await generate(templateWith(TEXT_EL, PHOTO_EL))
    expect(downloads).toEqual([])
    expect(rendered[0].attendeePhoto).toBeUndefined()
    expect((r as { success?: boolean }).success ?? true).toBeTruthy()   // still issued
  })

  it('an UNREADABLE object degrades to no photo rather than failing issuance', async () => {
    downloadShouldFail = true
    await generate(templateWith(TEXT_EL, PHOTO_EL), PHOTO_KEY)
    expect(downloads).toEqual([PHOTO_KEY])
    expect(rendered[0].attendeePhoto).toBeUndefined()
    expect(created).toHaveLength(1)          // the certificate was still created
  })
})

// ─── 5–6. Snapshot ────────────────────────────────────────────────────────────

describe('5/6 · the certificate snapshot', () => {
  it('stores the photo KEY in data, not a URL', async () => {
    await generate(templateWith(TEXT_EL, PHOTO_EL), PHOTO_KEY)
    const data = created[0].data as Record<string, unknown>
    expect(data.attendeePhotoKey).toBe(PHOTO_KEY)
    expect(String(data.attendeePhotoKey)).not.toMatch(/^https?:\/\//)
  })

  it('keeps every existing snapshot field alongside it', async () => {
    await generate(templateWith(TEXT_EL, PHOTO_EL), PHOTO_KEY)
    const data = created[0].data as Record<string, unknown>
    expect(data.participantName).toBe('Bala Kumar')
    expect(data.bibNumber).toBe('1234')
  })

  it('omits the field entirely when there is no photo — existing certificates are unchanged', async () => {
    await generate(templateWith(TEXT_EL))
    const data = created[0].data as Record<string, unknown>
    expect('attendeePhotoKey' in data).toBe(false)
  })
})

// ─── 9. Regeneration ──────────────────────────────────────────────────────────

describe('9 · regenerateCertificate uses the SNAPSHOTTED photo', () => {
  const certWith = (data: Record<string, unknown>) => ({
    certificateId: 'RDC-2026-AB12CD', eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026',
    organizerUid: 'org-1', status: 'generated', templateId: 'TPL-1', data,
  })

  it('re-renders WITH the photo the certificate was issued with', async () => {
    certificateDoc = certWith({ participantName: 'Bala Kumar', attendeePhotoKey: PHOTO_KEY })
    activeTemplate = templateWith(TEXT_EL, PHOTO_EL)

    const r = await regenerateCertificate('RDC-2026-AB12CD')
    expect((r as { ok: boolean }).ok).toBe(true)
    expect(downloads).toEqual([PHOTO_KEY])
    expect(rendered[0].attendeePhoto).toEqual(PHOTO_BYTES)
  })

  it('does NOT silently strip the photo — the regression this guards', async () => {
    certificateDoc = certWith({ participantName: 'Bala Kumar', attendeePhotoKey: PHOTO_KEY })
    activeTemplate = templateWith(TEXT_EL, PHOTO_EL)
    await regenerateCertificate('RDC-2026-AB12CD')
    expect(rendered[0].attendeePhoto).toBeDefined()
  })

  it('reads nothing for a certificate that never had a photo', async () => {
    certificateDoc = certWith({ participantName: 'Bala Kumar' })
    activeTemplate = templateWith(TEXT_EL, PHOTO_EL)
    await regenerateCertificate('RDC-2026-AB12CD')
    expect(downloads).toEqual([])
    expect(rendered[0].attendeePhoto).toBeUndefined()
  })

  it('still refuses a revoked certificate', async () => {
    certificateDoc = { ...certWith({}), status: 'revoked' }
    activeTemplate = templateWith(TEXT_EL, PHOTO_EL)
    const r = await regenerateCertificate('RDC-2026-AB12CD')
    expect(r).toEqual({ ok: false, error: 'revoked' })
    expect(downloads).toEqual([])
  })
})

// ─── 10–11. Master behaviour survives the port ────────────────────────────────

describe('10 · the designed-template guard is intact', () => {
  it('still throws for a template with no elements', () => {
    expect(() => assertTemplateIsDesigned(templateWith())).toThrow(CertificateTemplateNotDesignedError)
  })

  it('accepts a template whose ONLY element is an attendee photo', () => {
    // A photo-only certificate is a legitimate design; the guard is about "no design at all".
    expect(() => assertTemplateIsDesigned(templateWith(PHOTO_EL))).not.toThrow()
  })

  it('regeneration still refuses an undesigned active template', async () => {
    certificateDoc = { certificateId: 'RDC-2026-AB12CD', eventId: 'draft-1', eventSlug: 's',
      organizerUid: 'org-1', status: 'generated', templateId: 'TPL-1', data: {} }
    activeTemplate = templateWith()
    expect(await regenerateCertificate('RDC-2026-AB12CD')).toEqual({ ok: false, error: 'no_active_template' })
  })
})

describe('11 · static certificate generation is unchanged', () => {
  it('a static-only template renders with no photo and no storage read', async () => {
    await generate(templateWith(TEXT_EL, STATIC_EL), PHOTO_KEY)
    expect(downloads).toEqual([])
    expect(rendered[0].attendeePhoto).toBeUndefined()
    expect(created).toHaveLength(1)
  })

  it('the layout reaches the renderer untouched', async () => {
    const tpl = templateWith(TEXT_EL, STATIC_EL)
    await generate(tpl, undefined)
    expect(rendered[0].layout).toEqual((tpl as unknown as { layout: unknown }).layout)
  })
})
