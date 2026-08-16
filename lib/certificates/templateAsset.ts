// RD-CERT-TPL-R2 · where a certificate TEMPLATE's bytes come from. Server-only.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// Generated certificates already live in R2 (fileKey); their templates did not — they were
// uploaded by the BROWSER straight to Firebase Storage and identified by a download URL.
// That left one certificate pipeline reading from two different stores with two different
// security models, and it is why the renderer had to carry Firebase URL validation.
//
// This is the ONE place that knows how a template becomes bytes. Nothing else resolves a
// template source, so the two stores can never drift apart in the renderer, the bulk
// prefetch or the builder.
//
// ═══ RESOLUTION ORDER, AND WHY IT DOES NOT FALL BACK ═════════════════════════
//   1. fileKey  → platform storage (R2), the canonical source
//   2. fileUrl  → the legacy Firebase path, with its EXISTING SSRF validation unchanged
//   3. neither  → a clear failure
//
// A `fileKey` that cannot be read is a STORAGE FAILURE, not a reason to try Firebase: the
// same precedent the generated-artifact download route set. Falling back would render the
// superseded template and hand the attendee a certificate that looks subtly wrong — worse
// than failing, because nothing downstream would flag it.

import { storage } from '@/features/platform-storage'
import { buildObjectKey } from '@/features/platform-storage'
import { safeFetchBytes, validateEventTemplateUrl, validateGlobalTemplateUrl } from './urlGuard'
import { MAX_TEMPLATE_BYTES } from './constants'
import type { CertificateTemplateDoc } from './types'

/** Raised when a template's bytes cannot be produced. Never thrown for a legacy miss. */
export class TemplateAssetError extends Error {
  constructor(message: string, readonly code: 'missing_source' | 'storage_failure') {
    super(message)
    this.name = 'TemplateAssetError'
  }
}

/**
 * The canonical object key for a template file.
 *
 * SERVER-GENERATED and deterministic in its scoping: the organizer and event are baked into
 * the path, so a key cannot be pointed at another workspace's folder even if a client tried
 * to supply one. `templateId` keeps replacements from colliding, and the sanitised filename
 * is kept only so the object is recognisable in a bucket listing.
 */
export function buildTemplateObjectKey(params: {
  organizerUid: string
  eventId:      string
  templateId:   string
  fileName:     string
}): string {
  // Consecutive dots are collapsed as well as separators stripped: assertSafeKey rejects any
  // key containing "..", so an ordinary filename like "report..final.pdf" would otherwise
  // fail signing with an opaque storage error rather than uploading.
  const safeName = params.fileName
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(-120) || 'template'
  return buildObjectKey({
    type:      'event-certificate-template',
    eventSlug: params.eventId,
    objectId:  `${params.organizerUid}/${params.templateId}/${safeName}`,
  })
}

/**
 * The folder every template object for one organizer+event must sit under.
 *
 * This is what makes a client-supplied `fileKey` safe to accept: the create route recomputes
 * this prefix from the AUTHENTICATED uid and the event in the path, so a key naming another
 * workspace's folder cannot match. Derived from buildObjectKey rather than hand-written, so
 * it cannot drift from the keys buildTemplateObjectKey actually mints.
 */
export function buildTemplateKeyPrefix(params: { organizerUid: string; eventId: string }): string {
  return buildObjectKey({
    type:      'event-certificate-template',
    eventSlug: params.eventId,
    objectId:  `${params.organizerUid}/`,
  })
}

/**
 * The template's bytes, from whichever store owns them.
 *
 * `checkUrl` is the caller's existing Firebase validator, passed in so this module does not
 * duplicate the event-vs-global template rule that generate.ts already owns.
 */
export async function loadTemplateBytes(
  template: Pick<CertificateTemplateDoc, 'fileKey' | 'fileUrl'>,
  checkUrl: (url: string) => ReturnType<typeof validateEventTemplateUrl>,
): Promise<Uint8Array> {
  if (template.fileKey) {
    // storage.download applies assertSafeKey, so a malformed or tampered key throws here
    // rather than reaching the provider. Deliberately NOT safeFetchBytes: a key is not a
    // URL, and Firebase URL validation would reject every valid R2 key.
    const got = await storage.download(template.fileKey).catch(() => {
      throw new TemplateAssetError(
        `The certificate template could not be read from storage (${template.fileKey}).`,
        'storage_failure',
      )
    })
    return got.body
  }

  if (template.fileUrl) {
    // LEGACY, unchanged: the existing SSRF guard and size ceiling, exactly as before.
    return safeFetchBytes(template.fileUrl, checkUrl(template.fileUrl), { maxBytes: MAX_TEMPLATE_BYTES })
  }

  throw new TemplateAssetError(
    'This certificate template has no stored file. Re-upload the template before issuing.',
    'missing_source',
  )
}

/**
 * Identity of the template's SOURCE, for the render cache.
 *
 * The cache key used to be `templateId:fileUrl`. Once a template can be re-uploaded to R2,
 * that string is unchanged while the bytes are not — a stale cache would render the old
 * design. Including the resolved source makes a storage change a cache miss.
 */
export function templateSourceIdentity(
  template: Pick<CertificateTemplateDoc, 'fileKey' | 'fileUrl'>,
): string {
  if (template.fileKey) return `key:${template.fileKey}`
  if (template.fileUrl) return `url:${template.fileUrl}`
  return 'none'
}

/** True when the template's bytes live in platform storage rather than Firebase. */
export function isR2Template(
  template: Pick<CertificateTemplateDoc, 'fileKey'>,
): boolean {
  return typeof template.fileKey === 'string' && template.fileKey.length > 0
}

export { validateEventTemplateUrl, validateGlobalTemplateUrl }
