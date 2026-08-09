// RD-MEDIA-01 · Compression profiles.
//
// PURE. No SDK, no DOM, no I/O — so the profile maths is unit-testable and identical on the
// client (which performs the compression) and the server (which validates what it was told).
//
// The organizer NEVER compresses an image by hand: they choose a profile, and the browser
// applies it. `custom` exists for the operator who knows exactly what they want.

export interface CompressionProfile {
  id:          string
  name:        string
  /** 1–5, for the ★ rating in the picker. */
  stars:       number
  description: string
  /** Target size in bytes for a full-size photo. null ⇒ untouched original. */
  targetBytes: number | null
  /** Longest edge in px. null ⇒ no resize. */
  maxWidth:    number | null
  /** 1–100. */
  jpegQuality: number
  webpQuality: number
  recommended?: boolean
}

const MB = 1024 * 1024

/**
 * The presets. Target sizes are the mid-point of the brief's ranges, and every profile
 * except `original` re-encodes — which is what makes the saving predictable.
 */
export const COMPRESSION_PROFILES: readonly CompressionProfile[] = [
  // RD-MS-CLEANUP-01 · `original` (no compression) and `premium` (3.5 MB / 6000px) were
  // removed as OFFERED choices: they dominated R2 storage and neither is needed for the
  // product. Nothing about the pipeline changed — `balanced`, `web` and `ultra` still
  // produce the same three renditions through the same code path.
  //
  // An organizer who wants an uncompressed or near-original result can still build a custom
  // profile, so the capability is narrowed rather than removed. Events already configured
  // with either id keep working — see the fallback in `findProfile`.
  {
    id: 'balanced', name: 'Balanced', stars: 4,
    description: 'Excellent quality at roughly half the size. Right for almost every race.',
    targetBytes: Math.round(2.5 * MB), maxWidth: 4000, jpegQuality: 85, webpQuality: 82,
    recommended: true,
  },
  {
    id: 'web', name: 'Web', stars: 3,
    description: 'Optimised for fast viewing and sharing online.',
    targetBytes: Math.round(1.5 * MB), maxWidth: 2560, jpegQuality: 78, webpQuality: 75,
  },
  {
    id: 'ultra', name: 'Ultra', stars: 2,
    description: 'Smallest files. Use when storage or bandwidth is the constraint.',
    targetBytes: Math.round(0.6 * MB), maxWidth: 1920, jpegQuality: 68, webpQuality: 65,
  },
] as const

export const DEFAULT_PROFILE_ID = 'balanced'

export const CUSTOM_PROFILE_ID = 'custom'

/**
 * Resolves a profile id to a profile.
 *
 * ═══ THE FALLBACK IS HERE, AND ONLY HERE ══════════════════════════════════════
 * RD-MS-CLEANUP-01. Events configured before `original` and `premium` were withdrawn still
 * carry those ids in `defaultCompressionProfileId`, and those documents are read, never
 * re-validated. Returning null for them would have made every such event fall through to
 * whatever each call site does with null — which is a different answer per call site, and
 * exactly the kind of drift a central fallback exists to prevent.
 *
 * So an UNKNOWN id resolves to the default rather than to null. That is a deliberate change
 * of contract: this function no longer reports "no such profile". Nothing relied on it for
 * that — `/media-studio/overrides` validates writes against its own `VALID_PROFILE_IDS` set
 * (derived from the array above, so it tightened automatically), and `resolveProfile`
 * handles `custom` before it ever reaches here.
 */
export function findProfile(id: string): CompressionProfile {
  return COMPRESSION_PROFILES.find(p => p.id === id) ?? defaultProfile()
}

/**
 * The default profile.
 *
 * Reads the array DIRECTLY rather than going through `findProfile`. Since RD-MS-CLEANUP-01
 * that function falls back to this one, so delegating would be mutually recursive — harmless
 * while `balanced` exists, and an infinite loop the day someone renames it. The final `??`
 * keeps that failure a wrong-but-terminating answer rather than a hung tab.
 */
export function defaultProfile(): CompressionProfile {
  return COMPRESSION_PROFILES.find(p => p.id === DEFAULT_PROFILE_ID) ?? COMPRESSION_PROFILES[0]
}

// ─── Custom profile ───────────────────────────────────────────────────────────

export interface CustomProfileInput {
  targetBytes: number | null
  maxWidth:    number | null
  jpegQuality: number
  webpQuality: number
}

/** Bounds a custom profile must respect. Rejecting is better than clamping silently: an
 *  organizer who typed 5 should learn that quality 5 is not offered. */
export const CUSTOM_LIMITS = {
  minTargetBytes: 50 * 1024,        // 50 KB
  maxTargetBytes: 50 * MB,
  minWidth:       320,
  maxWidth:       12000,
  minQuality:     40,
  maxQuality:     100,
} as const

export type CustomProfileResult =
  | { ok: true;  profile: CompressionProfile }
  | { ok: false; error: string }

export function buildCustomProfile(input: CustomProfileInput): CustomProfileResult {
  const { targetBytes, maxWidth, jpegQuality, webpQuality } = input

  if (targetBytes !== null) {
    if (!Number.isFinite(targetBytes) || targetBytes < CUSTOM_LIMITS.minTargetBytes || targetBytes > CUSTOM_LIMITS.maxTargetBytes) {
      return { ok: false, error: `Target size must be between ${Math.round(CUSTOM_LIMITS.minTargetBytes / 1024)} KB and ${CUSTOM_LIMITS.maxTargetBytes / MB} MB.` }
    }
  }
  if (maxWidth !== null) {
    if (!Number.isInteger(maxWidth) || maxWidth < CUSTOM_LIMITS.minWidth || maxWidth > CUSTOM_LIMITS.maxWidth) {
      return { ok: false, error: `Maximum width must be between ${CUSTOM_LIMITS.minWidth} and ${CUSTOM_LIMITS.maxWidth} pixels.` }
    }
  }
  for (const [label, q] of [['JPEG', jpegQuality], ['WEBP', webpQuality]] as const) {
    if (!Number.isInteger(q) || q < CUSTOM_LIMITS.minQuality || q > CUSTOM_LIMITS.maxQuality) {
      return { ok: false, error: `${label} quality must be between ${CUSTOM_LIMITS.minQuality} and ${CUSTOM_LIMITS.maxQuality}.` }
    }
  }

  return {
    ok: true,
    profile: {
      id: CUSTOM_PROFILE_ID, name: 'Custom', stars: 3,
      description: 'Your own compression settings.',
      targetBytes, maxWidth, jpegQuality, webpQuality,
    },
  }
}

/** Resolves a profile id, accepting an inline custom definition. */
export function resolveProfile(
  id: string,
  custom?: CustomProfileInput | null,
): CompressionProfile | null {
  if (id === CUSTOM_PROFILE_ID) {
    if (!custom) return null
    const built = buildCustomProfile(custom)
    return built.ok ? built.profile : null
  }
  return findProfile(id)
}

// ─── Estimation ───────────────────────────────────────────────────────────────

/**
 * Predicted stored size for ONE source photo under a profile.
 *
 * A deliberate approximation, and labelled as such everywhere it is shown. A real size is
 * only known after the browser re-encodes — the preview exists to set expectations, not to
 * make a promise.
 *
 * The rule: a photo already smaller than the target is never inflated, so the estimate is
 * `min(source, target)`. That matches what the encoder actually does.
 */
export function estimateCompressedBytes(sourceBytes: number, profile: CompressionProfile): number {
  if (profile.targetBytes === null) return sourceBytes           // Original — untouched
  if (sourceBytes <= profile.targetBytes) return sourceBytes     // never inflate
  return profile.targetBytes
}

/** Derivative sizes, as a fraction of the compressed original. Measured rules of thumb. */
export const MEDIUM_RATIO    = 0.25
export const THUMBNAIL_RATIO = 0.04

export interface RenditionPlan {
  keepOriginal:      boolean
  generateMedium:    boolean
  generateThumbnail: boolean
}

/** Total bytes stored for one photo, across every rendition that will be produced. */
export function estimateStoredBytes(
  sourceBytes: number,
  profile: CompressionProfile,
  plan: RenditionPlan,
): number {
  const compressed = estimateCompressedBytes(sourceBytes, profile)
  let total = plan.keepOriginal ? compressed : 0
  if (plan.generateMedium)    total += Math.round(compressed * MEDIUM_RATIO)
  if (plan.generateThumbnail) total += Math.round(compressed * THUMBNAIL_RATIO)
  // A plan that stores nothing is a caller bug; fall back to the compressed original rather
  // than silently reporting zero.
  return total > 0 ? total : compressed
}

export interface BatchEstimate {
  photoCount:      number
  currentBytes:    number
  estimatedBytes:  number
  savedBytes:      number
  savingsPercent:  number
  /** Seconds, at the given throughput. */
  estimatedSeconds: number
}

/** Assumed upload throughput when the browser has no better measurement: 8 Mbit/s. */
export const DEFAULT_THROUGHPUT_BYTES_PER_SEC = 1_000_000

export function estimateBatch(
  sourceSizes: readonly number[],
  profile: CompressionProfile,
  plan: RenditionPlan,
  throughputBytesPerSec: number = DEFAULT_THROUGHPUT_BYTES_PER_SEC,
): BatchEstimate {
  const currentBytes   = sourceSizes.reduce((n, s) => n + s, 0)
  const estimatedBytes = sourceSizes.reduce((n, s) => n + estimateStoredBytes(s, profile, plan), 0)
  const savedBytes     = Math.max(0, currentBytes - estimatedBytes)

  const throughput = throughputBytesPerSec > 0 ? throughputBytesPerSec : DEFAULT_THROUGHPUT_BYTES_PER_SEC

  return {
    photoCount:     sourceSizes.length,
    currentBytes,
    estimatedBytes,
    savedBytes,
    savingsPercent: currentBytes > 0 ? Math.round((savedBytes / currentBytes) * 100) : 0,
    // Bytes actually sent are the stored bytes — derivatives are uploaded too.
    estimatedSeconds: Math.ceil(estimatedBytes / throughput),
  }
}
