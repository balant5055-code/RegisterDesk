// RD-CLOSE · READ-ONLY report of WhatsApp broadcasts charged BEFORE billing settlement existed.
//
//   npx tsx scripts/report-legacy-broadcast-charges.ts            # report only — WRITES NOTHING
//   npx tsx scripts/report-legacy-broadcast-charges.ts --json     # same, machine-readable
//
// ═══ WHY ═════════════════════════════════════════════════════════════════════
// Until 2026-10-05 a WhatsApp broadcast was charged for EVERY recipient up front and never
// trued up. The approved rule is now "charge on Meta accept": a campaign that ends is settled and
// the share for recipients WhatsApp never accepted is returned (lib/communications/billing.ts
// settleBroadcastBilling). Campaigns that ENDED before the change carry no `billingSettlement`
// field and were never settled, so their charge may exceed what the new rule would have billed.
//
// This script only MEASURES that gap per campaign: charged units/amount (the immutable
// walletTransactions/broadcast_<id> row, or the prepaid usage record), the accepted count (the
// job's `sent` flags), and the difference. It never credits, refunds, or edits anything — any
// remediation of historical money needs an explicit product/finance decision first.

import { adminDb } from '@/lib/firebase/admin'

const JSON_OUT = process.argv.includes('--json')
const TERMINAL = ['sent', 'partial', 'failed', 'cancelled']

interface Row {
  campaignId: string; organizerUid: string; eventSlug: string; status: string; fundedBy: string
  chargedUnits: number | null; chargedPaise: number | null; acceptedUnits: number | null
  overchargedUnits: number | null; overchargedPaise: number | null; note?: string
}

async function main() {
  const rows: Row[] = []
  let scanned = 0, settled = 0
  for (const status of TERMINAL) {
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
    for (;;) {
      let q = adminDb.collection('broadcastCampaigns').where('channel', '==', 'whatsapp').where('status', '==', status)
        .orderBy('__name__').limit(200)
      if (last) q = q.startAfter(last)
      const snap = await q.get()
      if (snap.empty) break
      for (const doc of snap.docs) {
        scanned++
        const c = doc.data() as Record<string, unknown>
        if (c.billingSettlement === 'settled' || c.billingSettledAt) { settled++; continue }
        const charge = await adminDb.doc(`walletTransactions/broadcast_${doc.id}`).get()
        const ch = charge.exists ? charge.data() as { amountPaise?: number; metadata?: { units?: number } } : null
        const chargedUnits = ch ? Math.floor(ch.metadata?.units ?? 0) : (typeof c.allowanceUnits === 'number' ? c.allowanceUnits : null)
        const chargedPaise = ch ? Math.round(ch.amountPaise ?? 0) : 0
        const jobId = typeof c.whatsappJobId === 'string' ? c.whatsappJobId : null
        const acceptedUnits = jobId
          ? (await adminDb.collection('whatsappBroadcastJobs').doc(jobId).collection('recipients').where('sent', '==', true).count().get()).data().count
          : (chargedUnits !== null ? 0 : null)
        const over = chargedUnits !== null && acceptedUnits !== null ? Math.max(0, chargedUnits - acceptedUnits) : null
        rows.push({
          campaignId: doc.id, organizerUid: String(c.organizerUid ?? ''), eventSlug: String(c.eventSlug ?? ''), status,
          fundedBy: ch ? 'wallet' : c.fundedBy === 'prepaid_allowance' ? 'prepaid_allowance' : 'none',
          chargedUnits, chargedPaise, acceptedUnits, overchargedUnits: over,
          overchargedPaise: over !== null && chargedUnits ? Math.round((chargedPaise * over) / chargedUnits) : null,
          ...(jobId ? {} : { note: 'no job (ended before any recipient was snapshotted)' }),
        })
      }
      last = snap.docs[snap.docs.length - 1]
      if (snap.size < 200) break
    }
  }
  const affected = rows.filter(r => (r.overchargedUnits ?? 0) > 0)
  const totals = {
    scanned, alreadySettled: settled, unsettledLegacy: rows.length, withGap: affected.length,
    gapUnits: affected.reduce((n, r) => n + (r.overchargedUnits ?? 0), 0),
    gapPaise: affected.reduce((n, r) => n + (r.overchargedPaise ?? 0), 0),
  }
  if (JSON_OUT) { console.log(JSON.stringify({ totals, rows: affected }, null, 2)); return }
  console.log('Legacy WhatsApp broadcast charges (READ-ONLY — nothing was written)')
  console.table(affected)
  console.log(totals)
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
