// RD-CLOSE · WhatsApp ACCEPTANCE — the one place a provider-accepted message becomes billable.
//
// ═══ THE INVARIANT ════════════════════════════════════════════════════════════
//   one message Meta accepted (one wamid)
//     = one usage record   (communicationUsage/wa_msg_<wamid>, or the campaign's bc_<id> row)
//     = one financial charge (wallet ledger row, or one consumed prepaid unit)
//     = one communication log row carrying the wamid (emailLogs)
// Meta's acceptance is the billing event (product decision D3, 2026-10-05). Delivery, read and
// failed-after-accept change reporting only.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// Acceptance used to be persisted by best-effort writes AFTER the provider call (a `void`
// usage write, a `void` log write, a separate debit transaction, a sent-flag update). Any one
// failing — or the process dying between the provider call and the write — silently turned an
// accepted message into a free one (or, for a broadcast, into a refunded one).
//
// Now:
//   1. Every send carries `biz_opaque_callback_data` (see CALLBACK below). Meta echoes it on
//      every status webhook, and status webhooks exist only for ACCEPTED messages.
//   2. Acceptance is persisted by ONE transaction keyed by the wamid (all-or-nothing), retried
//      with backoff by the sender.
//   3. The webhook replays the SAME transaction from the callback data. A lost write, a crash,
//      or a send that timed out but was in fact accepted is recovered from Meta's own record.
//   4. A broadcast acceptance recovered AFTER the campaign was settled is charged back exactly
//      once (the recipient's `sent` flag, written in the same transaction, is the guard).
// Every function here is idempotent: replaying it any number of times, in any order relative
// to the webhook, produces exactly one charge, one usage record and one log row.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import type { OrganizerWallet } from '@/types/events'
import type { WriteEmailLogInput } from '@/lib/email-logs/types'
import {
  ledgerRef as serviceLedgerRef, ledgerLine, availableUnits, ALLOWANCE_USAGE_SUBCOLLECTION, draftIdForEventSlug, type ServiceLedgerDoc,
} from '@/lib/licensing/serviceAllowanceLedger'

export const WHATSAPP_BROADCAST_JOBS_COLLECTION = 'whatsappBroadcastJobs'

// ─── Callback data ─────────────────────────────────────────────────────────────
// Versioned, colon-separated, ids only (Firestore ids never contain ':'). ≤ 512 chars (Meta).
export type AcceptanceRef =
  | { kind: 'broadcast'; jobId: string; recipientId: string }
  | { kind: 'registration'; registrationId: string; unitKey?: string }
  | { kind: 'certificate'; certificateId: string; registrationId: string }

const SAFE = /^[A-Za-z0-9_.-]{1,160}$/

export function callbackDataFor(ref: AcceptanceRef): string {
  switch (ref.kind) {
    case 'broadcast':    return `rd1:bc:${ref.jobId}:${ref.recipientId}`
    case 'registration': return `rd1:reg:${ref.registrationId}${ref.unitKey ? `:${ref.unitKey}` : ''}`
    case 'certificate':  return `rd1:cert:${ref.certificateId}:${ref.registrationId}`
  }
}

export function parseCallbackData(raw: unknown): AcceptanceRef | null {
  if (typeof raw !== 'string' || raw.length > 512) return null
  const p = raw.split(':')
  if (p[0] !== 'rd1') return null
  if (p[1] === 'bc' && p.length === 4 && SAFE.test(p[2]) && SAFE.test(p[3])) return { kind: 'broadcast', jobId: p[2], recipientId: p[3] }
  if (p[1] === 'reg' && (p.length === 3 || p.length === 4) && SAFE.test(p[2]) && (p.length === 3 || SAFE.test(p[3]))) {
    return { kind: 'registration', registrationId: p[2], ...(p.length === 4 ? { unitKey: p[3] } : {}) }
  }
  if (p[1] === 'cert' && p.length === 4 && SAFE.test(p[2]) && SAFE.test(p[3])) return { kind: 'certificate', certificateId: p[2], registrationId: p[3] }
  return null
}

/** A wamid as a Firestore id segment (wamids are base64-ish; '/' is not allowed in ids). */
export const wamidKey = (wamid: string) => wamid.replace(/[/]/g, '_').slice(0, 400)
export const messageLogId   = (wamid: string) => `wa_${wamidKey(wamid)}`
export const messageUsageId = (wamid: string) => `wa_msg_${wamidKey(wamid)}`

/** Retries a persistence step with backoff (provider acceptance must not hinge on one write). */
export async function withPersistRetry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 150): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (err) {
      last = err
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseMs * 3 ** i))
    }
  }
  throw last
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// ═══ Transactional messages (registration confirmation, certificate) ════════════

export interface MessageAcceptanceInput {
  organizerUid: string
  eventSlug:    string
  eventName:    string
  wamid:        string
  templateKey:  'registration_confirmation' | 'certificate_ready'
  /** Wallet price for THIS message; 0 when a prepaid unit (or a free policy) covers it. */
  costPaise:    number
  /** The FIRST message's deterministic ledger id (legacy-compatible); later messages get `<base>__<wamid>`. */
  baseLedgerId: string
  ledgerReferenceId: string
  ledgerDescription: string
  ledgerMetadata:    Record<string, unknown>
  /** The log row to create for this message (written with id wa_<wamid>); null ⇒ the caller owns the log row. */
  log: WriteEmailLogInput | null
  /** Registration status to record (merged), when the message is a registration's confirmation. */
  registrationPatch?: { registrationId: string; patch: Record<string, unknown> }
  /**
   * The prepaid unit that covers this message (fromAllowance). Marked `acceptedWamid` in the same
   * transaction, so a sender whose request timed out can never release a unit Meta's webhook has
   * already proven accepted (releaseServiceUnits refuses a marked unit).
   */
  allowanceUnit?: { draftId: string; unitKey: string }
  /**
   * The row the sender wrote when Meta gave no verdict (timeout): it is UPGRADED to this accepted
   * message instead of a second row being created — one log row per message.
   */
  pendingLogId?: string
  source: 'send' | 'retry' | 'webhook'
}

/** Deterministic id of the "delivery unknown" log row a sender writes for an unanswered send. */
export const unknownLogId = (unitKey: string) => `waun_${unitKey}`.slice(0, 400)

export interface MessageAcceptanceResult { already: boolean; chargedPaise: number; chargeSkipped: boolean }

/**
 * Persists one accepted message atomically: charge (if any) + usage record + log row + status.
 * The usage record `wa_msg_<wamid>` is the idempotency guard: present ⇒ everything was already
 * written by an earlier attempt (or by the webhook), and nothing is written again.
 */
export async function recordMessageAcceptance(input: MessageAcceptanceInput): Promise<MessageAcceptanceResult> {
  const walletCfg = input.costPaise > 0 ? await getWalletConfig() : null
  const usageRef  = adminDb.collection('communicationUsage').doc(messageUsageId(input.wamid))
  const logRef    = adminDb.collection('emailLogs').doc(messageLogId(input.wamid))
  const baseRef   = adminDb.collection('walletTransactions').doc(input.baseLedgerId)
  const altRef    = adminDb.collection('walletTransactions').doc(`${input.baseLedgerId}__${wamidKey(input.wamid)}`)
  const walletRef = adminDb.doc(`organizerWallets/${input.organizerUid}`)
  const regRef    = input.registrationPatch ? adminDb.collection('registrations').doc(input.registrationPatch.registrationId) : null
  const unitRef   = input.allowanceUnit ? serviceLedgerRef(input.allowanceUnit.draftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION).doc(input.allowanceUnit.unitKey) : null
  const pendingRef = input.pendingLogId ? adminDb.collection('emailLogs').doc(input.pendingLogId) : null

  return adminDb.runTransaction<MessageAcceptanceResult>(async txn => {
    const [usageSnap, logSnap, baseSnap, altSnap, walletSnap, regSnap, unitSnap, pendingSnap] = await Promise.all([
      txn.get(usageRef), txn.get(logRef), txn.get(baseRef), txn.get(altRef),
      input.costPaise > 0 ? txn.get(walletRef) : Promise.resolve(null),
      regRef ? txn.get(regRef) : Promise.resolve(null),
      unitRef ? txn.get(unitRef) : Promise.resolve(null),
      pendingRef ? txn.get(pendingRef) : Promise.resolve(null),
    ])
    if (usageSnap.exists) return { already: true, chargedPaise: Number((usageSnap.data() as { costPaise?: number }).costPaise ?? 0), chargeSkipped: false }

    // ── charge (exactly once per wamid) ──
    let chargedPaise = 0, chargeSkipped = false
    if (input.costPaise > 0) {
      const base = baseSnap.exists ? baseSnap.data() as { metadata?: { messageId?: unknown } } : null
      // The base row covers the FIRST accepted message. A legacy base row (written before rows
      // recorded the wamid) is treated as covering an earlier message, never this one.
      const coveredByBase = !!base && base.metadata?.messageId === input.wamid
      const target = !base ? baseRef : coveredByBase ? null : altSnap.exists ? null : altRef
      if (target) {
        const balance = walletSnap?.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
        if (!walletCfg!.allowNegativeBalance && balance < input.costPaise) {
          // RD-PAY-GA-01B (unchanged rule): never drive the wallet negative. Recorded, not hidden.
          chargeSkipped = true
        } else {
          txn.set(walletRef, { balancePaise: FieldValue.increment(-input.costPaise), currency: 'INR', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          txn.set(target, {
            organizerUid: input.organizerUid, type: 'whatsapp_charge', amountPaise: input.costPaise,
            balancePaise: balance - input.costPaise, status: 'completed', referenceType: 'communication',
            referenceId: input.ledgerReferenceId, description: input.ledgerDescription,
            metadata: { ...input.ledgerMetadata, eventSlug: input.eventSlug, channel: 'whatsapp', units: 1, messageId: input.wamid },
            createdAt: FieldValue.serverTimestamp(),
          })
          chargedPaise = input.costPaise
        }
      }
    }

    // ── usage (the guard) ──
    txn.set(usageRef, clean({
      organizerUid: input.organizerUid, eventId: input.eventSlug, eventSlug: input.eventSlug, eventName: input.eventName,
      channel: 'whatsapp', quantity: 1, costPaise: chargedPaise, campaignId: '', templateKey: input.templateKey,
      providerMessageId: input.wamid, acceptedVia: input.source,
      ...(chargeSkipped ? { chargeSkipped: 'insufficient_balance' } : {}),
      createdAt: FieldValue.serverTimestamp(),
    }))

    // ── prepaid unit: this message consumed it — it can no longer be released ──
    if (unitRef && unitSnap?.exists) txn.set(unitRef, { acceptedWamid: input.wamid }, { merge: true })

    // ── log row: ONE per message. A "delivery unknown" row the sender wrote for this attempt is
    //    upgraded; otherwise the wa_<wamid> row is created if the original write was lost ──
    if (pendingRef && pendingSnap?.exists && !logSnap.exists) {
      txn.update(pendingRef, {
        status: 'sent', providerMessageId: input.wamid, costPaise: chargedPaise, deliveryUnknown: FieldValue.delete(),
        error: FieldValue.delete(), recoveredFrom: input.source, updatedAt: FieldValue.serverTimestamp(),
      })
    } else if (input.log && !logSnap.exists) {
      txn.set(logRef, clean({ ...input.log, status: 'sent', providerMessageId: input.wamid, costPaise: chargedPaise, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }))
    }

    // ── registration status (never downgrade an already-recorded send) ──
    if (regRef && regSnap?.exists) txn.set(regRef, input.registrationPatch!.patch, { merge: true })

    return { already: false, chargedPaise, chargeSkipped }
  })
}


// ═══ Broadcast recipients ═══════════════════════════════════════════════════════

export type BroadcastAcceptanceOutcome = 'recorded' | 'already' | 'late_charged' | 'late_unbilled' | 'missing'

interface CampaignBillingDoc {
  organizerUid?: string; billingSettledAt?: unknown; eventSlug?: string; eventId?: string; eventName?: string; channel?: string
  chargedUnits?: number; unitPricePaise?: number; billedUnits?: number; lateUnbilledUnits?: number
  fundedBy?: unknown; allowanceDraftId?: unknown; whatsappJobId?: unknown
}

/** The prepaid ledger a campaign was funded from: stamped at charge time, else resolved as the charge did. */
async function campaignAllowanceDraftId(c: CampaignBillingDoc): Promise<string | null> {
  if (c.fundedBy !== 'prepaid_allowance') return null
  if (typeof c.allowanceDraftId === 'string' && c.allowanceDraftId) return c.allowanceDraftId
  return typeof c.eventSlug === 'string' && c.eventSlug ? draftIdForEventSlug(c.eventSlug) : null
}

/**
 * Charge-back of `units` broadcast messages that settlement refunded but that Meta had ACCEPTED.
 * Phase 1 READS (call before any write in the transaction); phase 2 WRITES. Wallet-funded: debit
 * units × unit price under `ledgerRef`. Prepaid: take the units (when available). Free campaign
 * (nothing was ever charged): counted at cost 0. Campaign counters and usage record move with it.
 */
async function txnReadChargeBack(txn: FirebaseFirestore.Transaction, campaignId: string, c: CampaignBillingDoc, allowanceDraftId: string | null, ledgerRef: FirebaseFirestore.DocumentReference) {
  const chargeRef = adminDb.collection('walletTransactions').doc(`broadcast_${campaignId}`)
  const usageRef  = adminDb.collection('communicationUsage').doc(`bc_${campaignId}`)
  const walletRef = c.organizerUid ? adminDb.doc(`organizerWallets/${c.organizerUid}`) : null
  const aUsageRef = allowanceDraftId ? serviceLedgerRef(allowanceDraftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION).doc(`bc_${campaignId}`) : null
  const [chargeSnap, ledgerDocSnap, walletSnap, allowanceSnap, aUsageSnap, usageSnap] = await Promise.all([
    txn.get(chargeRef), txn.get(ledgerRef),
    walletRef ? txn.get(walletRef) : Promise.resolve(null),
    allowanceDraftId ? txn.get(serviceLedgerRef(allowanceDraftId)) : Promise.resolve(null),
    aUsageRef ? txn.get(aUsageRef) : Promise.resolve(null),
    txn.get(usageRef),
  ])
  return { chargeSnap, ledgerDocSnap, walletSnap, allowanceSnap, aUsageSnap, usageSnap, usageRef, walletRef, aUsageRef }
}

function txnWriteChargeBack(
  txn: FirebaseFirestore.Transaction, campaignId: string, campaignRef: FirebaseFirestore.DocumentReference, c: CampaignBillingDoc,
  allowanceDraftId: string | null, reads: Awaited<ReturnType<typeof txnReadChargeBack>>, units: number,
  ledgerRef: FirebaseFirestore.DocumentReference, allowNegative: boolean, why: string, meta: Record<string, unknown>,
): boolean {
  const { chargeSnap, walletSnap, allowanceSnap, aUsageSnap, usageSnap, usageRef, walletRef, aUsageRef } = reads
  let charged = false, amount = 0
  if (chargeSnap.exists && walletRef) {
    const ch = chargeSnap.data() as { amountPaise?: number; metadata?: { units?: number; eventSlug?: string; eventId?: string } }
    const chargedUnits = Math.max(1, Math.floor(ch.metadata?.units ?? 1))
    const unitPaise = typeof c.unitPricePaise === 'number' && c.unitPricePaise > 0 ? c.unitPricePaise : Math.round((ch.amountPaise ?? 0) / chargedUnits)
    amount = unitPaise * units
    const balance = walletSnap?.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    if (amount > 0 && (allowNegative || balance >= amount)) {
      txn.set(walletRef, { balancePaise: balance - amount, currency: 'INR', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      txn.set(ledgerRef, {
        organizerUid: c.organizerUid, type: 'broadcast_whatsapp', amountPaise: amount, balancePaise: balance - amount,
        status: 'completed', referenceType: 'communication', referenceId: campaignId,
        description: `${String(c.channel ?? 'whatsapp').toUpperCase()} broadcast — ${units} message${units === 1 ? '' : 's'} ${why}`,
        metadata: clean({ ...meta, campaignId, units, channel: c.channel ?? 'whatsapp', late: true, eventSlug: ch.metadata?.eventSlug, eventId: ch.metadata?.eventId }),
        createdAt: FieldValue.serverTimestamp(),
      })
      charged = true
    } else {
      amount = 0
    }
  } else if (allowanceDraftId && allowanceSnap?.exists && aUsageRef) {
    if (availableUnits(ledgerLine(allowanceSnap.data() as ServiceLedgerDoc, 'whatsapp')) >= units) {
      txn.set(serviceLedgerRef(allowanceDraftId), { whatsapp: { consumed: FieldValue.increment(units) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      txn.set(aUsageRef, { service: 'whatsapp', quantity: FieldValue.increment(units), source: 'broadcast', updatedAt: FieldValue.serverTimestamp(), ...(aUsageSnap?.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true })
      txn.set(ledgerRef, { organizerUid: c.organizerUid, type: 'adjustment', amountPaise: 0, status: 'completed', referenceType: 'communication', referenceId: campaignId,
        description: `Prepaid WhatsApp — ${units} unit${units === 1 ? '' : 's'} for messages ${why}`, metadata: { ...meta, campaignId, units, channel: 'whatsapp', late: true, prepaid: true }, createdAt: FieldValue.serverTimestamp() })
      charged = true
    }
  } else if (!chargeSnap.exists && !allowanceDraftId) {
    charged = true   // a free campaign: nothing to charge, but the accepted message is counted
  }
  txn.update(campaignRef, charged
    ? { billedUnits: FieldValue.increment(units), refundedUnits: FieldValue.increment(-units), lateAcceptedUnits: FieldValue.increment(units),
        successCount: FieldValue.increment(units), failCount: FieldValue.increment(-units),
        ...(amount > 0 ? { actualCostPaise: FieldValue.increment(amount), lateChargedPaise: FieldValue.increment(amount) } : {}) }
    : { lateUnbilledUnits: FieldValue.increment(units), successCount: FieldValue.increment(units), failCount: FieldValue.increment(-units) })
  if (charged) {
    txn.set(usageRef, {
      quantity: FieldValue.increment(units), ...(amount > 0 ? { costPaise: FieldValue.increment(amount) } : {}), updatedAt: FieldValue.serverTimestamp(),
      // The campaign may have had no usage record (nothing accepted at settlement): create it whole.
      ...(usageSnap.exists ? {} : {
        organizerUid: c.organizerUid ?? '', eventSlug: c.eventSlug ?? '', eventId: c.eventSlug ?? '', eventName: c.eventName ?? '',
        channel: c.channel ?? 'whatsapp', campaignId, templateKey: 'broadcast', createdAt: FieldValue.serverTimestamp(),
        ...(amount > 0 ? {} : { costPaise: 0 }),
      }),
    }, { merge: true })
  }
  return charged
}

/**
 * Marks one broadcast recipient ACCEPTED (sent flag + wamid). Before the campaign is settled this
 * is all — settlement counts the flags, and reconcileBroadcastBilledUnits catches an acceptance that
 * lands between that count and the settlement commit. AFTER settlement (the acceptance was recovered
 * late: a lost write, a crash, or a timed-out send Meta had in fact accepted) the recipient was
 * already refunded, so it is charged back here, in the same transaction, exactly once.
 */
export async function recordBroadcastAcceptance(args: {
  jobId: string; recipientId: string; wamid: string; source: 'send' | 'webhook'
}): Promise<BroadcastAcceptanceOutcome> {
  const recipientRef = adminDb.collection(WHATSAPP_BROADCAST_JOBS_COLLECTION).doc(args.jobId).collection('recipients').doc(args.recipientId)
  const jobSnap = await adminDb.collection(WHATSAPP_BROADCAST_JOBS_COLLECTION).doc(args.jobId).get()
  if (!jobSnap.exists) return 'missing'
  const campaignId = String((jobSnap.data() as { campaignId?: unknown }).campaignId ?? '')
  if (!campaignId) return 'missing'
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(campaignId)
  const pre = await campaignRef.get()
  if (!pre.exists) return 'missing'
  const allowanceDraftId = await campaignAllowanceDraftId(pre.data() as CampaignBillingDoc)
  const walletCfg = await getWalletConfig()
  const lateRef = adminDb.collection('walletTransactions').doc(`broadcast_late_${campaignId}_${args.recipientId}`)

  return adminDb.runTransaction<BroadcastAcceptanceOutcome>(async txn => {
    const [rSnap, cSnap] = await Promise.all([txn.get(recipientRef), txn.get(campaignRef)])
    if (!rSnap.exists || !cSnap.exists) return 'missing'
    if ((rSnap.data() as { sent?: boolean }).sent === true) return 'already'
    const c = cSnap.data() as CampaignBillingDoc
    const accepted = { sent: true, wamid: args.wamid, acceptedVia: args.source, acceptedAt: FieldValue.serverTimestamp(), pendingAttemptAt: FieldValue.delete(), indeterminate: FieldValue.delete() }
    if (!c.billingSettledAt) {
      txn.update(recipientRef, accepted)
      return 'recorded'
    }
    const reads = await txnReadChargeBack(txn, campaignId, c, allowanceDraftId, lateRef)
    if (reads.ledgerDocSnap.exists) { txn.update(recipientRef, accepted); return 'already' }
    const charged = txnWriteChargeBack(txn, campaignId, campaignRef, c, allowanceDraftId, reads, 1, lateRef, walletCfg.allowNegativeBalance,
      'accepted by WhatsApp after the campaign was settled', { recipientId: args.recipientId })
    txn.update(recipientRef, accepted)
    return charged ? 'late_charged' : 'late_unbilled'
  })
}

/**
 * RD-CLOSE — closes the window between settlement's accepted COUNT and its COMMIT: a recipient
 * marked accepted in between ('recorded' — the campaign was not yet settled when it committed) is
 * counted by neither. Run after every settlement (and by the sweep): the billed + unbillable units
 * must equal the recipients marked `sent`; any shortfall is charged back once. Idempotent — the
 * deterministic ledger id records the billed count it started from; a re-run finds nothing missing.
 */
export async function reconcileBroadcastBilledUnits(campaignId: string): Promise<number> {
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(campaignId)
  for (let pass = 0; pass < 3; pass++) {
    const pre = await campaignRef.get()
    if (!pre.exists) return 0
    const c0 = pre.data() as CampaignBillingDoc
    if (!c0.billingSettledAt) return 0
    if (typeof c0.whatsappJobId !== 'string' || !c0.whatsappJobId) {   // never sent: nothing can be missing
      await campaignRef.update({ billingCatchUp: 'done' }).catch(() => undefined); return 0
    }
    const sent = (await adminDb.collection(WHATSAPP_BROADCAST_JOBS_COLLECTION).doc(c0.whatsappJobId).collection('recipients')
      .where('sent', '==', true).count().get()).data().count
    const counted = (c: CampaignBillingDoc) => Math.max(0, Math.floor(c.billedUnits ?? 0)) + Math.max(0, Math.floor(c.lateUnbilledUnits ?? 0))
    const from = counted(c0)
    if (sent <= from) { await campaignRef.update({ billingCatchUp: 'done' }).catch(() => undefined); return 0 }
    const allowanceDraftId = await campaignAllowanceDraftId(c0)
    const walletCfg = await getWalletConfig()
    const ledgerRef = adminDb.collection('walletTransactions').doc(`broadcast_catchup_${campaignId}_${from}`)
    const done = await adminDb.runTransaction<number | null>(async txn => {
      const cSnap = await txn.get(campaignRef)
      const c = cSnap.data() as CampaignBillingDoc
      if (counted(c) !== from) return null                       // moved meanwhile — recount
      const reads = await txnReadChargeBack(txn, campaignId, c, allowanceDraftId, ledgerRef)
      if (reads.ledgerDocSnap.exists) return 0
      txnWriteChargeBack(txn, campaignId, campaignRef, c, allowanceDraftId, reads, sent - from, ledgerRef, walletCfg.allowNegativeBalance,
        'accepted by WhatsApp while the campaign was being settled', { catchUpFrom: from })
      return sent - from
    })
    if (done !== null) { await campaignRef.update({ billingCatchUp: 'done' }).catch(() => undefined); return done }
  }
  return 0
}
