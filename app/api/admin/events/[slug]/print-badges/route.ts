// /api/admin/events/[slug]/print-badges — RD-PRINT-BILL-P2 · Super Admin, per event.
//
// Lives under [slug] (read as eventId; event ids ARE slugs) beside the capacity `commercial` route —
// a sibling [eventId] at this level takes the whole dev server down.
//
//   GET  → the GLOBAL badge terms, this event's stored OVERRIDE (or why it is unreadable), the
//          EFFECTIVE terms with the source of each value, and the release state.
//   POST → set or clear the event's override (`events/{slug}.printBadgeCommercial`). A PATCH:
//          a value sets a field, null removes it (inherit), absent keeps it; { clear: true }
//          removes the whole override. Reason (3–500 characters) required.
//
// Writes ONE field on the event and two audit rows (licenseHistory + adminAuditLogs) in ONE
// transaction — all land or none do. It never touches an order, a unit or a payment: nothing in
// Print & Assets charges yet (paid generation and badge purchases are unreleased in code), and
// when it does, a job snapshots the terms it was confirmed under, so a later change here can
// never re-price it.
//
// Security: Super Admin only (ADMIN_UIDS via requireSuperAdmin). A legacy `admin: true` claim
// alone gets 403 SUPER_ADMIN_REQUIRED. The override and its history never leave admin endpoints:
// public event APIs and pages project explicit fields (see tests/unit/printBadgeBillingP2.test.ts).

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import type { AdminAuditLog } from '@/lib/admin/auditConstants'
import { LICENSE_HISTORY_COLLECTION, type LicenseHistoryDoc } from '@/lib/licensing/schema'
import { defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'
import {
  EVENT_PRINT_BADGE_FIELD, PAID_BADGE_GENERATION_RELEASED, PRINT_BADGE_CHARGEABLE_ASSET_TYPES,
  BADGE_OVERRIDE_PRICE_MIN_PAISE, BADGE_OVERRIDE_PRICE_MAX_PAISE,
  readStoredPrintBadgeOverride, parsePrintBadgeOverridePatch, applyPrintBadgeOverridePatch,
  changedPrintBadgeOverrideFields, isFreeOrComplimentarySetting, resolveEffectivePrintBadgeTerms,
  type PrintBadgeCommercialOverride, type PrintBadgeOverridePatch, type EffectivePrintBadgeTerms,
} from '@/lib/licensing/printBadgeCommercial'
import { getGlobalPrintBadgeTerms } from '@/lib/licensing/printBadgeTermsServer'
import { readPrintBadgePilot } from '@/lib/licensing/printBadgePilotServer'
import { isPilotOrganizer, withPilotMembership, type PrintBadgePilotRead } from '@/lib/licensing/printBadgePilot'

export const dynamic = 'force-dynamic'

/**
 * RD-PRINT-P8 (W5) — the effective terms as generation applies them: an organizer outside the paid
 * ID-badge pilot is free whatever the global switch and override say. An unreadable pilot setting ⇒
 * null (shown as unavailable), never a guess.
 */
function pilotEffective(terms: EffectivePrintBadgeTerms | null, pilot: PrintBadgePilotRead, organizerUid: unknown): EffectivePrintBadgeTerms | null {
  if (!terms || !pilot.ok) return null
  return withPilotMembership(terms, isPilotOrganizer(pilot, organizerUid))
}
const pilotStatusOf = (pilot: PrintBadgePilotRead, organizerUid: unknown) =>
  pilot.ok ? { ok: true as const, member: isPilotOrganizer(pilot, organizerUid) } : { ok: false as const, reason: pilot.reason }
const NO_STORE = { 'Cache-Control': 'no-store' }
const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response

  const { slug: eventId } = await params
  const [evSnap, global, pilot] = await Promise.all([adminDb.collection('events').doc(eventId).get(), getGlobalPrintBadgeTerms(), readPrintBadgePilot()])
  if (!evSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  const ev = evSnap.data() as Record<string, unknown>
  const storedRaw = ev[EVENT_PRINT_BADGE_FIELD] ?? null
  const stored = readStoredPrintBadgeOverride(storedRaw)

  return NextResponse.json({
    eventId,
    organizerUid: typeof ev.uid === 'string' ? ev.uid : null,
    // The layers, reported separately and labelled, so "inherits the global price" is never
    // confused with "set to the same price on this event".
    global:         global.ok ? global.terms : null,
    globalStatus:   global.ok ? { ok: true, saleState: global.saleState } : { ok: false, reason: global.reason },
    eventOverride:  stored.ok ? stored.override : null,
    // RD-PRINT-BILL-P2.1 — an unreadable override is shown as a bounded JSON preview of THIS field
    // only (never the rest of the event document); the client renders it as text, read-only.
    overrideStatus: stored.ok ? { ok: true } : { ok: false, errors: stored.errors, ...rawPreview(storedRaw) },
    effective:      pilotEffective(global.ok ? resolveEffectivePrintBadgeTerms(global.terms, storedRaw) : null, pilot, ev.uid),
    pilot:          pilotStatusOf(pilot, ev.uid),
    released:       { purchase: RELEASED_FOR_PURCHASE.print_badges, paidGeneration: PAID_BADGE_GENERATION_RELEASED },
    chargeableAssetTypes: PRINT_BADGE_CHARGEABLE_ASSET_TYPES,
    priceBoundsPaise: { min: BADGE_OVERRIDE_PRICE_MIN_PAISE, max: BADGE_OVERRIDE_PRICE_MAX_PAISE },
    canEdit:        true,   // the caller is a verified Super Admin (above); the POST re-checks.
  }, { headers: NO_STORE })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const adminUid = gate.uid

  const { slug: eventId } = await params
  let body: { override?: unknown; clear?: unknown; reason?: unknown; replaceUnreadable?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE }) }

  // A reason (3–500 characters) is mandatory: an unexplained change to what an organizer pays —
  // or a free / complimentary grant — is not auditable, whatever else is recorded.
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)

  // Parse the request before any read.
  const clearAll = body.clear === true
  let patch: PrintBadgeOverridePatch = {}
  if (!clearAll) {
    const parsed = parsePrintBadgeOverridePatch(body.override)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422, headers: NO_STORE })
    patch = parsed.patch
  }

  // ONE transaction: fresh read → apply → validate the RESULT → write + both audit rows.
  const evRef = adminDb.collection('events').doc(eventId)
  type Outcome =
    | { kind: 'not_found' }
    | { kind: 'unreadable'; errors: string[] }
    | { kind: 'unchanged'; after: PrintBadgeCommercialOverride | null; organizerUid: unknown }
    | { kind: 'ok'; after: PrintBadgeCommercialOverride | null; changedFields: string[]; organizerUid: unknown }
  const outcome = await adminDb.runTransaction<Outcome>(async txn => {
    const snap = await txn.get(evRef)
    if (!snap.exists) return { kind: 'not_found' }
    const ev = snap.data() as Record<string, unknown>
    const storedRaw = ev[EVENT_PRINT_BADGE_FIELD]
    const stored = readStoredPrintBadgeOverride(storedRaw)
    // RD-PRINT-BILL-P2.1 — an unreadable stored override is never replaced by accident: a save
    // must say so explicitly (`replaceUnreadable: true`, sent only after the admin confirms);
    // `clear: true` is itself the explicit "Clear corrupt override" action. Nothing is written.
    if (!stored.ok && !clearAll && body.replaceUnreadable !== true) return { kind: 'unreadable', errors: stored.errors }
    // An unreadable stored override is REPLACED by the request's result (it cannot be merged
    // into); its raw value is kept in the audit rows as the "before".
    const base = stored.ok ? stored.override : null
    const after = applyPrintBadgeOverridePatch(base, patch, clearAll)
    const changedFields = changedPrintBadgeOverrideFields(base, after)
    // A retry of the SAME change is a no-op: nothing written, no duplicate audit row.
    if (stored.ok && changedFields.length === 0) return { kind: 'unchanged', after, organizerUid: ev.uid }

    txn.update(evRef, {
      [EVENT_PRINT_BADGE_FIELD]: after ?? FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    stagePrintBadgeAudit(txn, {
      eventId, organizerUid: typeof ev.uid === 'string' ? ev.uid : '', adminUid, reason: reason.reason,
      before: stored.ok ? base : { unreadable: storedRaw ?? null }, after,
      changedFields: stored.ok ? changedFields : [...changedFields, '(replaced unreadable override)'],
    })
    return { kind: 'ok', after, changedFields, organizerUid: ev.uid }
  })

  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  if (outcome.kind === 'unreadable') {
    return NextResponse.json({
      error: 'This event’s stored badge override is unreadable. Confirm that you want to replace it, or clear it first.',
      code: 'OVERRIDE_UNREADABLE', details: outcome.errors,
    }, { status: 409, headers: NO_STORE })
  }
  const [global, pilot] = await Promise.all([getGlobalPrintBadgeTerms(), readPrintBadgePilot()])
  const effective: EffectivePrintBadgeTerms | null = pilotEffective(global.ok ? resolveEffectivePrintBadgeTerms(global.terms, outcome.after) : null, pilot, outcome.organizerUid)
  return NextResponse.json({
    ok: true, eventOverride: outcome.after, effective, pilot: pilotStatusOf(pilot, outcome.organizerUid),
    ...(clearAll ? { cleared: true } : {}),
    ...(outcome.kind === 'unchanged' ? { unchanged: true } : { changedFields: outcome.changedFields }),
  }, { headers: NO_STORE })
}

/**
 * BOTH audit rows — the per-licence history AND the platform audit log — staged in the SAME
 * transaction as the event write. Append-only; the audit id derives from the history id (one
 * logical change ↔ one platform row). A change that makes badges free or complimentary for the
 * event is flagged as such.
 */
function stagePrintBadgeAudit(
  txn: FirebaseFirestore.Transaction,
  a: {
    eventId: string; organizerUid: string; adminUid: string; reason: string
    before: unknown; after: PrintBadgeCommercialOverride | null; changedFields: string[]
  },
): void {
  const histRef  = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
  const auditRef = adminDb.collection('adminAuditLogs').doc(`print_badge_${histRef.id}`)
  const freeOrComplimentary = isFreeOrComplimentarySetting(a.after)
  const history: LicenseHistoryDoc = {
    id:           histRef.id,
    eventId:      a.eventId,
    organizerUid: a.organizerUid,
    action:       'print_badge_override',
    fromTier:     null,
    toTier:       defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),
    source:       'admin',
    orderId:      null,
    actorUid:     a.adminUid,
    note:         a.after === null
      ? 'Print badge override cleared — the event follows the global badge settings.'
      : `Print badge override set: ${a.changedFields.join(', ')}${freeOrComplimentary ? ' (badges free/complimentary for this event)' : ''}`,
    reason:       a.reason,
    before:       a.before,
    after:        a.after,
    createdAt:    now(),
  }
  const audit: AdminAuditLog = {
    adminUid: a.adminUid, action: a.after === null ? 'print_badge_commercial.cleared' : 'print_badge_commercial.set',
    entityType: 'event', entityId: a.eventId,
    metadata: {
      reason: a.reason, before: a.before ?? null, after: a.after, changedFields: a.changedFields,
      freeOrComplimentary, licenseHistoryId: histRef.id,
    },
    createdAt: FieldValue.serverTimestamp(),
  }
  txn.set(histRef, history)
  txn.set(auditRef, audit)
}

/** RD-PRINT-BILL-P2.1 — a bounded JSON preview of the unreadable override field (read-only display). */
const RAW_PREVIEW_MAX = 2000
function rawPreview(raw: unknown): { rawPreview: string; rawTruncated: boolean } {
  let text: string
  try { text = JSON.stringify(raw, null, 2) ?? String(raw) } catch { text = '[unserialisable value]' }
  return text.length > RAW_PREVIEW_MAX
    ? { rawPreview: `${text.slice(0, RAW_PREVIEW_MAX)}…`, rawTruncated: true }
    : { rawPreview: text, rawTruncated: false }
}
