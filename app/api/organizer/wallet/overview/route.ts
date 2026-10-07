// GET /api/organizer/wallet/overview
// Returns wallet balance + communication usage summary for the current month.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import { getWalletBalance }          from '@/lib/firebase/firestore/wallet'
import type { WalletOverview }       from '@/lib/wallet/types'
import { AggregateField }            from 'firebase-admin/firestore'

/** RD-INTEG — the start of the current India-time month / day, as an instant (India is UTC+5:30, no DST). */
const IST_MS = 330 * 60_000
function istStarts(now: Date): { month: Date; day: Date } {
  const ist = new Date(now.getTime() + IST_MS)
  return {
    month: new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS),
    day:   new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS),
  }
}

export type GetWalletOverviewResponse =
  | { success: true;  overview: WalletOverview }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetWalletOverviewResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Month boundary for "this month spend" — RD-INTEG: India time, the same boundary everywhere
  // (it was the server's local month here and the browser's local month on the Billing tab).
  const now        = new Date()
  const { month: monthStart, day: dayStart } = istStarts(now)

  // RD-INTEG — exact aggregates for the Communication Center Overview/Billing tabs, which used to
  // count a 200-row log page and sum a 500-row usage page and present the result as totals.
  const usage = adminDb.collection('communicationUsage').where('organizerUid', '==', uid)
  const logs  = adminDb.collection('emailLogs').where('organizerUid', '==', uid)
  const sumOf = (q: FirebaseFirestore.Query) => q.aggregate({ s: AggregateField.sum('costPaise') }).get()
    .then(r => Math.trunc(Number(r.data().s ?? 0))).catch(() => null)
  const countOf = (q: FirebaseFirestore.Query) => q.count().get().then(r => r.data().count).catch(() => null)
  const aggregatesP = Promise.all([
    sumOf(usage), sumOf(usage.where('channel', '==', 'email')), sumOf(usage.where('channel', '==', 'whatsapp')), sumOf(usage.where('channel', '==', 'sms')),
    countOf(logs.where('status', '==', 'queued')), countOf(logs.where('status', '==', 'sent')),
    countOf(logs.where('status', '==', 'delivered')), countOf(logs.where('status', '==', 'failed')),
    countOf(logs.where('status', '==', 'failed').where('deliveryUnknown', '==', true)),
    countOf(logs.where('createdAt', '>=', dayStart)),
  ])

  const [balancePaise, usageSnap] = await Promise.all([
    getWalletBalance(uid),
    adminDb.collection('communicationUsage')
      .where('organizerUid', '==', uid)
      .where('createdAt', '>=', monthStart)
      .get(),
  ])

  let emailsSent        = 0
  let smsSent           = 0
  let whatsappSent      = 0
  let thisMonthSpendPaise = 0

  usageSnap.docs.forEach(doc => {
    const d = doc.data() as { channel?: string; quantity?: number; costPaise?: number }
    const qty  = typeof d.quantity  === 'number' ? d.quantity  : 0
    const cost = typeof d.costPaise === 'number' ? d.costPaise : 0
    thisMonthSpendPaise += cost
    if      (d.channel === 'email')     emailsSent   += qty
    else if (d.channel === 'sms')       smsSent      += qty
    else if (d.channel === 'whatsapp')  whatsappSent += qty
  })

  const [life, spEmail, spWa, spSms, cQueued, cSent, cDelivered, cFailedAll, cUnknown, cToday] = await aggregatesP
  const overview: WalletOverview = {
    balancePaise,
    emailsSent,
    smsSent,
    whatsappSent,
    thisMonthSpendPaise,
    lifetimeSpendPaise: life,
    spendByChannelPaise: { email: spEmail, whatsapp: spWa, sms: spSms },
    messageCounts: {
      pending:   cQueued,
      // "Sent / submitted" includes delivered (a delivered message was sent).
      sent:      cSent === null || cDelivered === null ? null : cSent + cDelivered,
      delivered: cDelivered,
      // Timeouts are delivery-UNKNOWN, not failed.
      failed:    cFailedAll === null || cUnknown === null ? null : Math.max(0, cFailedAll - cUnknown),
      unknown:   cUnknown,
      today:     cToday,
    },
  }

  return NextResponse.json({ success: true, overview })
}
