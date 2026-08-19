// RD-CERT-PHOTO-02 — the personalized render.
//
// The attendee gets their photo on the PDF they download. What they must NOT get is a
// second certificate: no reissue, no new id, no status change, no stored file. This file
// pins that distinction, because it is the one place where "make the photo appear" could
// quietly turn into "issue a different certificate".

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Assertion surfaces ───────────────────────────────────────────────────────
const uploads: string[] = []
const recordWrites: string[] = []
let lastRender: Record<string, unknown> | null = null

vi.mock('@/lib/firebase/storage/admin', () => ({
  uploadServerFile: async (path: string) => { uploads.push(path); return { url: `https://storage.test/${path}` } },
}))
vi.mock('@/lib/certificates/render', () => ({
  renderCertificatePdf: async (args: Record<string, unknown>) => {
    lastRender = args
    return new Uint8Array([0x25, 0x50, 0x44, 0x46])
  },
}))
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => new Uint8Array([1, 2, 3]),
  validateEventTemplateUrl:  () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }),
  validateGeneratedCertificateUrl: () => ({ ok: true }),
}))

/** Distinct bytes per key, so "whose photo printed" is decidable. */
const PHOTO_BYTE: Record<string, number> = {
  'events/evt/attendee-photos/issued': 0x11,
  'events/evt/attendee-photos/fresh':  0x22,
  'events/evt/attendee-photos/father': 0x33,
}
const downloadedKeys: string[] = []
vi.mock('@/features/platform-storage', () => ({
  storage: {
    download: async (key: string) => {
      downloadedKeys.push(key)
      const b = PHOTO_BYTE[key]
      if (b === undefined) throw new Error('no such object')
      return { body: Buffer.from([b, b, b, b]) }
    },
  },
}))

const TEMPLATE_WITH_PHOTO = {
  templateId: 'TPL-1', organizerUid: 'org-1', eventId: 'draft-1',
  templateType: 'png', dimensions: { width: 1492, height: 1054, unit: 'px' },
  fileUrl: 'https://storage.test/templates/TPL-1.png',
  layout: { elements: [{ id: 'i1', type: 'image', source: 'attendeePhoto', assetUrl: '', fit: 'contain' }] },
  isActive: true,
}
const TEMPLATE_NO_PHOTO = {
  ...TEMPLATE_WITH_PHOTO, templateId: 'TPL-2',
  layout: { elements: [{ id: 't1', type: 'text', text: 'hi' }] },
}

let template: Record<string, unknown> = TEMPLATE_WITH_PHOTO
let certificate: Record<string, unknown> | null = null

vi.mock('@/lib/certificates/firestore', () => ({
  assertRegistrationEligibleForCertificate: async () => {},
  findCertificate:      async () => null,
  reserveCertificateId: async () => ({ certificateId: 'RDC-2026-AB12CD', owned: true }),
  createCertificate:    async () => { recordWrites.push('createCertificate'); return {} },
  getCertificate:       async () => certificate,
  getActiveTemplate:    async () => template,
  getTemplateById:      async () => template,
  recordCertificateRegeneration: async () => { recordWrites.push('recordCertificateRegeneration') },
  releaseCertificateClaim: async () => { recordWrites.push('releaseCertificateClaim') },
  getSettings:          async () => null,
  recordTemplateUsage:  async () => { recordWrites.push('recordTemplateUsage') },
}))
vi.mock('@/lib/certificates/billing',  () => ({ chargeCertificate: async () => ({ charged: false }) }))
vi.mock('@/lib/certificates/email',    () => ({ emailCertificate: async () => ({ success: true, skipped: true }) }))
vi.mock('@/lib/certificates/whatsapp', () => ({ sendCertificateWhatsApp: async () => {} }))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service',           () => ({ crmRecordCertificate: async () => {} }))
vi.mock('@/lib/email/appUrl',          () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/monitoring/sentry',     () => ({ captureError: () => {}, captureFinancialError: () => {} }))

import { renderCertificateOnDemand, __clearCertificateAssetCache } from '@/lib/certificates/generate'

const ID = 'RDC-2026-AB12CD'

/** The issued record: photo snapshotted at issuance, id and status fixed. */
function issued(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    certificateId: ID, eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026',
    organizerUid: 'org-1', templateId: 'TPL-1', status: 'issued',
    issuedAt: '2026-06-15T04:00:00.000Z',
    data: { participantName: 'Child 2', bibNumber: '102', attendeePhotoKey: 'events/evt/attendee-photos/issued' },
    ...extra,
  }
}

const photoOf = (r: Record<string, unknown> | null) => (r?.attendeePhoto as Uint8Array | undefined)?.[0]

beforeEach(() => {
  uploads.length = 0
  recordWrites.length = 0
  downloadedKeys.length = 0
  lastRender = null
  template = TEMPLATE_WITH_PHOTO
  certificate = issued()
  __clearCertificateAssetCache()
})

describe('the issued render is unchanged', () => {
  it('prints the photo from the SNAPSHOT when no override is supplied', async () => {
    const r = await renderCertificateOnDemand(ID)
    expect(r.ok).toBe(true)
    expect(photoOf(lastRender)).toBe(0x11)
    expect(downloadedKeys).toEqual(['events/evt/attendee-photos/issued'])
  })

  it('prints no photo at all when the certificate never had one', async () => {
    certificate = issued({ data: { participantName: 'Child 2' } })
    await renderCertificateOnDemand(ID)
    expect(lastRender!.attendeePhoto).toBeUndefined()
    expect(downloadedKeys).toEqual([])
  })
})

describe('the override changes ONE render input and nothing else', () => {
  it('prints the fresh photo instead of the snapshotted one', async () => {
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(photoOf(lastRender)).toBe(0x22)
  })

  it('prints a photo for a certificate issued without one', async () => {
    certificate = issued({ data: { participantName: 'Child 2' } })
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(photoOf(lastRender)).toBe(0x22)
  })

  it('does NOT reissue: no record write, no claim change, no id change', async () => {
    const r = await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(recordWrites).toEqual([])
    expect(r.ok && r.filename).toBe(`certificate-${ID}.pdf`)
  })

  it('does NOT store the personalized PDF anywhere', async () => {
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(uploads).toEqual([])
  })

  it('renders every other value from the ISSUED snapshot, not from live data', async () => {
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    const ctx = lastRender!.context as Record<string, unknown>
    expect(ctx.participantName).toBe('Child 2')
    expect(ctx.bibNumber).toBe('102')
  })

  it('falls back to the issued photo when the override object is unreadable', async () => {
    // Storage hiccup must degrade to the certificate that was issued, never to an error.
    const r = await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/missing' })
    expect(r.ok).toBe(true)
    expect(lastRender!.attendeePhoto).toBeUndefined()
  })

  it('is ignored entirely when the template has no photo area', async () => {
    template = TEMPLATE_NO_PHOTO
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(lastRender!.attendeePhoto).toBeUndefined()
    // Not merely unused — never even read, so a template without a photo area costs nothing.
    expect(downloadedKeys).toEqual([])
  })
})

describe('one attendee’s photo can never print on another’s certificate', () => {
  it('keeps the photo OUT of the shared, template-keyed asset map', async () => {
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    // `assets` is cached per template and reused across every certificate in a batch.
    const assets = lastRender!.assets as Map<string, Uint8Array> | undefined
    for (const bytes of assets?.values() ?? []) expect(bytes[0]).not.toBe(0x22)
  })

  it('two consecutive renders off the SAME cached template carry different photos', async () => {
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    const first = photoOf(lastRender)
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/father' })
    const second = photoOf(lastRender)
    expect(first).toBe(0x22)
    expect(second).toBe(0x33)
  })

  it('a render with no override after one WITH an override reverts to the snapshot', async () => {
    await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    await renderCertificateOnDemand(ID)
    expect(photoOf(lastRender)).toBe(0x11)
  })
})

describe('gates that must still hold', () => {
  it('refuses a revoked certificate even with a valid override', async () => {
    certificate = issued({ status: 'revoked' })
    const r = await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(r).toEqual({ ok: false, error: 'revoked' })
  })

  it('refuses a certificate that does not exist', async () => {
    certificate = null
    const r = await renderCertificateOnDemand(ID, { attendeePhotoKeyOverride: 'events/evt/attendee-photos/fresh' })
    expect(r).toEqual({ ok: false, error: 'not_found' })
  })
})
