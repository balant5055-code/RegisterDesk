'use client'

// Certificate Hub — connects the organizer dashboard to the new certificate
// system (settings, templates, builder, issue/bulk, recipients). Replaces the
// legacy MVP settings form. Backend is unchanged; this only consumes existing
// APIs (plus the read-only /records list).

import { useMemo, useState } from 'react'
import { Award } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { makeCertApi } from '@/components/certificates/hub/api'
import type { HubTab } from '@/components/certificates/hub/api'
import OverviewPanel   from '@/components/certificates/hub/OverviewPanel'
import SettingsPanel   from '@/components/certificates/hub/SettingsPanel'
import TemplatesPanel  from '@/components/certificates/hub/TemplatesPanel'
import ProgramsPanel   from '@/components/certificates/hub/ProgramsPanel'
import BrandKitPanel   from '@/components/certificates/hub/BrandKitPanel'
import IssueBulkPanel  from '@/components/certificates/hub/IssueBulkPanel'
import RecipientsPanel from '@/components/certificates/hub/RecipientsPanel'

interface Props { eventId: string; token: string }

// GA-8 P1-4: the Brand Kit is persisted but not yet consumed by the certificate
// renderer, so it is withheld from v1.0 rather than advertised as working. Flip this
// to true once the render pipeline consumes the brand kit — no other change needed.
const BRANDKIT_ENABLED = false

const TABS: { id: HubTab; label: string }[] = [
  { id: 'overview',   label: 'Overview' },
  { id: 'settings',   label: 'Settings' },
  { id: 'templates',  label: 'Templates' },
  { id: 'programs',   label: 'Programs' },
  ...(BRANDKIT_ENABLED ? [{ id: 'brandkit' as HubTab, label: 'Brand Kit' }] : []),
  { id: 'issue',      label: 'Issue & Bulk' },
  { id: 'recipients', label: 'Recipients' },
]

export default function CertificatesTab({ eventId, token }: Props) {
  const [tab, setTab] = useState<HubTab>('overview')
  const api = useMemo(() => makeCertApi(eventId, token), [eventId, token])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/[0.09]">
          <Award className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <h2 className="text-[18px] font-bold text-foreground">Certificates</h2>
          <p className="text-[13px] text-muted-foreground">Design, generate, deliver, and verify certificates for this event.</p>
        </div>
      </div>

      {/* Sub-tab nav */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors',
              tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active panel — key forces a fresh mount (reload) on tab switch */}
      <div>
        {tab === 'overview'   && <OverviewPanel   key="o" api={api} onNav={setTab} />}
        {tab === 'settings'   && <SettingsPanel   key="s" api={api} />}
        {tab === 'templates'  && <TemplatesPanel  key="t" api={api} eventId={eventId} />}
        {tab === 'programs'   && <ProgramsPanel   key="p" api={api} />}
        {BRANDKIT_ENABLED && tab === 'brandkit' && <BrandKitPanel key="b" token={token} />}
        {tab === 'issue'      && <IssueBulkPanel   key="i" api={api} />}
        {tab === 'recipients' && <RecipientsPanel key="r" api={api} />}
      </div>
    </div>
  )
}
