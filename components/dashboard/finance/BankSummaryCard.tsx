'use client'

// Bank-account summary card for the Settlement Center (Phase H.5.1).
//
// Reads the existing payout profile (GET /api/organizer/payout-profile →
// PayoutProfileSummary). Account number is masked client-side (last 4). No new
// endpoint — links to the existing payout-profile page to edit.

import Link from 'next/link'
import { BadgeCheck, Clock3, Landmark, Pencil, Smartphone } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import type { PayoutProfileSummary } from '@/lib/payout/types'

function maskTail(value: string | null | undefined, visible = 4): string {
  if (!value) return '—'
  const v = value.replace(/\s+/g, '')
  if (v.length <= visible) return v
  return `•••• ${v.slice(-visible)}`
}

export function BankSummaryCard({ profile }: { profile: PayoutProfileSummary | null }) {
  const editLink = (
    <Link
      href="/dashboard/finance/payout-profile"
      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted"
    >
      <Pencil className="size-3.5" aria-hidden />
      {profile ? 'Edit' : 'Set up'}
    </Link>
  )

  return (
    <DashboardCard title="Payout account" action={editLink}>
      {!profile ? (
        <p className="px-1 py-2 text-[13.5px] text-muted-foreground">
          No payout account configured. Set one up to receive settlements.
        </p>
      ) : (
        <div className="space-y-3 px-1 py-1">
          <div className="flex items-center gap-2">
            {profile.isVerified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">
                <BadgeCheck className="size-3.5" aria-hidden /> Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[12px] font-semibold text-amber-700">
                <Clock3 className="size-3.5" aria-hidden /> Pending verification
              </span>
            )}
          </div>

          <div className="flex items-start gap-3">
            <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]')}>
              {profile.payoutMethod === 'upi'
                ? <Smartphone className="size-[17px] text-primary" aria-hidden />
                : <Landmark className="size-[17px] text-primary" aria-hidden />}
            </div>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">{profile.accountHolderName || '—'}</p>
              {profile.payoutMethod === 'upi' ? (
                <p className="mt-0.5 text-[13px] text-muted-foreground">UPI · {profile.upiId || '—'}</p>
              ) : (
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {profile.bankName || 'Bank'} · A/C {maskTail(profile.accountNumber)} · IFSC {profile.ifscCode || '—'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
