// RD-MEDIA-01 · Gallery / album naming + input validation.
//
// PURE. No SDK, no I/O. Shared by the client form and the server route, so what the UI
// accepts and what the API accepts cannot drift.

// RD-MEDIA-02: gallery names come from the SHARED event-template config, never from Media
// Studio. This module knows how to validate and label a key, not which keys exist.
import {
  CUSTOM_GALLERY_KEY, isSafeGalleryKey, suggestionName,
} from '@/lib/events/galleryTemplates'
import type { GalleryPreset } from '@/features/media-studio/types'

export const NAME_MAX_LENGTH        = 80
export const DESCRIPTION_MAX_LENGTH = 400
export const SLUG_MAX_LENGTH        = 60

/** URL-safe slug from a display name. Falls back so a slug is never empty. */
export function toSlug(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '')
  return slug || fallback
}

/** Makes a slug unique within a set by suffixing -2, -3, … */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`.slice(0, SLUG_MAX_LENGTH)
    if (!taken.has(candidate)) return candidate
  }
  // Practically unreachable; better than looping forever.
  return `${base}-${Date.now().toString(36)}`.slice(0, SLUG_MAX_LENGTH)
}

export type NameValidation =
  | { ok: true;  value: string }
  | { ok: false; error: string }

export function validateName(raw: unknown, what = 'Name'): NameValidation {
  if (typeof raw !== 'string') return { ok: false, error: `${what} is required.` }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (value === '')                      return { ok: false, error: `${what} is required.` }
  if (value.length > NAME_MAX_LENGTH)    return { ok: false, error: `${what} must be ${NAME_MAX_LENGTH} characters or fewer.` }
  return { ok: true, value }
}

export function validateDescription(raw: unknown): NameValidation {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false, error: 'Description must be text.' }
  const value = raw.trim()
  if (value.length > DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.` }
  }
  return { ok: true, value }
}

/**
 * Whether a value may be persisted as a gallery `preset`.
 *
 * A SHAPE check, not a membership check — the valid set now depends on the selected event's
 * template, and a gallery must stay valid if that template later changes. Bounded and
 * slug-shaped, so nothing hostile reaches Firestore.
 */
export function isGalleryPreset(v: unknown): v is GalleryPreset {
  return v === CUSTOM_GALLERY_KEY || isSafeGalleryKey(v)
}

/**
 * Display name for a suggestion key, resolved across EVERY template.
 *
 * Global on purpose: an organizer may change their event's type after creating galleries,
 * and a stored key must still label itself. Falls back to 'Custom' for an unknown key.
 */
export function presetName(preset: GalleryPreset): string {
  return suggestionName(preset) ?? 'Custom'
}
