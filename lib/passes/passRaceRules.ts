// RD-CE-FIX H2 · a pass's age window and team size, read ONE way everywhere. PURE.
//
// The pass editor bound "Players per Team" to `raceDetails.minAge`, so "11 players" became
// "attendees must be 11+": the server refused younger registrants and the public page showed "11+".
// Team size now has its own field (`raceDetails.teamSize`) and age eligibility reads only the age
// fields.
//
// ═══ LEGACY DATA (no `teamSize` key) ═══════════════════════════════════════════
// For a sport whose pass editor HIDES the age inputs but shows team size (today: cricket), a stored
// `minAge` can only have come from the team-size box — it is read as the team size and never as an
// age limit. Nothing is rewritten in storage; the next save of that pass writes `teamSize` and a
// null `minAge`. For sports that show BOTH inputs (football, hockey, basketball, volleyball), the two
// boxes shared one value the organizer could see as "Min Age", so a legacy value stays an age limit —
// the organizer can correct it in the pass editor (reported, not guessed).

import { getEventSubtypeConfig } from '@/components/wizard/passSubtypeConfig'

type Rec = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** True when this pass's stored `minAge` is a legacy team size (see header). */
function legacyTeamSizeInMinAge(pass: Rec | null | undefined): boolean {
  const rd = pass?.raceDetails as Rec | null | undefined
  if (!rd || 'teamSize' in rd) return false
  const cfg = getEventSubtypeConfig(
    typeof pass?.eventType === 'string' ? pass.eventType : null,
    typeof pass?.eventSubtype === 'string' ? pass.eventSubtype : null,
  ).sportDetails
  return !!cfg?.showTeamSize && cfg.showAgeRules === false
}

/** The pass's attendee age window. Never includes a team size. */
export function passAgeLimits(pass: Rec | null | undefined): { minAge: number | null; maxAge: number | null } {
  const rd = pass?.raceDetails as Rec | null | undefined
  return {
    minAge: legacyTeamSizeInMinAge(pass) ? null : num(rd?.minAge),
    maxAge: num(rd?.maxAge),
  }
}

/** Players per team for a team-sport pass, or null. */
export function passTeamSize(pass: Rec | null | undefined): number | null {
  const rd = pass?.raceDetails as Rec | null | undefined
  if (num(rd?.teamSize) !== null) return num(rd?.teamSize)
  return legacyTeamSizeInMinAge(pass) ? num(rd?.minAge) : null
}
