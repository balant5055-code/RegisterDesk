'use client'

// Communication Center (RD-COM-01) — ONE tabbed hub that CONSOLIDATES every
// communication surface. Pure orchestration: it embeds the existing feature
// components (Messages = the unified Communication Center, Broadcasts = the
// Broadcast composer/history, Reminders = the Reminder Center) and composes the
// existing endpoints for the new Overview / Templates / Analytics / Usage views.
// No runtime, storage, or communication logic is changed here.
//
// RD-COMMS-P1 — "Billing" became "Usage": a READ-ONLY, event-scoped view of the selected event's
// communication capacity. Nothing here buys anything — communication capacity is purchased only on
// the event's License & Services step. The old ?tab=billing links still land on Usage.

import { Suspense, useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { Radio } from 'lucide-react'
import { CommOverview, CommAnalytics, TemplateCenter } from '@/components/communications/CommTabs'
import { CommUsage } from '@/components/communications/CommUsage'
import { CommOptOuts } from '@/components/communications/CommOptOuts'
import MessagesView from './notifications/page'
import { BroadcastsClient } from './broadcasts/BroadcastsClient'
import RemindersView from './reminders/page'

type Tab = 'overview' | 'messages' | 'broadcasts' | 'reminders' | 'templates' | 'analytics' | 'usage' | 'optouts'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'messages',   label: 'Messages' },
  { key: 'broadcasts', label: 'Broadcasts' },
  { key: 'reminders',  label: 'Reminders' },
  { key: 'templates',  label: 'Templates' },
  { key: 'analytics',  label: 'Analytics' },
  { key: 'usage',      label: 'Usage' },
  { key: 'optouts',    label: 'Opt-outs' },   // RD-COMMS-P2-G — read-only
]

const isTab = (v: string | null): v is Tab => !!v && TABS.some(x => x.key === v)

export default function CommunicationCenter() {
  return <Suspense fallback={null}><CommunicationCenterInner /></Suspense>
}

function CommunicationCenterInner() {
  // RD-INTEG — the URL IS the tab. ?tab=usage (lib/wallet/communicationBalance) opens Usage; the
  // retired ?tab=billing is an alias for it (RD-COMMS-P1). The tab used to be read once on
  // mount, so a ?tab= link followed while already on this page (an event Wallet "Communication
  // balance" link, the Back button) changed the URL but not the tab, and clicking a tab never
  // updated the URL (no shareable / reload-safe tab).
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const rawTab = searchParams.get('tab')
  const requested = rawTab === 'billing' ? 'usage' : rawTab
  const tab: Tab = isTab(requested) ? requested : 'overview'
  const setTab = useCallback((next: Tab) => {
    const p = new URLSearchParams(searchParams.toString())
    if (next === 'overview') p.delete('tab'); else p.set('tab', next)
    const qs = p.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [router, pathname, searchParams])

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><Radio className="size-5" /></div>
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Communication Center</h1>
          <p className="text-[13.5px] text-muted-foreground">Messages, broadcasts, reminders, templates, analytics and usage — all in one place.</p>
        </div>
      </div>

      <div className="flex gap-4 overflow-x-auto border-b border-border">
        {TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={cn('-mb-px shrink-0 border-b-2 px-1 py-2 text-[13.5px] font-semibold transition-colors',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Only the active tab renders, so each feature fetches on demand (no N+1). */}
      {tab === 'overview'   && <CommOverview />}
      {tab === 'messages'   && <Suspense fallback={null}><MessagesView /></Suspense>}
      {tab === 'broadcasts' && <Suspense fallback={null}><BroadcastsClient /></Suspense>}
      {tab === 'reminders'  && <Suspense fallback={null}><RemindersView /></Suspense>}
      {tab === 'templates'  && <TemplateCenter />}
      {tab === 'analytics'  && <CommAnalytics />}
      {tab === 'usage'      && <CommUsage />}
      {tab === 'optouts'    && <CommOptOuts />}
    </div>
  )
}
