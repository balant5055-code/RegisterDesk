// /api/admin/events/[slug]/commercial — RD-CAPACITY-01 · Super Admin, per event.
//
// Lives under [slug] (read as eventId below; event ids ARE slugs): Next.js refuses two
// different param names at one level, and a sibling [eventId] beside the existing
// [slug] routes took the whole dev server down. Same URL either way.
//
//   GET  → the GLOBAL defaults, this event's stored OVERRIDE, the EFFECTIVE terms that
//          result, the capacity currently enforced, and every capacity payment it has made
//   POST → set or clear the event's override. Validated, audited, reason required.
//
// ═══ THE RULE THIS ROUTE IS BUILT AROUND ═════════════════════════════════════
// It writes ONE field: `events/{eventId}.commercial`. It does not touch a single order, a
// single amount, or the enforced capacity. That is not a limitation — it is the guarantee.
// An admin changing an event's rate changes what its NEXT capacity change will cost; it can
// never alter what a completed payment charged, because every paid order carries its own
// immutable snapshot of the terms it was charged under and nothing here can reach it.
//
// Changing the terms also deliberately does NOT re-price or re-issue any order that is
// already `created` and awaiting payment: that order is bound to a Razorpay order for a
// specific amount, and moving the price underneath it would unbind the captured payment.
// Such an order is either paid at its own price or abandoned.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import type { AdminAuditLog } from '@/lib/admin/auditConstants'
import {
  LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION, EVENT_LICENSES_COLLECTION,
  isCapacityChangePurpose, type LicenseHistoryDoc, type LicenseOrderDoc,
} from '@/lib/licensing/schema'
import {
  COMMERCIAL_TERM_KEYS, validateCommercialTerms, normalizeCommercialTerms,
  type CommercialTerms,
} from '@/lib/licensing/capacityCommercial'
import { resolveGlobalCommercialTerms, resolveEventCommercialTerms, EVENT_COMMERCIAL_FIELD } from '@/lib/licensing/resolveCommercialTerms'
import { currentCapacityFromEvent } from '@/lib/licensing/capacityChange'
import { readServiceAllowances, viewOf } from '@/lib/licensing/serviceAllowanceLedger'
import { defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'

export const dynamic = 'force-dynamic'

const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

/** Every capacity payment this event has made, newest first. Read-only, always. */
async function capacityPaymentHistory(eventId: string, draftId: string | null) {
  // RD-EVENT-COMMERCE-02 — the activation order and any pre-publish add-on orders are keyed by
  // the DRAFT id, capacity changes by the live slug. Both are read so the history is complete.
  const ids = [...new Set([eventId, draftId].filter((x): x is string => typeof x === 'string' && x.length > 0))]
  const snaps = await Promise.all(ids.map(id => adminDb.collection(LICENSE_ORDERS_COLLECTION).where('eventId', '==', id).get()))
  const seen = new Set<string>()
  return snaps.flatMap(sn => sn.docs)
    .filter(d => (seen.has(d.id) ? false : (seen.add(d.id), true)))
    .map(d => d.data() as LicenseOrderDoc)
    .filter(o => o.commercialModel === 'capacity')
    .map(o => ({
      orderId:   o.orderId,
      purpose:   o.purpose,
      status:    o.status,
      // The amount AS CHARGED, and the terms it was charged under. Reported from the order's
      // own snapshot, never recomputed — recomputing is exactly how a historical figure
      // starts drifting with configuration.
      amountPaise:     o.amountPaise,
      isCapacityChange: isCapacityChangePurpose(o.purpose),
      charge:    o.capacityChange ?? null,
      // RD-EVENT-COMMERCE-02 — prepaid service lines (qty, unit price, base, GST, total) and
      // the exact selection the order was created for.
      serviceItems:       o.serviceItems ?? [],
      servicesTotalPaise: o.servicesTotalPaise ?? 0,
      selection:          o.selection ?? null,
      couponCode:         o.couponCode ?? null,
      discountPaise:      o.discountPaise ?? 0,
      paidAt:    o.paidAt ?? null,
      createdAt: o.createdAt ?? null,
      razorpayOrderId:   o.razorpayOrderId ?? null,
      razorpayPaymentId: o.razorpayPaymentId ?? null,
    }))
    .sort((a, b) => {
      const at = (a.createdAt as { toMillis?(): number } | null)?.toMillis?.() ?? 0
      const bt = (b.createdAt as { toMillis?(): number } | null)?.toMillis?.() ?? 0
      return bt - at
    })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const { slug: eventId } = await params
  const [evSnap, licSnap, global, superUid] = await Promise.all([
    adminDb.collection('events').doc(eventId).get(),
    adminDb.collection(EVENT_LICENSES_COLLECTION).doc(eventId).get(),
    resolveGlobalCommercialTerms(),
    resolveSuperAdminUid(req.headers.get('authorization')),
  ])
  if (!evSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  // RD-EVENT-COMMERCE-04A — a corrupt global group is REPORTED, not dressed up as defaults.
  const globalTerms = global.ok ? global.terms : null

  const ev  = evSnap.data() as Record<string, unknown>
  const lic = licSnap.exists ? licSnap.data() as Record<string, unknown> : null
  const storedOverride = ev[EVENT_COMMERCIAL_FIELD] ?? null

  return NextResponse.json({
    eventId,
    organizerUid: (ev.uid as string | undefined) ?? null,
    // The three layers, reported SEPARATELY and labelled, because an admin has to be able to
    // tell "this event is on the platform default" from "someone set this event to ₹0.50" —
    // a single merged blob makes an override invisible.
    globalDefaults: globalTerms,
    globalStatus:   global.ok ? { ok: true } : { ok: false, reason: global.reason, errors: global.errors },
    eventOverride:  storedOverride,
    effective:      globalTerms ? resolveEventCommercialTerms(storedOverride, globalTerms) : null,
    hasOverride:    storedOverride !== null && typeof storedOverride === 'object',
    // Server-decided from the verified token; the POST re-checks.
    canEdit:        superUid !== null,

    capacity: {
      // The value that is actually ENFORCED at registration time.
      enforced:  currentCapacityFromEvent(ev),
      // What the licence RECORDS was bought, and the pricing of the first activation.
      onLicense: (lic?.capacity as number | null | undefined) ?? null,
      activation: lic?.activation ?? null,
      changeCount: (lic?.capacityOpSeq as number | undefined) ?? 0,
      commercialModel: (lic?.commercialModel as string | undefined) ?? null,
    },

    payments: await capacityPaymentHistory(eventId, typeof ev.draftId === 'string' ? ev.draftId : null),
    // RD-EVENT-COMMERCE-02 — the event's prepaid service allowances (purchased / consumed /
    // remaining), from the allowance ledger. Read-only.
    serviceAllowances: typeof ev.draftId === 'string' ? viewOf(await readServiceAllowances(ev.draftId)) : null,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  // RD-EVENT-COMMERCE-04A — per-event pricing is a Super Admin action (ADMIN_UIDS), the same
  // mechanism that guards refunds and credit grants. Decided from the verified token only.
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) {
    const isAdmin = await resolveAdminUid(req.headers.get('authorization'))
    return NextResponse.json(isAdmin
      ? { error: 'Only a Super Admin can change an event’s commercial terms.', code: 'SUPER_ADMIN_REQUIRED' }
      : { error: 'Forbidden' }, { status: 403 })
  }

  const { slug: eventId } = await params

  let body: { terms?: unknown; clear?: unknown; reason?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  // A reason is mandatory, matching every other mutating admin action on a licence. An
  // unexplained change to what an organizer pays is not auditable, whatever else is recorded.
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return NextResponse.json({ error: 'A reason is required for this action' }, { status: 400 })

  // ── Parse the request (before any read) ────────────────────────────────────
  // RD-PHASE4-S3 · Step 6 — a change is a PATCH over the stored override:
  //   number → set that term for this event;  null → REMOVE that term (the event inherits global);
  //   absent → leave it as stored;             { clear: true } → remove the whole override.
  const clearAll = body.clear === true
  const patch: Partial<Record<keyof CommercialTerms, number | null>> = {}
  if (!clearAll) {
    if (typeof body.terms !== 'object' || body.terms === null || Array.isArray(body.terms)) {
      return NextResponse.json({ error: 'terms must be an object, or pass clear: true' }, { status: 400 })
    }
    // Only the six known keys are accepted, so an admin payload cannot smuggle an unrelated
    // field onto the event document.
    const raw = body.terms as Record<string, unknown>
    const badType: string[] = []
    for (const key of COMMERCIAL_TERM_KEYS) {
      const v = raw[key]
      if (v === undefined) continue
      if (v === null || typeof v === 'number') patch[key] = v
      else badType.push(key)
    }
    if (badType.length > 0) return NextResponse.json({ error: `Invalid value for: ${badType.join(', ')}` }, { status: 422 })
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No recognised commercial terms were supplied' }, { status: 400 })
    }
  }

  // RD-EVENT-COMMERCE-04A — an override is validated AGAINST the global terms; if those are
  // corrupt there is nothing sound to validate against, so refuse and say what to fix.
  const global = await resolveGlobalCommercialTerms()
  if (!global.ok) {
    return NextResponse.json({
      error: 'Global capacity pricing is invalid or unreadable. Correct it in Business Configuration before changing an event’s terms.',
      code: global.reason, details: global.errors,
    }, { status: 409 })
  }
  const globalTerms = global.terms

  // ── ONE transaction: fresh read → merge → validate the MERGED result → write + both audit rows ──
  // RD-PHASE4-S3 · Step 6/8. The stored override is read INSIDE the transaction, so a concurrent change
  // is merged, never silently overwritten (the loser re-runs on the winner's result). What is
  // validated is exactly what will be stored, and the stored map is REPLACED (not deep-merged), so a
  // single term can be removed. The audit records the persisted before/after, the changed terms, the
  // actor and the reason, in the same transaction — a failed audit write commits nothing.
  const evRef = adminDb.collection('events').doc(eventId)
  type Outcome =
    | { kind: 'not_found' }
    | { kind: 'invalid'; error: string }
    | { kind: 'unchanged'; effective: CommercialTerms; after: Record<string, number> | null }
    | { kind: 'ok'; effective: CommercialTerms; after: Record<string, number> | null; changedFields: string[] }
  const outcome = await adminDb.runTransaction<Outcome>(async txn => {
    const snap = await txn.get(evRef)
    if (!snap.exists) return { kind: 'not_found' }
    const ev = snap.data() as Record<string, unknown>
    const storedRaw = ev[EVENT_COMMERCIAL_FIELD]
    const stored: Record<string, number> = {}
    if (storedRaw && typeof storedRaw === 'object' && !Array.isArray(storedRaw)) {
      for (const k of COMMERCIAL_TERM_KEYS) {
        const v = (storedRaw as Record<string, unknown>)[k]
        if (typeof v === 'number') stored[k] = v
      }
    }
    const next: Record<string, number> = clearAll ? {} : { ...stored }
    if (!clearAll) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k]
        else if (v !== undefined) next[k] = v
      }
    }

    // The override is a PARTIAL, but the RESULT of applying it must be completely valid — an
    // override that produces a NaN rate would break every future quote for this event.
    const effective = normalizeCommercialTerms(next, globalTerms)
    const errors = validateCommercialTerms(effective, 'commercial')
    if (errors.length > 0) return { kind: 'invalid', error: errors.join('; ') }
    // A stored term the reader would silently DROP (invalid alone or in combination) is refused,
    // naming the term, instead of leaving the admin thinking it applies.
    const rejected = Object.keys(next).filter(k => effective[k as keyof CommercialTerms] !== next[k])
    if (rejected.length > 0) return { kind: 'invalid', error: `Invalid value for: ${rejected.join(', ')}` }

    const after = Object.keys(next).length > 0 ? next : null
    const changedFields = COMMERCIAL_TERM_KEYS.filter(k => stored[k] !== after?.[k])
    // A retry of the SAME change is a no-op: nothing to write, so no duplicate audit row.
    if (changedFields.length === 0) return { kind: 'unchanged', effective, after }

    txn.update(evRef, {
      [EVENT_COMMERCIAL_FIELD]: after ?? FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    const beforeOut = Object.keys(stored).length > 0 ? stored : null
    stageCommercialAudit(txn, {
      eventId, organizerUid: typeof ev.uid === 'string' ? ev.uid : '', adminUid, reason,
      before: beforeOut, after, changedFields,
      note: after === null
        ? 'Commercial override cleared — the event follows the global defaults.'
        : `Commercial override set: ${changedFields.map(k => `${k}=${after[k] === undefined ? '(inherit)' : String(after[k])}`).join(', ')}`,
    })
    return { kind: 'ok', effective, after, changedFields }
  })

  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  if (outcome.kind === 'invalid') return NextResponse.json({ error: outcome.error }, { status: 422 })
  const headers = { 'Cache-Control': 'no-store' }
  if (clearAll) {
    return NextResponse.json({ ok: true, cleared: true, ...(outcome.kind === 'unchanged' ? { unchanged: true } : {}), effective: outcome.effective }, { headers })
  }
  return NextResponse.json({
    ok: true, eventOverride: outcome.after, effective: outcome.effective,
    ...(outcome.kind === 'unchanged' ? { unchanged: true } : { changedFields: outcome.changedFields }),
  }, { headers })
}

/**
 * RD-EVENT-COMMERCE-04A / RD-PHASE4-S3 — BOTH audit rows (the per-licence history AND the platform
 * audit log), staged in the SAME transaction as the event write: either all three land or none do.
 * APPEND-ONLY: every committed change adds new rows carrying the PERSISTED before/after, the changed
 * terms, the reason and the actor (server timestamps).
 */
function stageCommercialAudit(
  txn: FirebaseFirestore.Transaction,
  a: {
    eventId: string; organizerUid: string; adminUid: string; reason: string
    before: Record<string, number> | null; after: Record<string, number> | null; changedFields: string[]; note: string
  },
): void {
  const histRef  = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
  // Derived from the history id: one logical change ↔ one platform audit row.
  const auditRef = adminDb.collection('adminAuditLogs').doc(`commercial_${histRef.id}`)
  const history: LicenseHistoryDoc = {
    id:           histRef.id,
    eventId:      a.eventId,
    organizerUid: a.organizerUid,
    action:       'commercial_terms_override',
    fromTier:     null,
    toTier:       defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),
    source:       'admin',
    orderId:      null,
    actorUid:     a.adminUid,
    note:         a.note,
    reason:       a.reason,
    before:       a.before,
    after:        a.after,
    createdAt:    now(),
  }
  const audit: AdminAuditLog = {
    adminUid: a.adminUid, action: a.after === null ? 'commercial_terms.cleared' : 'commercial_terms.set',
    entityType: 'event', entityId: a.eventId,
    metadata: { reason: a.reason, before: a.before, after: a.after, changedFields: a.changedFields, licenseHistoryId: histRef.id },
    createdAt: FieldValue.serverTimestamp(),
  }
  txn.set(histRef, history)
  txn.set(auditRef, audit)
}
