'use client'

// Legacy communication balance — READ-ONLY (RD-COMMS-P1).
//
// This card used to show the "Communication balance" with a funding button and a payment
// dialog. Communication capacity is now bought ONLY per event on License & Services, and the
// top-up route is retired (410). An organizer's existing balance is real money in controlled drain:
// it keeps paying for WhatsApp messages an event's capacity does not cover until it reaches ₹0.
//
// So this card is informational only: it renders NOTHING when the balance is zero (or unknown),
// and otherwise states the legacy balance with no purchase control of any kind.

import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { useAuth } from '@/components/auth/AuthProvider'
import { Card } from '@/components/ui'
import type { WalletOverview } from '@/lib/wallet/types'

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function CommunicationBalanceCard() {
  const [balancePaise, setBalancePaise] = useState<number | null>(null)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) return
    let alive = true
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!token) return
        const r = await fetch('/api/organizer/wallet/overview', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        const data = await r.json().catch(() => null) as { success?: boolean; overview?: WalletOverview } | null
        if (alive && data?.success && data.overview) setBalancePaise(data.overview.balancePaise)
      } catch { /* informational only — show nothing */ }
    })()
    return () => { alive = false }
  }, [user])

  if (balancePaise === null || balancePaise <= 0) return null
  return (
    <Card variant="elevated" padded={false} className="flex items-start gap-3 p-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground" aria-hidden>
        <History className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-foreground">Legacy communication balance · {rupees(balancePaise)}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Existing balance added before capacity-based billing. New funds cannot be added —
          communication capacity is purchased per event in License &amp; Services.
        </p>
      </div>
    </Card>
  )
}
