// RD-CE-FIX H3 · what an event-TYPE change must reset. PURE.
//
// Step 1 used to write only the four type keys, so switching Conference → Workshop (or Sports →
// anything) kept the old type's data: its `typeDetails` shape (which crashed the Details step when
// cast to the new type), sports `raceDetails` on every pass (age gating + "Sports & Fitness" labels),
// the old type's benefit ids, and a registration-form template full of the old type's fields —
// including REQUIRED sports waiver / medical-consent checkboxes — all of which then published.
//
// The policy is explicit and narrow: reset exactly what the new type cannot use; keep everything
// that stays valid (event name, schedule, venue, organizer, media, SEO, pass names / prices /
// quantities / sales windows, visibility, access control).
//
//   typeDetails       — reset when the Details-tab section type changes (getTab6Config).
//   pass raceDetails  — reset when the sport details block changes or disappears.
//   pass benefits     — the TYPE vocabulary ids reset when the event type changes (custom kept).
//   pass type stamps  — every pass is re-stamped with the new type/subtype.
//   registrationForm  — reset when its template is not one the new type offers; the organizer
//                        picks a template for the new type (waiver/medical fields go with it).
//   linkedCampaign    — reset unless the new flow is event_plus_donation.

import { getTab6Config, makeBlankTypeDetails } from '@/components/wizard/eventDetailsConfig'
import { getEventSubtypeConfig } from '@/components/wizard/passSubtypeConfig'
import { getFormTemplates } from '@/components/wizard/registrationFormConfig'
import { EVENT_TYPE_NAMES } from '@/lib/events/taxonomy'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {})
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export interface TypeIdentity { eventType: string | null; eventSubtype: string | null; campaignType: string | null }

export interface TypeTransitionPlan {
  /** True when the type/subtype/campaign flow actually changes. */
  changed: boolean
  /** Human labels of what will be reset — empty when nothing already entered is lost. */
  resets:  string[]
  /** Draft fields to write together with the new type keys (absent = unchanged). */
  patch:   Partial<Record<'pricing' | 'registrationForm' | 'eventDetails' | 'linkedCampaign', unknown>>
}

const sportBlock = (t: TypeIdentity) => getEventSubtypeConfig(t.eventType, t.eventSubtype).sportDetails ?? null

export function planTypeTransition(draft: Rec, next: TypeIdentity): TypeTransitionPlan {
  const prev: TypeIdentity = { eventType: s(draft.eventType), eventSubtype: s(draft.eventSubtype), campaignType: s(draft.campaignType) }
  const changed = prev.eventType !== next.eventType || prev.eventSubtype !== next.eventSubtype || prev.campaignType !== next.campaignType
  const out: TypeTransitionPlan = { changed, resets: [], patch: {} }
  if (!changed || prev.eventType === null) return out   // first pick: nothing to reconcile

  // ── type-specific details (the Details step's extra tab) ──────────────────────────
  const details = rec(draft.eventDetails)
  const prevTab = getTab6Config(prev.eventType, prev.eventSubtype)
  const nextTab = getTab6Config(next.eventType, next.eventSubtype)
  if (details.typeDetails != null && prevTab?.sectionType !== nextTab?.sectionType) {
    out.patch.eventDetails = { ...details, typeDetails: null }
    out.resets.push(prevTab ? `${prevTab.tabTitle}` : 'Type-specific details')
  }

  // ── passes: sport details, type benefits, type stamps ─────────────────────────────
  const pricing = rec(draft.pricing)
  const passes = Array.isArray(pricing.passes) ? pricing.passes as Rec[] : []
  if (passes.length > 0) {
    const sportChanged = sportBlock(prev) !== sportBlock(next)
    const typeChanged  = prev.eventType !== next.eventType
    let raceCleared = 0, benefitsCleared = 0
    const nextPasses = passes.map(p => {
      const q: Rec = { ...p, eventType: next.eventType, eventSubtype: next.eventSubtype }
      if (sportChanged && p.raceDetails != null) { q.raceDetails = null; raceCleared++ }
      if (typeChanged && Array.isArray(p.benefits) && p.benefits.length > 0) { q.benefits = []; benefitsCleared++ }
      return q
    })
    out.patch.pricing = { ...pricing, passes: nextPasses }
    if (raceCleared)     out.resets.push(`${sportBlock(prev)?.sectionLabel ?? 'Sport details'} on ${raceCleared} pass${raceCleared === 1 ? '' : 'es'}`)
    if (benefitsCleared) out.resets.push(`Included benefits on ${benefitsCleared} pass${benefitsCleared === 1 ? '' : 'es'}`)
  }

  // ── registration form: keep only a template the new type offers ───────────────────
  const form = draft.registrationForm == null ? null : rec(draft.registrationForm)
  if (form) {
    const template = s(form.template)
    const allowed = new Set(getFormTemplates(next.eventType, next.eventSubtype).map(t => t.id))
    if (!template || !allowed.has(template)) {
      out.patch.registrationForm = null
      out.resets.push('Registration form (choose a form for the new event type)')
    }
  }

  // ── linked donation campaign ──────────────────────────────────────────────────────
  if (draft.linkedCampaign != null && next.campaignType !== 'event_plus_donation') {
    out.patch.linkedCampaign = null
    out.resets.push('Fundraising campaign settings')
  }
  return out
}

/**
 * Pure. True when the registration form was built from a template that belongs to a DIFFERENT event
 * type than the event's own (e.g. a running form — DOB, T-shirt, required waiver — on a conference).
 * A custom or unknown template id is never flagged.
 */
export function formTemplateIncompatible(eventType: string | null, eventSubtype: string | null, form: unknown): boolean {
  const template = s(rec(form).template)
  if (!template || !eventType) return false
  if (getFormTemplates(eventType, eventSubtype).some(t => t.id === template)) return false
  return Object.keys(EVENT_TYPE_NAMES).some(t => t !== eventType && getFormTemplates(t, null).some(x => x.id === template))
}

/** Pure. Passes with sport details removed when the event's type/format has no sport block. */
export function passesForType(eventType: string | null, eventSubtype: string | null, passes: unknown): unknown {
  if (!Array.isArray(passes)) return passes
  if (getEventSubtypeConfig(eventType, eventSubtype).sportDetails) return passes
  return passes.map(p => (p && typeof p === 'object' && (p as Rec).raceDetails != null ? { ...(p as Rec), raceDetails: null } : p))
}

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/**
 * Pure. `typeDetails` in EXACTLY the current type's shape: the blank shape for the event's
 * section type, with each stored value kept only when its key exists in that shape and its kind
 * (string / number / boolean / array / null) matches. A shape left over from another type (before
 * this policy, or from any legacy draft) can therefore never reach the Details step or the public
 * page, and nothing compatible is lost. Null for a type without a details tab.
 */
export function normalizeTypeDetails(eventType: string | null, eventSubtype: string | null, typeDetails: unknown): Rec | null {
  const tab = getTab6Config(eventType, eventSubtype)
  if (!tab) return null
  const blank = makeBlankTypeDetails(tab.sectionType) as unknown as Rec
  const stored = rec(typeDetails)
  const out: Rec = { ...blank }
  for (const k of Object.keys(blank)) {
    if (!(k in stored)) continue
    const want = kind(blank[k]), have = kind(stored[k])
    // `null` defaults (numbers not set yet) accept a number; everything else must match exactly.
    if (have === want || (want === 'null' && (have === 'number' || have === 'string'))) out[k] = stored[k]
  }
  return out
}
