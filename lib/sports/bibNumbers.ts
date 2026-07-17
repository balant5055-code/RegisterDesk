// lib/sports/bibNumbers.ts
//
// LEGACY COMPATIBILITY ADAPTER.
//
// This module's public signatures are unchanged so the existing bib route and
// UI keep working with zero modification — but all assignment logic now flows
// through the generic Participant Identity engine (lib/identifiers/engine.ts).
// There is NO bib-specific allocation logic anymore; "bib" is just a label.
//
// Server-side only — uses the Firebase Admin SDK (via the engine).

import { allocateIdentifier, releaseIdentifier } from '@/lib/identifiers/engine'

export interface BibAssignResult {
  bibNumber:   string
  bibCategory: string
}

/**
 * Assigns the next sequential identifier to a registration (legacy "sequential
 * bib"). Delegates to the engine's automatic allocation, which continues the
 * sequence from the legacy bibCounters value for backward continuity.
 */
export async function assignSequentialBib(
  eventSlug:      string,
  registrationId: string,
  bibCategory     = '',
  actor           = 'system',
): Promise<BibAssignResult> {
  const result = await allocateIdentifier({
    eventSlug,
    registrationId,
    actor,
    source:   'auto',
    category: bibCategory || null,
  })
  return { bibNumber: result.value, bibCategory }
}

/**
 * Manually assigns a specific identifier (legacy "manual bib"). Delegates to the
 * engine's explicit-value allocation, which enforces uniqueness via the
 * authoritative identifierLocks layer and throws on conflict.
 */
export async function assignManualBib(
  eventSlug:      string,
  registrationId: string,
  bibNumber:      string,
  bibCategory     = '',
  actor           = 'system',
): Promise<void> {
  await allocateIdentifier({
    eventSlug,
    registrationId,
    actor,
    source:        'manual',
    explicitValue: bibNumber,
    category:      bibCategory || null,
  })
}

/**
 * Removes the identifier assignment from a registration (legacy "clear bib").
 * Delegates to the engine's release, which moves the lock to `released` and
 * clears the legacy bibNumber/bibCategory mirror atomically.
 */
export async function clearBib(
  eventSlug:      string,
  registrationId: string,
  _currentBib:    string | null | undefined,
  actor           = 'system',
): Promise<void> {
  void _currentBib   // retained for signature compatibility; engine reads live state
  void eventSlug     // engine resolves the event from the registration
  await releaseIdentifier(registrationId, actor, 'cleared')
}
