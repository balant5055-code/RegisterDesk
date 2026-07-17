'use client'

import { Suspense, useEffect, useState } from 'react'
import Link                              from 'next/link'
import { onAuthStateChanged }            from 'firebase/auth'
import { auth }                          from '@/lib/firebase/auth'
import { ExternalLink, Heart, Loader2 }  from 'lucide-react'
import { DashboardCard }                 from '@/components/dashboard/DashboardCard'
import { Skeleton }                      from '@/components/dashboard/Skeleton'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CampaignSummary {
  slug:             string
  title:            string
  status:           string
  totalRaisedRupees: number
  donorCount:       number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtINR(rupees: number): string {
  if (rupees >= 10_00_000) return `₹${(rupees / 10_00_000).toFixed(1)}L`
  if (rupees >= 1_000)     return `₹${(rupees / 1_000).toFixed(1)}K`
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`
}

const STATUS_COLOR: Record<string, string> = {
  active:    'bg-green-100 text-green-700',
  paused:    'bg-yellow-100 text-yellow-700',
  ended:     'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
}

// ─── Content ─────────────────────────────────────────────────────────────────

function CampaignsContent() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) return
      try {
        const token = await user.getIdToken()
        const res   = await fetch('/api/organizer/campaigns', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load')
        setCampaigns(await res.json() as CampaignSummary[])
      } catch {
        setError('Could not load your campaigns.')
      }
    })
    return unsub
  }, [])

  if (!campaigns && !error) {
    return (
      <div className="space-y-3 p-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[15px] font-semibold text-foreground">{error}</p>
      </div>
    )
  }

  if (!campaigns || campaigns.length === 0) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-orange-50">
          <Heart className="size-8 text-orange-400" aria-hidden />
        </div>
        <div>
          <p className="text-[16px] font-semibold text-foreground">No campaigns yet</p>
          <p className="mt-1 text-[14px] text-muted-foreground">
            Create your first fundraising campaign to start collecting donations.
          </p>
        </div>
        <Link
          href="/causes/new"
          className="rounded-xl bg-orange-500 px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-orange-600"
        >
          Create Campaign
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground sm:text-2xl">My Campaigns</h1>
          <p className="mt-0.5 text-[14px] text-muted-foreground">
            {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <DashboardCard title="My Campaigns">
        <ul className="divide-y divide-border">
          {campaigns.map(c => (
            <li key={c.slug} className="flex items-center gap-4 px-5 py-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-orange-50">
                <Heart className="size-5 text-orange-500" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{c.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                  <span
                    className={`rounded-full px-2 py-0.5 font-semibold capitalize ${STATUS_COLOR[c.status] ?? 'bg-gray-100 text-gray-600'}`}
                  >
                    {c.status}
                  </span>
                  <span>{fmtINR(c.totalRaisedRupees)} raised</span>
                  <span>·</span>
                  <span>{c.donorCount.toLocaleString('en-IN')} donor{c.donorCount !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={`/campaign/${c.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="View public page"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
                <Link
                  href={`/dashboard/campaigns/${c.slug}`}
                  className="rounded-xl bg-orange-500 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-orange-600"
                >
                  View Analytics
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </DashboardCard>
    </div>
  )
}

export default function CampaignsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <CampaignsContent />
    </Suspense>
  )
}
