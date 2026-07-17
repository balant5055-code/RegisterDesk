'use client'

import { useEffect, useState }  from 'react'
import { onAuthStateChanged }   from 'firebase/auth'
import { auth }                 from '@/lib/firebase/auth'
import { AlertCircle, RefreshCw, Mail, MessageSquare, MessagesSquare, Activity } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { EmptyState, PageHeader } from '@/components/ui'
import {
  COMM_CHANNEL_LABELS,
  type CommunicationUsage,
  type CommChannel,
} from '@/lib/wallet/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(paise: number): string {
  if (paise === 0) return '₹0.00'
  const r = paise / 100
  return `₹${r.toFixed(2)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ─── Channel Badge ────────────────────────────────────────────────────────────

const CHANNEL_STYLES: Record<CommChannel, { icon: React.ElementType; cls: string }> = {
  email:     { icon: Mail,           cls: 'bg-sky-50   text-sky-700   border-sky-200' },
  sms:       { icon: MessageSquare,  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  whatsapp:  { icon: MessagesSquare, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
}

function ChannelBadge({ channel }: { channel: CommChannel }) {
  const { icon: Icon, cls } = CHANNEL_STYLES[channel]
  return (
    <span className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold', cls)}>
      <Icon className="size-3" />
      {COMM_CHANNEL_LABELS[channel]}
    </span>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <tr className="animate-pulse border-b border-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <td key={i} className="px-4 py-3.5">
          <div className="h-4 rounded bg-muted" style={{ width: `${55 + (i % 3) * 25}%` }} />
        </td>
      ))}
    </tr>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function UsageClient() {
  const [usage,   setUsage]   = useState<CommunicationUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  function load() {
    setLoading(true)
    setError(null)
    auth.currentUser?.getIdToken().then(token => {
      fetch('/api/organizer/wallet/usage?limit=200', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then((data: { success: boolean; usage?: CommunicationUsage[]; error?: string }) => {
          if (data.success && data.usage) setUsage(data.usage)
          else setError(data.error ?? 'Failed to load')
        })
        .catch(() => setError('Network error'))
        .finally(() => setLoading(false))
    }).catch(() => { setError('Auth error'); setLoading(false) })
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (user) load()
      else { setError('Not authenticated'); setLoading(false) }
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalCost  = usage.reduce((s, u) => s + u.costPaise, 0)
  const totalQty   = usage.reduce((s, u) => s + u.quantity,  0)

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <PageHeader
        title="Communication Usage"
        subtitle="Email, SMS, and WhatsApp usage per event and campaign."
        breadcrumb={[
          { label: 'Wallet', href: '/dashboard/wallet' },
          { label: 'Communication Usage' },
        ]}
        action={
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </button>
        }
      />

      {/* ── Summary strip ── */}
      {!loading && !error && usage.length > 0 && (
        <div className="flex flex-wrap gap-4 rounded-2xl border border-border bg-muted/30 px-5 py-4 text-[14px]">
          <div>
            <span className="font-semibold text-foreground">{totalQty.toLocaleString()}</span>
            <span className="ml-1 text-muted-foreground">messages total</span>
          </div>
          <div className="text-muted-foreground/40">·</div>
          <div>
            <span className="font-semibold text-foreground">{formatCurrency(totalCost)}</span>
            <span className="ml-1 text-muted-foreground">total cost</span>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[14px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Event', 'Channel', 'Quantity', 'Cost', 'Date'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => <RowSkeleton key={i} />)
              ) : error ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <div className="flex flex-col items-center gap-2 text-destructive">
                      <AlertCircle className="size-5" />
                      <p className="text-[14px]">{error}</p>
                    </div>
                  </td>
                </tr>
              ) : usage.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon={Activity}
                      title="No usage recorded yet"
                      description="Usage is tracked when broadcasts and transactional emails are sent."
                    />
                  </td>
                </tr>
              ) : (
                usage.map(u => (
                  <tr key={u.id} className="border-b border-border/60 transition-colors hover:bg-muted/20 last:border-0">
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-foreground">{u.eventName || '—'}</p>
                      {u.eventSlug && (
                        <p className="mt-0.5 text-[12px] text-muted-foreground">{u.eventSlug}</p>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <ChannelBadge channel={u.channel} />
                    </td>
                    <td className="px-4 py-3.5 font-semibold text-foreground">
                      {u.quantity.toLocaleString()}
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-muted-foreground">
                      {u.costPaise === 0 ? (
                        <span className="text-muted-foreground/50">—</span>
                      ) : (
                        formatCurrency(u.costPaise)
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-muted-foreground whitespace-nowrap">
                      {formatDate(u.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  )
}
