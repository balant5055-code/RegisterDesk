// RD-WALLET-EVT-01 — how the Wallet console PRESENTS server figures. Pure: no fetch, no React.
// Everything here formats or labels a value the server already derived; nothing is computed
// from client input, and a figure the server could not read is shown as unavailable — never 0.

import type { Measured, WalletEventPhase } from '@/lib/wallet/eventWalletView'

export const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const qty = (n: number): string => n.toLocaleString('en-IN')

export const PHASE_LABEL: Record<WalletEventPhase, string> = {
  live: 'Live', upcoming: 'Upcoming', completed: 'Completed', cancelled: 'Cancelled',
}
export const PHASE_TONE: Record<WalletEventPhase, 'success' | 'info' | 'neutral' | 'danger'> = {
  live: 'success', upcoming: 'info', completed: 'neutral', cancelled: 'danger',
}

export function measuredText(m: Measured<number> | null, format: (n: number) => string, none = '—'): string {
  if (m === null) return none
  return m.ok ? format(m.value) : 'Unavailable'
}

export const SMS_NOTE = 'SMS is not currently available.'
