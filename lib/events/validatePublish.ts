// Server-side publish validation. Never exposed to the client.
// Called by the /api/events/publish route before any status change.
//
// The mandatory-field checks are delegated to the SHARED, isomorphic
// validatePublish() so this server gate and the client Review page enforce
// byte-for-byte identical requirements — the organizer can never reach payment
// while a required field the server rejects is still missing. On failure it
// returns the SAME structured blockers the Review page renders, so a
// post-payment failure can show the REAL missing fields (never a generic
// "some fields are missing").

import type { PublishValidationResult } from '@/types/events'
import { validatePublish, toPublishBlocker } from './publishRequirements'

// Minimal shape we expect from a Firestore draft document
interface DraftSnapshot {
  status:               string
  pricing:              Record<string, unknown> | null
  eventDetails:         Record<string, unknown> | null
  communicationBilling: Record<string, unknown> | null | undefined
  registrationForm:     Record<string, unknown> | null | undefined
}

export function validateEventPublish(draft: DraftSnapshot): PublishValidationResult {
  // Guard: already published
  if (draft.status === 'published') {
    return { canPublish: false, reason: 'EVENT_ALREADY_PUBLISHED' }
  }

  // ── Required fields — SHARED source of truth (same as the client Review page) ─
  // Covers event name, schedule, venue (incl. physical venue name for
  // physical/hybrid), organizer name + email, pricing model, at least one pass,
  // and the registration form.
  const summary = validatePublish({
    pricing:          draft.pricing,
    eventDetails:     draft.eventDetails,
    registrationForm: draft.registrationForm,
  })
  if (!summary.canPublish) {
    return { canPublish: false, reason: 'INCOMPLETE_REQUIRED_FIELDS', blockers: summary.blockers }
  }

  // ── Timezone must be a valid IANA name ─────────────────────────────────────
  const schedule = (draft.eventDetails?.schedule as Record<string, unknown> | null | undefined) ?? null
  const tz = typeof schedule?.timezone === 'string' ? schedule.timezone.trim() : ''
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz })
    } catch {
      return {
        canPublish: false,
        reason:     'INVALID_TIMEZONE',
        blockers:   [toPublishBlocker({
          id: 'timezone', passed: false, stepName: 'Event Details', stepIndex: 5,
          fieldHint: 'rd-start-date',
          title: 'Invalid Timezone', description: 'Select a valid timezone in Schedule settings.',
        })],
      }
    }
  }

  // Communication billing is now handled at the publish API level:
  // — Paid events: charges deducted from settlement (no gate here).
  // — Free events: wallet balance checked atomically in the publish transaction.

  return { canPublish: true }
}
