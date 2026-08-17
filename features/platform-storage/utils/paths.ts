// RD-STORAGE-01 · Platform Storage — THE bucket hierarchy.
//
// PURE. No SDK, no I/O.
//
// Every object key in RegisterDesk is produced here. A caller never concatenates a path, so
// the hierarchy can be reorganised in one file and a key can never be malformed or escape
// its prefix.
//
//   registerdesk-assets/
//     events/{eventSlug}/
//       banners/
//       photos/original/ | photos/medium/ | photos/thumbnail/
//       certificates/
//       finisher-badges/
//       branding/
//       reports/
//     marketing/logos/
//     marketing/sponsors/
//     system/
//
// `events/{eventSlug}/…` is deliberately keyed by SLUG, not by organizer uid: the slug is
// already the public identity of an event elsewhere in the platform (`events/{slug}`,
// `/results/{eventSlug}`), and it keeps a public URL readable. Ownership is enforced by the
// calling route, exactly as it is for every other organizer resource — a bucket path is not
// an authorization mechanism.

import { StorageError } from '@/features/platform-storage/types/errors'
import type { StorageAssetType, StorageVisibility } from '@/features/platform-storage/types'

/** Folder segment for each asset type, relative to its root. */
const TYPE_SEGMENT: Readonly<Record<StorageAssetType, string>> = {
  'event-banner':          'banners',
  'event-photo-original':  'photos/original',
  'event-photo-medium':    'photos/medium',
  'event-photo-thumbnail': 'photos/thumbnail',
  'event-certificate':     'certificates',
  'event-certificate-template': 'certificates/templates',
  'event-attendee-photo':  'attendee-photos',
  'event-certificate-photo-tmp': 'certificate-photos-tmp',
  'event-certificate-photo':     'certificate-photos',
  'event-finisher-badge':  'finisher-badges',
  'event-branding-overlay': 'branding',
  'event-report':          'reports',
  'marketing-logo':        'marketing/logos',
  'marketing-sponsor':     'marketing/sponsors',
  'system':                'system',
}

/** Asset types that live under `events/{eventSlug}/` and therefore REQUIRE a slug. */
const EVENT_SCOPED: ReadonlySet<StorageAssetType> = new Set<StorageAssetType>([
  'event-banner', 'event-photo-original', 'event-photo-medium', 'event-photo-thumbnail',
  'event-certificate', 'event-finisher-badge', 'event-report', 'event-branding-overlay',
  'event-certificate-template',
  'event-attendee-photo', 'event-certificate-photo-tmp', 'event-certificate-photo',
])

export function isEventScoped(type: StorageAssetType): boolean {
  return EVENT_SCOPED.has(type)
}

/**
 * Default visibility per type.
 *
 * Certificates and reports default to SIGNED_URL: they name a participant and must not be
 * enumerable. Banners, photos and marketing assets are public by nature.
 */
const DEFAULT_VISIBILITY: Readonly<Record<StorageAssetType, StorageVisibility>> = {
  'event-banner':          'PUBLIC',
  'event-photo-original':  'SIGNED_URL',   // originals are the photographer's asset
  'event-photo-medium':    'PUBLIC',
  'event-photo-thumbnail': 'PUBLIC',
  'event-certificate':     'SIGNED_URL',   // never PUBLIC — see validation.ts
  // The organizer's own design asset — private, exactly like the certificates it renders.
  'event-certificate-template': 'SIGNED_URL',
  // A photograph of an identifiable person on a named registration. SIGNED_URL, never
  // PUBLIC: the only readers are the owning attendee (short-lived signed URL, issued after
  // an ownership check) and the certificate renderer (server-side, by key).
  'event-attendee-photo':  'SIGNED_URL',
  // Temporary per-certificate photo. SIGNED_URL for the same reason as the permanent one.
  'event-certificate-photo-tmp': 'SIGNED_URL',
  // Persisted certificate photo — private for the same reason as every other photo of a
  // named person; reachable only through the authorized photo endpoint.
  'event-certificate-photo':     'SIGNED_URL',
  'event-finisher-badge':  'PUBLIC',
  // The overlay is composited into a download by the BROWSER, so it must be fetchable by
  // anyone who may download a branded photo. It contains only artwork the organizer chose
  // to put on their own participants' photographs.
  'event-branding-overlay': 'PUBLIC',
  'event-report':          'SIGNED_URL',
  'marketing-logo':        'PUBLIC',
  'marketing-sponsor':     'PUBLIC',
  'system':                'PRIVATE',
}

export function defaultVisibility(type: StorageAssetType): StorageVisibility {
  return DEFAULT_VISIBILITY[type]
}

/**
 * A slug segment safe to embed in a key.
 *
 * Rejects rather than sanitises: a slug that needs cleaning is a caller bug, and silently
 * rewriting it would put an object somewhere the caller does not expect.
 *
 * ─── RD-MEDIA-03: why this accepts upper case ────────────────────────────────
 * This used to demand lower case, and it was WRONG about what a RegisterDesk event slug is.
 * The platform mints one in `app/api/events/publish/route.ts` as:
 *
 *     `${slugify(eventName)}-${draftId.slice(-6)}`
 *
 * `draftId` is a Firestore document id — `[A-Za-z0-9]{20}` — so a perfectly ordinary event
 * is published at `kochi-marathon-YYw3OU`, and every upload for it failed validation here.
 *
 * Lower-casing the slug would have been the wrong repair TWICE over: object keys are
 * case-sensitive, so `events/kochi-marathon-yyw3ou/` is a different prefix from the one the
 * event actually lives at — the module would have written to a location nothing else could
 * find, and existing objects would have been orphaned. The slug is the platform's public
 * identity for an event (`events/{slug}`, `/results/{eventSlug}`); storage's job is to
 * accept it verbatim, not to have an opinion about its case.
 *
 * So the rule is now: the characters a Firestore document id and a slugified name can
 * produce, and nothing else. Dots are still refused outright, which is what forecloses `..`.
 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,98}[A-Za-z0-9]$|^[A-Za-z0-9]$/

export function assertSafeSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new StorageError(
      'INVALID_INPUT',
      `Invalid event slug for a storage path: ${JSON.stringify(slug)}. `
      + 'Expected letters, digits, hyphens and underscores, 1–100 characters.',
    )
  }
}

/**
 * Builds the object key.
 *
 * `objectId` MUST already be a generated id (see objectKey.ts) — this function never sees
 * an uploader's filename.
 */
export function buildObjectKey(params: {
  type:      StorageAssetType
  eventSlug: string | null
  objectId:  string
  /**
   * RD-CERT-PHOTO-03 — an OPTIONAL extra segment between the type folder and the object id,
   * so an asset can be scoped to something narrower than the event. Used by the certificate
   * photo types to key a photo under its certificate, which is what makes "one certificate's
   * photo can never be another's" true at the PATH level and gives cleanup a per-certificate
   * prefix to sweep.
   *
   * Validated with the same `assertSafeSlug` as the event slug, so it can no more escape its
   * prefix than a slug can. Callers pass a server-derived id; the browser never supplies it.
   */
  scopeId?:  string
}): string {
  const { type, eventSlug, objectId, scopeId } = params
  const segment = TYPE_SEGMENT[type]
  if (!segment) throw new StorageError('INVALID_INPUT', `Unknown asset type: ${type}`)

  // Absent scopeId reproduces the previous key exactly, so every existing asset type is
  // byte-for-byte unaffected by this parameter.
  let scoped = ''
  if (scopeId) {
    assertSafeSlug(scopeId)
    scoped = `${scopeId}/`
  }

  if (EVENT_SCOPED.has(type)) {
    if (!eventSlug) {
      throw new StorageError('INVALID_INPUT', `Asset type "${type}" requires an eventSlug.`)
    }
    assertSafeSlug(eventSlug)
    return `events/${eventSlug}/${segment}/${scoped}${objectId}`
  }

  if (eventSlug) {
    throw new StorageError('INVALID_INPUT', `Asset type "${type}" must not carry an eventSlug.`)
  }
  return `${segment}/${scoped}${objectId}`
}

/** Prefix for listing — e.g. every photo thumbnail for one event. */
export function buildPrefix(type: StorageAssetType, eventSlug: string | null): string {
  const segment = TYPE_SEGMENT[type]
  if (!segment) throw new StorageError('INVALID_INPUT', `Unknown asset type: ${type}`)

  if (EVENT_SCOPED.has(type)) {
    if (!eventSlug) throw new StorageError('INVALID_INPUT', `Asset type "${type}" requires an eventSlug.`)
    assertSafeSlug(eventSlug)
    return `events/${eventSlug}/${segment}/`
  }
  return `${segment}/`
}

/** Everything belonging to one event — for a bulk lifecycle operation. */
export function buildEventPrefix(eventSlug: string): string {
  assertSafeSlug(eventSlug)
  return `events/${eventSlug}/`
}

/**
 * Guards a key that arrived from outside (a request body, a stored record).
 *
 * Rejects absolute keys, traversal, backslashes, protocol-relative forms and control
 * characters — so a caller-supplied path can never reach outside the bucket root.
 */
/** Declared as a constant so the escape is unambiguous at every call site. */
const BACKSLASH = String.fromCharCode(92)

export function assertSafeKey(key: string): void {
  const hasControlChar = [...key].some(ch => {
    const c = ch.codePointAt(0) ?? 0
    return c < 0x20 || c === 0x7f
  })

  const bad =
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes(BACKSLASH) ||
    key.includes('//') ||
    hasControlChar

  if (bad) {
    throw new StorageError('INVALID_INPUT', `Unsafe storage key: ${JSON.stringify(key.slice(0, 120))}`)
  }
}
