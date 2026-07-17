// Unit verification for the Wallet Ledger & Transaction Explorer (Phase H.5.2).
//
// Covers the pure metadata module (txnMeta) that drives rendering across both the
// revenue ledger and the communication wallet. The page/components reuse existing
// endpoints and are validated by tsc/eslint/next build + manual QA.
//
// Run: npx tsx scripts/verify-wallet-ledger.ts   (exits non-zero on failure)

import {
  FINANCE_TXN_STATUSES, financeTxnStatusMeta, financeTxnTypeLabel,
  TXN_FILTERS, isWalletCredit, walletTxnTypeLabel, walletTxnStatusMeta,
  COMM_CHANNELS, channelMeta, txnDeepLink,
} from '@/lib/finance/txnMeta'
import { WALLET_TXN_TYPE_LABELS } from '@/lib/wallet/types'
import type { WalletTxnType, WalletTxnStatus } from '@/lib/wallet/types'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log('── finance ledger status ──')
for (const s of ['completed', 'pending', 'refunded', 'disputed', 'backfilled']) {
  const m = financeTxnStatusMeta(s)
  check(`'${s}' → label+class`, m.label.length > 0 && m.badgeClass.includes('bg-'))
}
check('5 finance statuses', FINANCE_TXN_STATUSES.length === 5)
check('unknown finance status falls back', financeTxnStatusMeta('zzz').badgeClass.includes('muted'))

console.log('── finance txn type labels ──')
check('event_registration → Ticket', financeTxnTypeLabel('event_registration') === 'Ticket')
check('donation → Donation',         financeTxnTypeLabel('donation') === 'Donation')
check('unknown type title-cased',    financeTxnTypeLabel('some_new_type') === 'Some New Type')

console.log('── explorer filters ──')
check('4 filters', TXN_FILTERS.length === 4)
check('filters are all/tickets/donations/refunds', TXN_FILTERS.map(f => f.key).join(',') === 'all,tickets,donations,refunds')

console.log('── comms wallet txn ──')
check('fund_added is credit',   isWalletCredit('fund_added'))
check('refund is credit',       isWalletCredit('refund'))
check('email_charge is debit',  !isWalletCredit('email_charge'))
check('sms_charge is debit',    !isWalletCredit('sms_charge'))
check('license_charge is debit', !isWalletCredit('license_charge'))
for (const t of Object.keys(WALLET_TXN_TYPE_LABELS) as WalletTxnType[]) {
  check(`wallet type '${t}' has a label`, walletTxnTypeLabel(t).length > 0)
}
for (const s of ['completed', 'pending', 'failed'] as WalletTxnStatus[]) {
  const m = walletTxnStatusMeta(s)
  check(`wallet status '${s}' → label+class`, m.label.length > 0 && m.badgeClass.includes('border-'))
}

console.log('── comms channels ──')
check('3 channels', COMM_CHANNELS.length === 3)
for (const c of ['email', 'sms', 'whatsapp']) {
  const m = channelMeta(c)
  check(`channel '${c}' → label+icon+class`, m.label.length > 0 && m.iconKey.length > 0 && m.badgeClass.includes('bg-'))
}

console.log('── deep-links (reuse-only) ──')
check('campaign deep-links',      txnDeepLink('campaign', 'my-cause') === '/dashboard/campaigns/my-cause')
check('event does NOT deep-link', txnDeepLink('event', 'my-event') === null)
check('empty entity → null',      txnDeepLink('campaign', '') === null)

console.log('')
if (failures > 0) { console.error(`❌ ${failures} assertion(s) FAILED`); process.exit(1) }
console.log('✅ All Wallet Ledger assertions passed')
