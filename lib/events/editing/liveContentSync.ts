// PURE. The ONE rule for copying an event draft's CONTENT onto its live events/{slug}
// document: which fields move, which must not change, and what a copy may never introduce.
//
// Extracted VERBATIM from POST /api/organizer/events/[eventId]/save-changes (RD-PRICING-SAFETY-01,
// RD-CE-FIX H1/H5, RD-EVENT-COMMERCE-05E), which keeps using it for a published event's
// "Save Changes". The lifecycle transitions that send an event BACK TO REVIEW — resubmit (after
// a rejection / request for changes) and republish (after an unpublish) — now use it too.
//
// ═══ WHY RESUBMIT / REPUBLISH NEED IT ════════════════════════════════════════
// Content only ever reached events/{slug} while the draft was `published` (save-changes, PATCH
// /edit). Resubmit and republish were lifecycle flips, and approval is a lifecycle flip, so the
// corrections an organizer made after "changes requested" stayed in the draft: the Super Admin
// reviewed — and approval published — the snapshot from the FIRST submission. Copying at the
// moment the event re-enters review makes the live document the reviewable snapshot: what the
// admin previews is what approval publishes, and nothing written to the draft afterwards can
// reach the public page without another review (approve copies nothing).
//
// What moves: eventDetails (with the slug pinned to the live document's id), pricing (with the
// live fee model preserved), registrationForm, accessControl. Nothing else — never lifecycle,
// review, audit, ownership, licence, capacity or payment fields.

import { findCommercialPricingChanges } from '@/lib/events/editing/pricingIntegrity'
import { introducedValueIssues } from '@/lib/events/eventValueRules'
import { galleryChangeProblem, galleryOf } from '@/lib/events/galleryLimits'
import { normalizeTypeDetails, passesForType } from '@/lib/events/builder/typeTransition'

export type LiveContentSync =
  | {
      ok:      true
      /** Exactly the fields to write onto events/{slug}. */
      update:  { eventDetails: Record<string, unknown> | null; pricing: Record<string, unknown> | null; registrationForm: unknown; accessControl: unknown }
      /** Schedule / venue fields that changed — the change-log entry, as save-changes writes it. */
      changed: string[]
    }
  | { ok: false; status: number; message: string }

/**
 * @param dn         the draft being copied (re-read inside the caller's transaction)
 * @param live       the live events/{slug} document (re-read inside the caller's transaction)
 * @param slug       the live document's id — the slug the copy is pinned to
 * @param passCounts the per-pass sold counter (registrationCounters/{slug}.passCounts)
 */
export function buildLiveContentSync(
  dn:         Record<string, unknown>,
  live:       Record<string, unknown>,
  slug:       string,
  passCounts: Record<string, number>,
): LiveContentSync {
  // ── Commercial pricing is frozen after publish (RD-PRICING-SAFETY-01) ──
  const commercial = findCommercialPricingChanges(live.pricing, dn.pricing, { ignoreFeeModel: true })
  if (commercial.length > 0) {
    return {
      ok: false, status: 409,
      message: `Ticket prices and free/paid settings can’t be changed on a published event. ` +
        `Changed: ${commercial.join('; ')}. Undo these changes to save your other edits.`,
    }
  }

  // ── RD-CE-FIX H5 · identity is frozen after publish ──────────────
  // The copy pushes whole content blocks, so it enforces the identity keys PATCH /edit lists as
  // RESTRICTED (eventType/eventSubtype/campaignType, registrationMode, currency). The draft API
  // and firestore.rules already refuse these on a submitted draft; this catches a draft that
  // drifted before that lock existed, so it can never re-type the live event.
  const strOf = (v: unknown) => (typeof v === 'string' ? v : null)
  const regMode = (x: Record<string, unknown>) =>
    strOf(((x.registrationForm as Record<string, unknown> | null)?.registrationRules as Record<string, unknown> | null)?.registrationMode)
  const currencyOf = (x: Record<string, unknown>) => strOf((x.pricing as Record<string, unknown> | null)?.currency)
  // Only identity the LIVE document records is compared: a legacy live doc without a value has
  // nothing to drift from, and an unknown must never block an ordinary content save.
  const differs = (a: string | null, b: string | null) => b !== null && a !== b
  const identityDrift = [
    ...(['eventType', 'eventSubtype', 'campaignType'] as const).filter(k => differs(strOf(dn[k]), strOf(live[k]))),
    ...(differs(regMode(dn), regMode(live)) ? ['registrationMode'] : []),
    ...(differs(currencyOf(dn), currencyOf(live)) ? ['currency'] : []),
  ]
  if (identityDrift.length > 0) {
    return {
      ok: false, status: 409,
      message: `These settings can’t be changed on a published event: ${identityDrift.join(', ')}. ` +
        `Duplicate the event to publish it with different settings.`,
    }
  }

  // ── RD-CE-FIX H1 · the VALUES pushed must pass the server's rules ─
  // Only issues this copy introduces (vs the live event) are refused, so a legacy event with an
  // old inconsistency can still be edited — but no copy can make it invalid.
  // RD-WAIVER-01 · eventType lets the sports-waiver rule run on edits too (switching the waiver on
  // with no wording is refused). The type is identity — frozen after publish — so the live one.
  const introduced = introducedValueIssues(
    { eventDetails: live.eventDetails, pricing: live.pricing, eventType: live.eventType },
    { eventDetails: dn.eventDetails, pricing: dn.pricing, eventType: live.eventType },
  )
  if (introduced.length > 0) return { ok: false, status: 422, message: introduced.map(i => i.message).join(' ') }

  // ── RD-GALLERY-01 · gallery limits (6 uploaded / 20 URL), growth-only vs the live event ──
  // Resubmit / republish copy the whole draft gallery; a draft written directly by the browser
  // cannot use the copy to grow the live gallery past its limits.
  const gallery = galleryChangeProblem(galleryOf(live.eventDetails), galleryOf(dn.eventDetails))
  if (gallery) return { ok: false, status: 422, message: gallery }

  // ── Pricing integrity guard (parity with PATCH /edit) ─────────────
  // /edit blocks lowering a pass capacity below its sold count on a published event. The copy
  // pushes the whole draft.pricing, so it enforces the identical invariant against the
  // authoritative per-pass sold counter.
  const draftPasses = Array.isArray((dn.pricing as Record<string, unknown> | null)?.passes)
    ? ((dn.pricing as Record<string, unknown>).passes as Record<string, unknown>[])
    : []
  for (const pass of draftPasses) {
    const pid  = typeof pass.id === 'string' ? pass.id : ''
    const sold = passCounts[pid] ?? 0
    const qty  = pass.unlimited === true ? null : (typeof pass.quantity === 'number' ? pass.quantity : null)
    if (qty !== null && qty < sold) {
      return {
        ok: false, status: 400,
        message: `Pass "${typeof pass.name === 'string' ? pass.name : pid}" capacity (${qty}) cannot be less than its sold count (${sold}).`,
      }
    }
  }

  // ── Change-log fields (schedule + venue) ─────────────────────────
  const details     = (dn.eventDetails as Record<string, unknown>) ?? {}
  const liveSched   = ((live.eventDetails as Record<string, unknown>)?.schedule   as Record<string, unknown>) ?? {}
  const liveVenue   = ((live.eventDetails as Record<string, unknown>)?.venue      as Record<string, unknown>) ?? {}
  const livePhys    = (liveVenue.physical as Record<string, unknown>) ?? {}
  const liveOnline  = (liveVenue.online   as Record<string, unknown>) ?? {}
  const draftSched  = (details.schedule   as Record<string, unknown>) ?? {}
  const draftVenue  = (details.venue      as Record<string, unknown>) ?? {}
  const draftPhys   = (draftVenue.physical as Record<string, unknown>) ?? {}
  const draftOnline = (draftVenue.online   as Record<string, unknown>) ?? {}

  const changed: string[] = []
  const checkField = (key: string, draftVal: unknown, liveVal: unknown) => {
    const a = typeof draftVal === 'string' ? draftVal.trim() : draftVal
    const b = typeof liveVal  === 'string' ? liveVal.trim()  : liveVal
    if (a !== b) changed.push(key)
  }
  checkField('startDate',      draftSched.startDate,    liveSched.startDate)
  checkField('startTime',      draftSched.startTime,    liveSched.startTime)
  checkField('endDate',        draftSched.endDate,      liveSched.endDate)
  checkField('endTime',        draftSched.endTime,      liveSched.endTime)
  checkField('venueType',      draftVenue.type,         liveVenue.type)
  checkField('venueName',      draftPhys.name,          livePhys.name)
  checkField('venueCity',      draftPhys.city,          livePhys.city)
  checkField('venueAddress',   draftPhys.addressLine1,  livePhys.addressLine1)
  checkField('onlinePlatform', draftOnline.platform,    liveOnline.platform)
  checkField('onlineMeetingUrl', draftOnline.meetingUrl, liveOnline.meetingUrl)

  // ── The content fields ───────────────────────────────────────────
  // The public slug is IDENTITY, not content. `eventDetails` is pushed wholesale, so without
  // this the draft's `seo.urlSlug` would be copied onto the live document — and since the
  // document id can never change, that would leave the live page disagreeing with its own
  // address. Copying can change what the page says, never where it lives.
  //
  // The same type cleanup the FIRST submission applies (app/api/events/publish: normalizeTypeDetails
  // + passesForType): typeDetails in exactly this event type's shape, and race details only on a
  // type that has them. Without it a draft carrying another type's leftovers (e.g. an Awards
  // "judges" list) could reach the reviewed / live page through a later copy. The type is the
  // LIVE one — identity drift was refused above, so it equals the draft's when the live doc has it.
  const liveType    = strOf(live.eventType)    ?? strOf(dn.eventType)
  const liveSubtype = strOf(live.eventSubtype) ?? strOf(dn.eventSubtype)
  const draftEd = dn.eventDetails as Record<string, unknown> | null | undefined
  const liveDetails = draftEd
    ? { ...draftEd,
        typeDetails: normalizeTypeDetails(liveType, liveSubtype, draftEd.typeDetails),
        seo: { ...(draftEd.seo as Record<string, unknown> ?? {}), urlSlug: slug } }
    : null
  // RD-EVENT-COMMERCE-05E — the live fee model is preserved exactly (absent stays absent).
  const livePricing = (live.pricing ?? null) as Record<string, unknown> | null
  const draftPricing = (dn.pricing ?? null) as Record<string, unknown> | null
  let nextPricing: Record<string, unknown> | null = draftPricing
  if (draftPricing) {
    const { feeModel: _draftFeeModel, ...rest } = draftPricing
    void _draftFeeModel
    nextPricing = livePricing && 'feeModel' in livePricing ? { ...rest, feeModel: livePricing.feeModel } : rest
    nextPricing = { ...nextPricing, passes: passesForType(liveType, liveSubtype, nextPricing.passes) }
  }

  return {
    ok: true,
    update: {
      eventDetails:     liveDetails,
      pricing:          nextPricing,
      registrationForm: dn.registrationForm ?? null,
      accessControl:    dn.accessControl    ?? null,
    },
    changed,
  }
}
