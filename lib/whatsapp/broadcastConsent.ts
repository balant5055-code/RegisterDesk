// RD-COMMS-WA-CONSENT — WhatsApp consent for ORGANIZER BROADCASTS. Server-only.
//
// Scope: this governs organizer-initiated WhatsApp broadcasts ONLY. Transactional / platform
// WhatsApp (registration confirmation, payment, event operational and certificate notifications
// sent by the platform paths in lib/registrations/*, lib/certificates/*) is NOT read through this
// module and is unaffected by it.
//
// A registration is a broadcast recipient only when BOTH hold:
//
//   1. EXPLICIT OPT-IN — `registrations/{id}.whatsappBroadcastConsent.state === 'opted_in'`, BOUND to the
//      number that consented (`phoneHash` must equal the hash of the CURRENT attendee.phone),
//      written only when the attendee ticked the (unchecked-by-default) "WhatsApp updates" box at
//      registration, validated server-side and stamped with time, source and wording version.
//      Nothing else creates it: a phone number, the registration itself, accepting the platform
//      terms, an earlier delivered message, or a normal inbound reply are NOT consent. Historical
//      registrations carry no such field and are therefore not eligible.
//
//   2. NO OPT-OUT — no STOP on record for the number: `whatsappBroadcastOptOuts/{phoneKey}` with
//      `state === 'opted_out'`. An inbound STOP / UNSUBSCRIBE / CANCEL / END / QUIT is a HARD
//      suppression for every organizer broadcast to that number (all organizer broadcasts leave
//      from the platform's one WhatsApp business number, so "stop" can only mean "stop
//      broadcasts from this sender"). Only an explicit START / UNSTOP from the same number lifts
//      it; a new registration, another message, a normal reply or any organizer action never does.
//
// The phone identity is `phoneKey` = SHA-256 of the number normalised by the SAME function every
// outbound WhatsApp path uses (normalizePhoneNumber), so a STOP from wa_id "9198…" suppresses the
// number a registration stored as "+91 98…". No phone number is stored in either collection.
// Every applied change writes ONE audit row keyed by the inbound message id, so Meta's redelivery
// of the same message — or two workers processing it at once — changes nothing twice.

import { createHash } from 'node:crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { validatePhoneNumber } from '@/lib/communication/phone'

export const WHATSAPP_OPT_OUTS    = 'whatsappBroadcastOptOuts'
export const WHATSAPP_CONSENT_AUDIT = 'whatsappConsentAudit'

/** Version of the opt-in wording shown at registration (stamped on every consent). */
export const WHATSAPP_CONSENT_VERSION = 'wa-broadcast-optin-v1'

/** The consent record on a registration. Absent ⇒ not consented. */
export interface WhatsAppBroadcastConsent {
  state:     'opted_in'
  at:        unknown          // Firestore Timestamp
  source:    'registration_form'
  version:   string
  /** RD-COMMS-WA-CONSENT · phone binding — whatsappPhoneKey() of the number that CONSENTED (the
   *  same hash as the STOP record; never the number itself). Consent is valid only while the
   *  registration's CURRENT number hashes to this, so an edited number never inherits it. */
  phoneHash: string
}

// ─── Identity ─────────────────────────────────────────────────────────────────

/** SHA-256 of the normalised number, or null when there is no usable number. */
export function whatsappPhoneKey(raw: string | null | undefined): string | null {
  // The SAME validation + normalisation the outbound send path applies (whatsappJob).
  const v = validatePhoneNumber(String(raw ?? ''))
  if (!v.valid || !v.normalizedPhone) return null
  return createHash('sha256').update(`wa:${v.normalizedPhone}`).digest('hex')
}

// ─── Inbound commands ─────────────────────────────────────────────────────────

const STOP_WORDS  = new Set(['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT', 'OPT-OUT'])
const START_WORDS = new Set(['START', 'UNSTOP'])

/**
 * The opt command a message body IS — the whole message, not a word inside a sentence ("please
 * don't stop the event" is not an opt-out). Case-insensitive; surrounding whitespace and trailing
 * punctuation are ignored. null for everything else, including every normal reply.
 */
export function parseWhatsAppOptCommand(body: unknown): { action: 'opt_out' | 'opt_in'; keyword: string } | null {
  if (typeof body !== 'string') return null
  const w = body.normalize('NFKC').trim().replace(/[\s.!?]+$/u, '').replace(/\s+/g, ' ').toUpperCase()
  if (!w || w.length > 16) return null
  if (STOP_WORDS.has(w))  return { action: 'opt_out', keyword: w }
  if (START_WORDS.has(w)) return { action: 'opt_in', keyword: w }
  return null
}

export interface InboundForConsent {
  wamid:           string
  from:            string
  type:            string
  text:            unknown
  metaTimestampMs: number
}

export interface OptCommandOutcome { applied: number; superseded: number; duplicates: number; ignored: number }

/**
 * Apply every STOP/START among inbound messages. Idempotent per message (audit row keyed by the
 * wamid, created in the same transaction as the state change) and order-safe (a command older
 * than the recorded change is recorded but does not overwrite it). Throws on a write failure so
 * the webhook can ask Meta to redeliver.
 */
export async function applyInboundOptCommands(messages: InboundForConsent[]): Promise<OptCommandOutcome> {
  const out: OptCommandOutcome = { applied: 0, superseded: 0, duplicates: 0, ignored: 0 }
  for (const m of messages) {
    const textBody = m.text
    const cmd = m.type === 'text' ? parseWhatsAppOptCommand(textBody) : null
    const phoneKey = cmd ? whatsappPhoneKey(m.from) : null
    if (!cmd || !phoneKey || !m.wamid) { out.ignored++; continue }

    const auditRef = adminDb.collection(WHATSAPP_CONSENT_AUDIT).doc(createHash('sha256').update(`wamid:${m.wamid}`).digest('hex'))
    const stateRef = adminDb.collection(WHATSAPP_OPT_OUTS).doc(phoneKey)
    const atMs = m.metaTimestampMs > 0 ? m.metaTimestampMs : Date.now()
    const result = await adminDb.runTransaction(async txn => {
      const [audit, state] = await Promise.all([txn.get(auditRef), txn.get(stateRef)])
      if (audit.exists) return 'duplicate' as const
      const prevAt = Number((state.data() as { changedAtMs?: unknown } | undefined)?.changedAtMs ?? 0)
      const newer = !state.exists || atMs > prevAt
      if (newer) {
        txn.set(stateRef, {
          state: cmd.action === 'opt_out' ? 'opted_out' : 'opted_in',
          changedAtMs: atMs, keyword: cmd.keyword, source: 'inbound_keyword',
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
      txn.create(auditRef, {
        action: cmd.action, phoneKey, keyword: cmd.keyword, source: 'inbound_keyword',
        applied: newer, metaAt: Timestamp.fromMillis(atMs), at: FieldValue.serverTimestamp(),
      })
      return newer ? 'applied' as const : 'superseded' as const
    })
    if (result === 'duplicate') out.duplicates++
    else if (result === 'superseded') out.superseded++
    else out.applied++
  }
  return out
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

export type WhatsAppBroadcastBlock = 'no_phone' | 'no_consent' | 'phone_changed' | 'opted_out' | 'registration_missing'

/** Readable reasons (logged on a skipped recipient, shown to the organizer). */
export const WHATSAPP_SKIP_REASONS: Record<WhatsAppBroadcastBlock, string> = {
  no_phone:             'Not sent — no valid WhatsApp number',
  no_consent:           'Not sent — the attendee did not opt in to WhatsApp updates',
  phone_changed:        'Not sent — the phone number changed after the attendee opted in; the new number has not opted in',
  opted_out:            'Not sent — the recipient replied STOP to WhatsApp messages',
  registration_missing: 'Not sent — the registration no longer exists',
}

/**
 * Explicit, recorded opt-in on the registration, BOUND TO ITS CURRENT NUMBER — nothing else counts.
 * 'ok' only when the consent is `opted_in`, carries a phoneHash, and that hash equals the hash of
 * the registration's CURRENT attendee.phone (derived here, server-side — never from a client).
 * A consent without a phoneHash cannot be tied to any number and fails closed ('no_consent').
 */
export function whatsappConsentStatus(reg: unknown): 'ok' | 'no_consent' | 'phone_changed' {
  const r = reg as { whatsappBroadcastConsent?: { state?: unknown; phoneHash?: unknown }; attendee?: { phone?: unknown } } | null | undefined
  const c = r?.whatsappBroadcastConsent
  if (c?.state !== 'opted_in' || typeof c.phoneHash !== 'string' || !c.phoneHash) return 'no_consent'
  const current = whatsappPhoneKey(typeof r?.attendee?.phone === 'string' ? r.attendee.phone : '')
  return current !== null && current === c.phoneHash ? 'ok' : 'phone_changed'
}

export function hasWhatsAppBroadcastConsent(reg: unknown): boolean {
  return whatsappConsentStatus(reg) === 'ok'
}

/** Which of these phone keys are currently opted out (STOP). Batched reads. */
export async function optedOutPhoneKeys(keys: string[]): Promise<Set<string>> {
  const unique = [...new Set(keys.filter(Boolean))]
  const out = new Set<string>()
  for (let i = 0; i < unique.length; i += 300) {
    const snaps = await adminDb.getAll(...unique.slice(i, i + 300).map(k => adminDb.collection(WHATSAPP_OPT_OUTS).doc(k)))
    for (const s of snaps) if (s.exists && (s.data() as { state?: unknown }).state === 'opted_out') out.add(s.id)
  }
  return out
}

/**
 * Recipient SELECTION (broadcast creation, job build, count preview): keep only registrations
 * with a number, an explicit opt-in and no STOP. Runs on the server against stored data — the
 * client never says who consented.
 */
export async function filterWhatsAppBroadcastRecipients<T extends { data: unknown }>(
  recipients: T[],
): Promise<{ eligible: T[]; noConsent: number; optedOut: number }> {
  const consenting = recipients.filter(r => hasWhatsAppBroadcastConsent(r.data))
  const keyed = consenting.map(r => ({ r, key: whatsappPhoneKey((r.data as { attendee?: { phone?: string } }).attendee?.phone) }))
  const stopped = await optedOutPhoneKeys(keyed.map(k => k.key).filter((k): k is string => !!k))
  // Consent is bound to a valid number (whatsappConsentStatus), so every consenting registration
  // here has a key; the `!k.key` arm is only a defensive pass-through to the send boundary.
  const eligible = keyed.filter(k => !k.key || !stopped.has(k.key)).map(k => k.r)
  return { eligible, noConsent: recipients.length - consenting.length, optedOut: consenting.length - eligible.length }
}

/**
 * The SEND-BOUNDARY check, read fresh immediately before Meta is called: the registration's
 * opt-in and the number's STOP state as they are NOW, not as they were when the audience was
 * selected. null ⇒ may send. Throws on a read failure (the caller does not send).
 */
export async function whatsappBroadcastSendBlock(registrationId: string, phone: string): Promise<WhatsAppBroadcastBlock | null> {
  const key = whatsappPhoneKey(phone)
  if (!key) return 'no_phone'
  const [reg, stop] = await adminDb.getAll(
    adminDb.collection('registrations').doc(registrationId),
    adminDb.collection(WHATSAPP_OPT_OUTS).doc(key),
  )
  if (!reg.exists) return 'registration_missing'
  const status = whatsappConsentStatus(reg.data())
  if (status !== 'ok') return status
  // The number about to be messaged (the job's snapshot) must be the number that consented, too:
  // a snapshot taken before an edit is never sent to once the registration has moved on.
  if (key !== (reg.data() as { whatsappBroadcastConsent: { phoneHash: string } }).whatsappBroadcastConsent.phoneHash) return 'phone_changed'
  if (stop.exists && (stop.data() as { state?: unknown }).state === 'opted_out') return 'opted_out'
  return null
}

/** Super Admin investigation: the number's broadcast opt-out state and its history. Read-only. */
export async function investigateWhatsAppOptOut(phone: string): Promise<{
  phoneKey: string | null
  state: { state: string; keyword: string | null; changedAt: string | null } | null
  history: { action: string; keyword: string | null; applied: boolean; at: string | null }[]
}> {
  const key = whatsappPhoneKey(phone)
  if (!key) return { phoneKey: null, state: null, history: [] }
  const [stateSnap, auditSnap] = await Promise.all([
    adminDb.collection(WHATSAPP_OPT_OUTS).doc(key).get(),
    adminDb.collection(WHATSAPP_CONSENT_AUDIT).where('phoneKey', '==', key).limit(100).get(),
  ])
  const iso = (v: unknown) => (v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null)
  const s = stateSnap.exists ? stateSnap.data() as Record<string, unknown> : null
  return {
    phoneKey: key,
    state: s ? { state: String(s.state ?? ''), keyword: typeof s.keyword === 'string' ? s.keyword : null, changedAt: typeof s.changedAtMs === 'number' ? new Date(s.changedAtMs).toISOString() : null } : null,
    history: auditSnap.docs.map(d => d.data() as Record<string, unknown>).map(a => ({
      action: String(a.action ?? ''), keyword: typeof a.keyword === 'string' ? a.keyword : null, applied: a.applied === true, at: iso(a.metaAt),
    })).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
  }
}

/**
 * The fields a registration write stamps for an explicit opt-in — `{}` unless the attendee ticked
 * the box (strict `true`) AND gave a usable WhatsApp number. Shared by the free path
 * (createRegistration) and the paid path (settlement, from the payment-intent snapshot).
 */
export function whatsappConsentFields(optIn: unknown, phone: unknown): { whatsappBroadcastConsent?: WhatsAppBroadcastConsent } {
  // The hash is derived HERE from the server-side phone value of this registration write.
  const phoneHash = whatsappPhoneKey(typeof phone === 'string' ? phone : '')
  if (optIn !== true || !phoneHash) return {}
  return { whatsappBroadcastConsent: { state: 'opted_in', at: FieldValue.serverTimestamp(), source: 'registration_form', version: WHATSAPP_CONSENT_VERSION, phoneHash } }
}
