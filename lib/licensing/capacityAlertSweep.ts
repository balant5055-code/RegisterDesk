// RD-CAPACITY-01 · The capacity-threshold sweep. Server-only.
//
// Finds published events that have crossed a utilisation threshold since the last run, and
// tells their organizer — by email, and by WhatsApp where a template is approved.
//
// ═══ WHY A SWEEP AND NOT THE REGISTRATION TRANSACTION ════════════════════════
// The obvious place to notice "this event just hit 95%" is the transaction that increments
// the counter: it already holds the count and the capacity. It is also the transaction that
// prevents overselling, and it runs on every single registration and every payment
// confirmation, restore, approval and bulk import. Adding a write to it to power a courtesy
// email trades a real oversell risk against a few minutes of notification latency, and that
// is not a good trade. The counter path is left exactly as it is.
//
// The cost is latency bounded by the cron interval, and nothing else: the decision is
// computed from the same two numbers the transaction would have used, so the thresholds and
// the messages are identical either way.
//
// ═══ HOW DOUBLE-SENDING IS PREVENTED ════════════════════════════════════════
// The state write is a CONDITIONAL transaction on the event document: it re-reads the stored
// state and re-decides inside the transaction, so two overlapping cron runs cannot both claim
// the same threshold. Only the run whose transaction commits sends anything, and it sends
// after the commit — never inside it.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { sendOrganizerWhatsApp } from '@/lib/notifications/organizerWhatsApp'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import {
  decideCapacityAlert, CAPACITY_ALERT_FIELD, type CapacityThreshold,
} from './capacityThresholds'

export interface CapacitySweepResult {
  scanned:  number
  notified: number
  reset:    number
  skipped:  number
  failed:   number
}

interface Claim {
  eventId:       string
  organizerUid:  string
  eventName:     string
  threshold:     CapacityThreshold
  capacity:      number
  registrations: number
}

/**
 * Claim a threshold for one event, atomically.
 *
 * Re-reads the event and re-decides inside the transaction, so the decision the caller made
 * from a stale read cannot be acted on twice. Returns the claim only when THIS transaction is
 * the one that recorded it.
 */
async function claimThreshold(eventId: string, registrations: number): Promise<Claim | null> {
  const evRef = adminDb.collection('events').doc(eventId)

  return adminDb.runTransaction<Claim | null>(async (txn) => {
    const snap = await txn.get(evRef)
    if (!snap.exists) return null
    const ev = snap.data() as Record<string, unknown>

    const capacity = deriveStoredEventCapacity(ev as Parameters<typeof deriveStoredEventCapacity>[0])
    const decision = decideCapacityAlert({
      count: registrations,
      capacity,
      storedState: ev[CAPACITY_ALERT_FIELD],
    })

    // The state is persisted even with nothing to send, because a capacity CHANGE has to be
    // recorded: that is what re-arms the lower thresholds after an organizer buys more.
    // Writing it here, not later, means the re-arm survives a crash before dispatch.
    if (decision.threshold === null) {
      if (decision.reset) {
        txn.set(evRef, { [CAPACITY_ALERT_FIELD]: decision.nextState }, { merge: true })
      }
      return null
    }

    txn.set(evRef, { [CAPACITY_ALERT_FIELD]: decision.nextState }, { merge: true })

    const details = (ev.eventDetails as { info?: { name?: unknown } } | undefined)?.info?.name
    return {
      eventId,
      organizerUid:  typeof ev.uid === 'string' ? ev.uid : '',
      eventName:     typeof details === 'string' && details.trim() ? details : eventId,
      threshold:     decision.threshold,
      capacity:      capacity ?? 0,
      registrations,
    }
  })
}

/** Dispatch one claimed threshold. Never throws — a failed message must not stop the sweep. */
async function dispatch(claim: Claim): Promise<boolean> {
  try {
    const userSnap = await adminDb.collection('users').doc(claim.organizerUid).get()
    const user = userSnap.data() as { email?: string; name?: string } | undefined
    if (!user?.email) return false

    if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
      await notificationEngine.send(NotificationType.CAPACITY_THRESHOLD, {
        to:            user.email,
        organizerName: user.name ?? '',
        eventName:     claim.eventName,
        eventSlug:     claim.eventId,
        threshold:     claim.threshold,
        capacity:      claim.capacity,
        registrations: claim.registrations,
      })
    }

    // WhatsApp runs alongside the email and cannot affect it. It self-skips when the Meta
    // template is not approved or the organizer has no account mobile on file.
    void sendOrganizerWhatsApp({
      type:         NotificationType.CAPACITY_THRESHOLD,
      organizerUid: claim.organizerUid,
      variables: {
        organizerName: user.name ?? '',
        eventName:     claim.eventName,
        threshold:     String(claim.threshold),
        capacity:      claim.capacity.toLocaleString('en-IN'),
      },
      eventSlug: claim.eventId,
      eventName: claim.eventName,
    })

    return true
  } catch (err) {
    console.error('[capacity-alerts] dispatch failed', { eventId: claim.eventId, err })
    return false
  }
}

/**
 * Run one sweep.
 *
 * Bounded by `limit` and by `budgetMs` so a growing event count can never push the cron past
 * its execution limit — it simply covers fewer events per run and catches up on the next,
 * which is the correct failure mode for a notification.
 */
export async function sweepCapacityAlerts(limit = 200, budgetMs = 45_000): Promise<CapacitySweepResult> {
  const startedAt = Date.now()
  const out: CapacitySweepResult = { scanned: 0, notified: 0, reset: 0, skipped: 0, failed: 0 }

  // Published events only. An unpublished draft has no registrations to be full of.
  const events = await adminDb.collection('events')
    .where('lifecycleStatus', '==', 'published')
    .limit(limit)
    .get()

  for (const doc of events.docs) {
    if (Date.now() - startedAt > budgetMs) break
    out.scanned++

    const ev = doc.data() as Record<string, unknown>
    const capacity = deriveStoredEventCapacity(ev as Parameters<typeof deriveStoredEventCapacity>[0])
    // Uncapped events can never cross a percentage — skip before spending a counter read.
    if (capacity === null || capacity <= 0) { out.skipped++; continue }

    // A pre-check read, purely to avoid opening a transaction for the overwhelming majority
    // of events that have nothing due. The transaction re-reads and re-decides, so this read
    // being stale is harmless.
    const counterSnap = await adminDb.collection('registrationCounters').doc(doc.id).get()
    const registrations = (counterSnap.data() as { totalCount?: number } | undefined)?.totalCount ?? 0

    const preview = decideCapacityAlert({ count: registrations, capacity, storedState: ev[CAPACITY_ALERT_FIELD] })
    if (preview.threshold === null && !preview.reset) { out.skipped++; continue }

    try {
      const claim = await claimThreshold(doc.id, registrations)
      if (!claim) { out.reset += preview.reset ? 1 : 0; out.skipped++; continue }
      if (await dispatch(claim)) out.notified++
      else out.failed++
    } catch (err) {
      out.failed++
      console.error('[capacity-alerts] claim failed', { eventId: doc.id, err })
    }
  }

  return out
}

/**
 * Clear an event's alert state. Called when capacity is bought so the organizer is warned
 * again as the new capacity fills, without waiting for the sweep to notice the stamp is stale.
 *
 * Strictly an optimisation: `decideCapacityAlert` already resets on a capacity mismatch, so
 * forgetting to call this delays the re-arm by one sweep rather than breaking it.
 */
export async function resetCapacityAlertState(eventId: string): Promise<void> {
  await adminDb.collection('events').doc(eventId)
    .set({ [CAPACITY_ALERT_FIELD]: FieldValue.delete() }, { merge: true })
    .catch(() => {})
}
