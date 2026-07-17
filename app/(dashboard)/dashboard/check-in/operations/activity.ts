// OE-4 Sprint 3 — Live Operations Timeline aggregator. PURE, client-safe. This is
// ORCHESTRATION, not a new engine: it maps data ALREADY produced by existing systems
// (registrations, emailLogs via /communications, certificate records, print jobs)
// into view items. No collection, no logging, no realtime — nothing is written.

import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { CommRow } from '@/app/api/organizer/communications/route'
import type { PrintGenerationJobView } from '@/lib/printAssets/generationJob'
import type { PrintPackageJobView } from '@/lib/printAssets/packageJob'

export type ActivityCategory =
  | 'checkin' | 'registration' | 'walkin' | 'communication' | 'ticket'
  | 'badge' | 'certificate' | 'payment' | 'job'

export interface ActivityParticipant { name: string; regNumber: string; regId: string; email: string; phone: string }

export interface ActivityItem {
  id:          string
  ts:          string            // ISO
  category:    ActivityCategory
  title:       string
  source:      string            // originating subsystem
  participant?: ActivityParticipant
  operator?:   string
  status?:     string
}

export interface CertItem { certificateId?: string; id?: string; registrationId?: string; attendeeEmail?: string; status?: string; generatedAt?: string | null }

const rupees = (paise?: number) => (typeof paise === 'number' ? `₹${Math.round(paise / 100).toLocaleString('en-IN')}` : undefined)

/** Normalize a value that may be an ISO string, a serialized Firestore Timestamp, or null. */
export function tsToIso(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as { _seconds?: number; seconds?: number; toDate?: () => Date }
    if (typeof o.toDate === 'function') { try { return o.toDate().toISOString() } catch { return null } }
    const s = o._seconds ?? o.seconds
    if (typeof s === 'number') return new Date(s * 1000).toISOString()
  }
  return null
}

export interface ActivitySources {
  regs:    SerializedRegistration[]
  comms:   CommRow[]
  certs:   CertItem[]
  genJobs: PrintGenerationJobView[]   // already filtered to the event by the caller
  pkgJobs: PrintPackageJobView[]
}

/** Builds the merged, newest-first activity feed from existing data only. */
export function buildActivity(src: ActivitySources): ActivityItem[] {
  const items: ActivityItem[] = []
  const P = (r: SerializedRegistration): ActivityParticipant => ({
    name: r.attendee.name || r.attendee.email, regNumber: r.ticketCode || r.id,
    regId: r.id, email: r.attendee.email, phone: r.attendee.phone ?? '',
  })

  for (const r of src.regs) {
    const p = P(r)
    const registeredAt = tsToIso(r.registeredAt)
    if (registeredAt) {
      const walk = r.registrationSource === 'walkin'
      items.push({ id: `reg-${r.id}`, ts: registeredAt, category: walk ? 'walkin' : 'registration', title: walk ? 'Walk-in registration' : 'Registration created', participant: p, status: r.status, source: walk ? 'Walk-in' : 'Registrations' })
      if (r.paymentStatus === 'paid' && (r.amount ?? 0) > 0) {
        items.push({ id: `pay-${r.id}`, ts: registeredAt, category: 'payment', title: 'Payment completed', participant: p, status: rupees(r.amount), source: 'Payments' })
      }
    }
    if (r.checkedIn) {
      const ci = tsToIso(r.checkedInAt)
      if (ci) items.push({ id: `ci-${r.id}`, ts: ci, category: 'checkin', title: 'Checked in', participant: p, operator: r.checkedInBy, status: r.checkedInSource, source: 'Check-in' })
    }
    const refIso = tsToIso(r.refundedAt)
    if (refIso && r.paymentStatus === 'refunded') {
      items.push({ id: `ref-${r.id}`, ts: refIso, category: 'payment', title: 'Refund completed', participant: p, status: rupees(r.refundAmount ?? r.amount), source: 'Payments' })
    }
  }

  for (const c of src.comms) {
    const iso = tsToIso(c.createdAt)
    if (!iso) continue
    const nt = (c.notificationType || '').toUpperCase()
    const isWa = c.channel === 'whatsapp'
    const isTicket = nt.includes('TICKET')
    const isBroadcast = nt.includes('BROADCAST') || nt.includes('CUSTOM_EMAIL')
    const title = isTicket ? 'Ticket resent' : isBroadcast ? 'Broadcast delivered' : isWa ? 'WhatsApp sent' : 'Email sent'
    items.push({
      id: `comm-${c.id}`, ts: iso, category: isTicket ? 'ticket' : 'communication', title, status: c.status, source: 'Communications',
      participant: (c.recipientEmail || c.recipientName)
        ? { name: c.recipientName || c.recipientEmail, regNumber: '', regId: c.registrationId || '', email: c.recipientEmail || '', phone: c.recipientPhone || '' }
        : undefined,
    })
  }

  for (const cert of src.certs) {
    const iso = tsToIso(cert.generatedAt)
    if (!iso) continue
    items.push({
      id: `cert-${cert.certificateId || cert.id || iso}`, ts: iso, category: 'certificate', title: 'Certificate generated', status: cert.status, source: 'Certificates',
      participant: (cert.attendeeEmail || cert.registrationId)
        ? { name: cert.attendeeEmail || cert.registrationId || '', regNumber: '', regId: cert.registrationId || '', email: cert.attendeeEmail || '', phone: '' }
        : undefined,
    })
  }

  for (const j of src.genJobs) {
    const iso = tsToIso(j.createdAt)
    if (!iso) continue
    const failed = j.status === 'failed'
    items.push({ id: `gen-${j.jobId}`, ts: iso, category: 'badge', title: failed ? 'Badge generation failed' : `Badge generation ${j.status}`, status: `${j.counts.succeeded}/${j.counts.total}`, source: 'Print Assets' })
  }
  for (const j of src.pkgJobs) {
    const iso = tsToIso(j.createdAt)
    if (!iso) continue
    const failed = j.status === 'failed'
    items.push({ id: `pkg-${j.jobId}`, ts: iso, category: 'job', title: failed ? 'Package job failed' : `Package job ${j.status}`, status: j.output ? `${j.output.fileCount} files` : undefined, source: 'Print Assets' })
  }

  return items.filter(i => i.ts).sort((a, b) => b.ts.localeCompare(a.ts))
}

// ─── Grouping + relative time (pure; `nowMs` passed in to keep render pure) ──────
export type DayBucket = 'Today' | 'Yesterday' | 'Earlier'

export function bucketOf(iso: string, nowMs: number): DayBucket {
  const now = new Date(nowMs)
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = new Date(iso).getTime()
  if (t >= startToday) return 'Today'
  if (t >= startToday - 86_400_000) return 'Yesterday'
  return 'Earlier'
}

export function relTime(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - new Date(iso).getTime())
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
