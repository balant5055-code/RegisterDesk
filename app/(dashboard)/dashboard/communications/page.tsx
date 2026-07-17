'use client'

// Communication Center (RD-COM-01) — ONE tabbed hub that CONSOLIDATES every
// communication surface. Pure orchestration: it embeds the existing feature
// components (Messages = the unified Communication Center, Broadcasts = the
// Broadcast composer/history, Reminders = the Reminder Center) and composes the
// existing endpoints for the new Overview / Templates / Analytics / Billing views.
// No runtime, storage, or communication logic is changed here.

import { Suspense, useState } from 'react'
import { cn } from '@/lib/utils/cn'
import { Radio } from 'lucide-react'
import { CommOverview, CommAnalytics, CommBilling, TemplateCenter } from '@/components/communications/CommTabs'
import MessagesView from './notifications/page'
import { BroadcastsClient } from './broadcasts/BroadcastsClient'
import RemindersView from './reminders/page'

type Tab = 'overview' | 'messages' | 'broadcasts' | 'reminders' | 'templates' | 'analytics' | 'billing'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'messages',   label: 'Messages' },
  { key: 'broadcasts', label: 'Broadcasts' },
  { key: 'reminders',  label: 'Reminders' },
  { key: 'templates',  label: 'Templates' },
  { key: 'analytics',  label: 'Analytics' },
  { key: 'billing',    label: 'Billing' },
]

export default function CommunicationCenter() {
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><Radio className="size-5" /></div>
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Communication Center</h1>
          <p className="text-[13.5px] text-muted-foreground">Messages, broadcasts, reminders, templates, analytics, and billing — all in one place.</p>
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
      {tab === 'billing'    && <CommBilling />}
    </div>
  )
}
