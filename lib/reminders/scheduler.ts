// Reminder scheduler (materializer) — server-only. Scans published events and the
// active organizers' wallets and CREATES due reminder jobs in `scheduledReminders`
// with DETERMINISTIC ids, so overlapping cron runs never duplicate a reminder
// (create-if-absent inside a transaction — the same idempotency idiom broadcasts /
// wallet charges use). It sends nothing; the dispatcher does that when jobs fall due.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import { getWalletBalance } from '@/lib/firebase/firestore/wallet'
import { getReminderSettings, isEventRemindersEnabled } from './config'
import { AUTO_REMINDER_KINDS, KIND_AUDIENCE, type ReminderKind } from './types'

const REMINDERS = adminDb.collection('scheduledReminders')

const EVENT_SCAN_LIMIT = 500
const GRACE_MS   = 2  * 60 * 60 * 1000     // materialize up to 2h after the due time
const HORIZON_MS = 50 * 60 * 60 * 1000     // only materialize reminders due within ~2 days

// Parse a stored 'YYYY-MM-DD' (+ optional 'HH:MM') as IST (UTC+5:30) → epoch ms.
// Platform event times are IST throughout (see lib/calendar/ics.ts).
function istEpochMs(dateStr: unknown, timeStr?: unknown): number | null {
  if (typeof dateStr !== 'string') return null
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return null
  const [h, min] = (typeof timeStr === 'string' && timeStr ? timeStr : '00:00').split(':').map(Number)
  return Date.UTC(y, m - 1, d, (h || 0) - 5, (min || 0) - 30)
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k] }
  return cur
}

interface Materialized { created: number; scannedEvents: number; scannedOrganizers: number }

/** Create a reminder doc only if its deterministic id doesn't already exist. */
async function createIfAbsent(id: string, data: Record<string, unknown>): Promise<boolean> {
  const ref = REMINDERS.doc(id)
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (snap.exists) return false
    txn.set(ref, { ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return true
  })
}

/** Anchor epoch (ms) for each auto event-kind, or null when not applicable. */
function anchorFor(kind: ReminderKind, ed: unknown, pricing: unknown): number | null {
  const startDate = nested(ed, 'schedule', 'startDate')
  const startTime = nested(ed, 'schedule', 'startTime')
  switch (kind) {
    case 'event_tomorrow':
    case 'event_starting_soon':
      return istEpochMs(startDate, startTime)
    case 'event_today':
      // Morning-of: 08:00 IST on the event day.
      return istEpochMs(startDate, '08:00')
    case 'registration_closing':
      return istEpochMs(nested(pricing, 'registrationEndDate'), '23:59')
    case 'early_bird_ending': {
      const passes = nested(pricing, 'passes')
      if (!Array.isArray(passes)) return null
      const ends = passes
        .filter(p => (p as Record<string, unknown>).earlyBirdEnabled === true && typeof (p as Record<string, unknown>).earlyBirdEndDate === 'string')
        .map(p => istEpochMs((p as Record<string, unknown>).earlyBirdEndDate, '23:59'))
        .filter((n): n is number => n !== null)
      return ends.length ? Math.min(...ends) : null
    }
    default:
      return null
  }
}

/** Scan events + wallets and create the reminder jobs that are coming due. */
export async function materializeReminders(): Promise<Materialized> {
  const settings = await getReminderSettings()
  if (!settings.enabled) return { created: 0, scannedEvents: 0, scannedOrganizers: 0 }

  const now = Date.now()
  const snap = await adminDb.collection('events')
    .where('lifecycleStatus', '==', 'published')
    .limit(EVENT_SCAN_LIMIT)
    .get()

  let created = 0
  const organizerUids = new Set<string>()

  for (const doc of snap.docs) {
    const ev = doc.data() as Record<string, unknown>
    const eventId = doc.id
    const organizerUid = typeof ev.uid === 'string' ? ev.uid : (typeof ev.organizerUid === 'string' ? ev.organizerUid : '')
    if (organizerUid) organizerUids.add(organizerUid)
    const eventName = (nested(ev, 'eventDetails', 'info', 'name') as string) || eventId

    // Organizer opt-out for this event.
    if (!(await isEventRemindersEnabled(eventId))) continue

    for (const kind of AUTO_REMINDER_KINDS) {
      if (kind === 'low_wallet') continue         // wallet-driven, handled below
      if (!settings.kinds[kind]) continue

      const anchor = anchorFor(kind, ev.eventDetails, ev.pricing)
      if (anchor === null || anchor < now) continue    // no anchor / already passed

      const sendAt = anchor - settings.offsetHours[kind] * 60 * 60 * 1000
      if (sendAt < now - GRACE_MS || sendAt > now + HORIZON_MS) continue   // outside the materialization window

      const id = `rem_${eventId}_${kind}`
      const ok = await createIfAbsent(id, {
        eventId, eventName, organizerUid, kind, audience: KIND_AUDIENCE[kind],
        channel: 'email', status: 'scheduled', source: 'auto',
        subject: null, message: null,
        counts: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, costPaise: 0,
        createdBy: 'system', error: null,
        sendAt: Timestamp.fromMillis(Math.max(sendAt, now)),
      })
      if (ok) created++
    }
  }

  // ── low_wallet: one reminder per organizer per day when balance < threshold ──
  // Honour the same wallet policy the client banner uses: only warn when the wallet
  // is enabled and low-balance warnings are turned on (defaults preserve behaviour).
  if (settings.kinds.low_wallet) {
    const walletCfg = await getWalletConfig()
    if (walletCfg.enabled && walletCfg.showLowBalanceWarning) {
    const threshold = walletCfg.lowBalanceThresholdPaise
    const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')   // yyyymmdd
    for (const uid of organizerUids) {
      const balance = await getWalletBalance(uid)
      if (balance >= threshold) continue
      const ok = await createIfAbsent(`rem_lowwallet_${uid}_${day}`, {
        eventId: null, eventName: 'Wallet', organizerUid: uid, kind: 'low_wallet',
        audience: 'organizer', channel: 'email', status: 'scheduled', source: 'auto',
        subject: null, message: null,
        counts: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, costPaise: 0,
        createdBy: 'system', error: null,
        sendAt: Timestamp.fromMillis(now),
      })
      if (ok) created++
    }
    }
  }

  return { created, scannedEvents: snap.size, scannedOrganizers: organizerUids.size }
}
