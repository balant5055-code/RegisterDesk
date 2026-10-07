// lib/notifications/servicePurchase.ts
// Wallet-02 — notifications for a VERIFIED, APPLIED purchase of event service quantities
// (registration capacity, WhatsApp, certificates, photos): an organizer email, a platform support
// inbox email, and a Super Admin in-dashboard notification. Server-only.
//
// WHEN: called by every settlement path AFTER its activation transaction succeeded (checkout/confirm,
// capacity/confirm, the Razorpay webhook backstop, the purchase self-heal). It re-reads the order and
// does nothing unless the order is `paid`, so a caller can never notify for an unverified payment.
//
// EXACTLY ONCE per order: the first caller CREATES purchaseNotifications/{orderId} (a claim); every
// other caller — a duplicate webhook, a retry, a page refresh, a second settlement path — finds it
// and stops. A send that fails after the claim is recorded on the claim (status 'failed' + error) for
// follow-up; it is never retried automatically, so nothing can be sent twice.
//
// Best-effort by contract: never throws to the caller (a notification must never fail a payment).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb, adminAuth } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION, type CapacityChargeSnapshot } from '@/lib/licensing/schema'
import { viewOf, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import type { ServiceChargeItem } from '@/lib/licensing/serviceAllowances'
import { currentCapacityFromEvent, soldFromCounter } from '@/lib/licensing/capacityChange'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type { ServicePurchaseLine, ServicePurchaseBalance } from './catalog'
import { writeAdminNotification } from './adminInbox'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { emailUrl } from '@/lib/email/appUrl'
import { after } from 'next/server'

export const PURCHASE_NOTIFICATIONS = 'purchaseNotifications'
/** The Wallet link for the email (the shared email origin; a relative path if it is not configured). */
function walletLink(draftId: string | null): string {
  const path = `/dashboard/wallet${draftId ? `?eventId=${encodeURIComponent(draftId)}` : ''}`
  try { return emailUrl(path) } catch { return path }
}
type Rec = Record<string, unknown>
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const SERVICE_LABEL: Record<string, string> = { whatsapp: 'WhatsApp messages', certificates: 'Certificates', media: 'Event photos' }

/** Pure. The order's lines, from its own immutable snapshots. */
export function purchaseLines(order: Rec): ServicePurchaseLine[] {
  const lines: ServicePurchaseLine[] = []
  const c = order.capacityChange as CapacityChargeSnapshot | undefined
  if (c && (c.operation === 'activation' || c.operation === 'increase' || c.operation === 'decrease')) {
    const delta = int(c.capacity) - int(c.previousCapacity ?? 0)
    lines.push({
      label: c.operation === 'decrease' ? 'Registration capacity reduction' : 'Registration capacity',
      quantity: Math.abs(delta), basePaise: int(c.basePaise), gstPaise: int(c.gstPaise), totalPaise: int(c.totalPaise),
    })
  }
  for (const i of (Array.isArray(order.serviceItems) ? order.serviceItems as ServiceChargeItem[] : [])) {
    if (!i || int(i.quantity) <= 0) continue
    lines.push({ label: SERVICE_LABEL[i.service] ?? i.service, quantity: int(i.quantity), basePaise: int(i.basePaise), gstPaise: int(i.gstPaise), totalPaise: int(i.totalPaise) })
  }
  return lines
}

/**
 * The Super Admin email recipients: the platform support inbox (branding.supportEmail) plus the
 * account email of every uid in ADMIN_UIDS (the Super Admin list — never the legacy admin:true claim).
 * Deduplicated case-insensitively; an address that cannot be resolved is skipped, never guessed.
 */
export async function superAdminRecipients(): Promise<string[]> {
  const out = new Map<string, string>()
  const add = (e: unknown) => { if (typeof e === 'string' && /^[^\s@]+@[^\s@]+$/.test(e.trim())) out.set(e.trim().toLowerCase(), e.trim()) }
  add((await getBrandingConfig().catch(() => null))?.supportEmail)
  const uids = [...new Set((process.env.ADMIN_UIDS ?? '').split(',').map(u => u.trim()).filter(Boolean))].slice(0, 100)
  if (uids.length) {
    const res = await adminAuth.getUsers(uids.map(uid => ({ uid }))).catch(() => null)
    for (const u of res?.users ?? []) if (!u.disabled) add(u.email)
  }
  return [...out.values()]
}

/** Notifies once for a paid order. Returns what happened (for logs / tests); never throws. */
export async function notifyServicePurchase(orderId: string): Promise<'sent' | 'duplicate' | 'not_paid' | 'skipped' | 'failed'> {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(orderId)) return 'skipped'
    const oSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId).get()
    const order = oSnap.exists ? oSnap.data() as Rec : null
    if (!order || order.status !== 'paid') return 'not_paid'
    const lines = purchaseLines(order)
    if (lines.length === 0) return 'skipped'                         // nothing quantity-shaped was bought

    // The claim: exactly one caller proceeds.
    const claim = adminDb.collection(PURCHASE_NOTIFICATIONS).doc(orderId)
    try {
      await claim.create({ orderId, status: 'sending', createdAt: FieldValue.serverTimestamp() })
    } catch (err) {
      if ((err as { code?: number }).code === 6) return 'duplicate'  // ALREADY_EXISTS
      throw err
    }

    const uid = str(order.organizerUid) ?? ''
    const eventId = str(order.eventId) ?? ''
    // The draft id keys the ledger: activation / add-on orders key it directly; capacity orders
    // carry it as allowanceDraftId, or the live event maps its slug back to it.
    const slugFromOrder = order.purpose === 'capacity_increase' || order.purpose === 'capacity_decrease' ? eventId : null
    const evSnap = slugFromOrder ? await adminDb.doc(`events/${slugFromOrder}`).get() : null
    const ev = evSnap?.exists ? evSnap.data() as Rec : null
    const draftId = str(order.allowanceDraftId) ?? (slugFromOrder ? str(ev?.draftId) : eventId)
    const [userSnap, draftSnap, ledgerSnap] = await Promise.all([
      adminDb.doc(`users/${uid}`).get(),
      draftId ? adminDb.doc(`users/${uid}/eventDrafts/${draftId}`).get() : Promise.resolve(null),
      draftId ? adminDb.doc(`eventServiceAllowances/${draftId}`).get() : Promise.resolve(null),
    ])
    const user = (userSnap.data() ?? {}) as Rec
    const draft = draftSnap?.exists ? draftSnap.data() as Rec : null
    const name = (draft?.eventDetails as { info?: { name?: unknown } } | undefined)?.info?.name
      ?? (ev?.eventDetails as { info?: { name?: unknown } } | undefined)?.info?.name
    const eventName = typeof name === 'string' && name.trim() ? name.trim() : 'your event'
    const slug = slugFromOrder ?? str((draft?.eventDetails as { seo?: { urlSlug?: unknown } } | undefined)?.seo?.urlSlug)

    // Balances after the purchase (best-effort; a figure that cannot be read is null, never 0).
    const balances: ServicePurchaseBalance[] = []
    if (order.capacityChange && slug) {
      const [e2, cSnap] = await Promise.all([adminDb.doc(`events/${slug}`).get(), adminDb.doc(`registrationCounters/${slug}`).get()])
      // RD-CE-FIX C1 · the slug may come from the client-writable draft: figures are shown only for
      // a live document that is this organizer's event.
      const owned = e2.exists && (e2.data() as Rec).uid === uid
      const cap = owned ? currentCapacityFromEvent(e2.data() as Rec) : null
      const sold = soldFromCounter(cSnap.exists && owned ? cSnap.data() as Rec : undefined)
      balances.push({ label: 'Registration capacity', purchased: cap, used: owned ? sold : null, remaining: cap === null ? null : Math.max(0, cap - sold) })
    }
    const ledger = ledgerSnap?.exists && (ledgerSnap.data() as Rec).organizerUid === uid ? ledgerSnap.data() as ServiceLedgerDoc : undefined
    const view = viewOf(ledger)
    for (const k of ['whatsapp', 'certificates', 'media'] as const) {
      if (!lines.some(l => l.label === SERVICE_LABEL[k])) continue
      balances.push({
        label: SERVICE_LABEL[k], purchased: view.purchased[k] + view.carriedIn[k],
        used: k === 'media' ? null : view.consumed[k], remaining: k === 'media' ? null : view.remaining[k],
      })
    }

    const amountPaise = int(order.amountPaise)
    const gst = lines.reduce((n, l) => n + (l.gstPaise ?? 0), 0)
    const purchasedAt = ((order.paidAt as { toDate?: () => Date } | undefined)?.toDate?.() ?? new Date())
      .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
    const paymentId = str(order.razorpayPaymentId)
    const errors: string[] = []
    const emailOn = notificationEngine.isAvailable(NotificationChannel.EMAIL)

    const userEmail = str(user.email)
    if (emailOn && userEmail) {
      await notificationEngine.send(NotificationType.SERVICE_PURCHASED, {
        to: userEmail, organizerName: str(user.name) ?? '', eventName, lines, amountPaise,
        gstPaise: gst, discountPaise: int(order.discountPaise) || null, orderId, paymentId, purchasedAt, balances,
        walletUrl: walletLink(draftId),
      }).then(r => { if (r && r.success === false) errors.push('organizer: not sent') })
        .catch((e: unknown) => { errors.push(`organizer: ${e instanceof Error ? e.message : 'send failed'}`) })
    }
    // The platform copy goes to the support inbox AND to every Super Admin (ADMIN_UIDS) — each address
    // once, however many of those lists it appears on.
    const adminRecipients = emailOn ? await superAdminRecipients() : []
    for (const to of adminRecipients) {
      await notificationEngine.send(NotificationType.SERVICE_PURCHASE_ADMIN, {
        to, organizerName: str(user.name) ?? '', organizerEmail: userEmail ?? '', organizerUid: uid,
        eventName, lines, amountPaise, orderId, paymentId, purchasedAt,
      }).then(r => { if (r && r.success === false) errors.push(`admin ${to}: not sent`) })
        .catch((e: unknown) => { errors.push(`admin ${to}: ${e instanceof Error ? e.message : 'send failed'}`) })
    }
    await writeAdminNotification({
      dedupeId: `purchase-${orderId}`, kind: 'service_purchase',
      title: `${eventName}: ${lines.map(l => `${l.quantity.toLocaleString('en-IN')} ${l.label.toLowerCase()}`).join(', ')}`,
      body: `₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} paid by ${str(user.name) ?? userEmail ?? uid} · order ${orderId}`,
      // RD-CLOSE — straight to this event in Wallet Management (services, orders, refunds).
      href: draftId ? `/admin/wallet-management?tab=events&event=${encodeURIComponent(draftId)}` : `/admin/wallet-management`,
      metadata: { orderId, organizerUid: uid, draftId: draftId ?? null, amountPaise, paymentId },
    }).catch((e: unknown) => { errors.push(`inbox: ${e instanceof Error ? e.message : 'write failed'}`) })

    await claim.set({
      status: errors.length ? 'failed' : 'sent', errors, finishedAt: FieldValue.serverTimestamp(),
      // What was attempted, for follow-up (addresses only — no content).
      sent: { organizer: emailOn && !!userEmail, admins: adminRecipients.length, inbox: !errors.some(e => e.startsWith('inbox')) },
    }, { merge: true })
    return errors.length ? 'failed' : 'sent'
  } catch (err) {
    console.error('[service-purchase] notification failed', { orderId, err })
    return 'failed'
  }
}

/**
 * How settlement paths trigger it: after the response (Next's after()) inside a request; outside a
 * request scope (scripts, direct handler calls) after() throws, so it runs fire-and-forget instead.
 * Either way the claim above guarantees at most one send per order.
 */
export function scheduleServicePurchaseNotification(orderId: string): void {
  try { after(() => notifyServicePurchase(orderId)) }
  catch { void notifyServicePurchase(orderId) }
}
