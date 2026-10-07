'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth }                             from '@/lib/firebase/auth'
import { Search, Loader2, ShieldAlert }     from 'lucide-react'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  FilterTabs, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import { Card }                             from '@/components/ui'
import type { PillTone } from '@/components/admin'
import type { AdminWalletTopupItem, AdminWalletTopupsResponse } from '@/app/api/admin/wallet-topups/route'
import HeldTopupsReview from './HeldTopupsReview'

const STATUS_FILTERS = [
  { value: '',         label: 'All' },
  { value: 'credited', label: 'Credited' },
  { value: 'pending',  label: 'Pending' },
  { value: 'needs_review', label: 'Needs review' },   // RD-WALLET-W2.c — held by the stale sweep
  { value: 'abandoned', label: 'Abandoned' },         // RD-WALLET-W2.c — no payment after 7 days
  { value: 'failed',   label: 'Failed' },
]

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
}

function StatusBadge({ status, holdResolved }: { status: string; holdResolved?: boolean }) {
  // RD-WALLET-W2.f — a held order whose review a Super Admin closed (never credited automatically).
  if (status === 'needs_review' && holdResolved) return <StatusPill tone="neutral">review closed</StatusPill>
  const map: Record<string, PillTone> = {
    credited: 'success',
    pending:  'warning',
    needs_review: 'danger',
    abandoned: 'neutral',
    failed:   'danger',
  }
  return <StatusPill tone={map[status] ?? 'neutral'}>{status}</StatusPill>
}

export default function AdminWalletTopupsPage() {
  const [items,       setItems]       = useState<AdminWalletTopupItem[]>([])
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [status,      setStatus]      = useState('')
  // RD-WALLET-W2.f.1 — Super Admin only. Nothing financial (and no review queue) renders until the
  // API has answered for THIS caller; a 403 leaves only the notice below.
  const [access,      setAccess]      = useState<'checking' | 'granted' | 'denied'>('checking')
  const [denied,      setDenied]      = useState<string | null>(null)

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '25' })
      if (status)      qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)
      const res = await fetch(`/api/admin/wallet-topups?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string; code?: string } | null
        if (res.status === 403) {
          setAccess('denied')
          setDenied(b?.code === 'SUPER_ADMIN_REQUIRED' ? 'Wallet Top-ups is available to Super Admins only.' : 'You do not have access to this page.')
          setItems([]); setNextCursor(null)
          return
        }
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      setAccess('granted')
      const data = await res.json() as AdminWalletTopupsResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load top-ups')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [status])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(t)
  }, [load])

  return (
    <div className="space-y-5">
      <AdminToolbar title="Wallet Top-ups" description="Organizer communications-wallet funding via Razorpay." />

      {access === 'denied' ? (
        <Card className="flex items-center gap-3 p-6 text-[14px] text-foreground">
          <ShieldAlert className="size-5 text-destructive" aria-hidden />
          {denied}
        </Card>
      ) : (
        <>
          {access === 'granted' && <HeldTopupsReview onChanged={() => load()} />}

          <div className="flex items-center gap-1">
            <FilterTabs options={STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by status" className="w-fit" />
            <button onClick={() => load()} title="Refresh" className="ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Search className="size-3.5" /></button>
          </div>

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <TableFrame minWidth="min-w-[820px]">
            <THead>
              <Th>Created</Th>
              <Th>Organizer</Th>
              <Th align="right">Amount</Th>
              <Th>Status</Th>
              <Th>Order ID</Th>
              <Th>Payment ID</Th>
            </THead>
            <TBody>
              {loading ? (
                <TableStateRow colSpan={6}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
              ) : items.length === 0 ? (
                <TableStateRow colSpan={6}>{nextCursor ? 'No matching top-ups in the records searched so far — load more to keep searching.' : 'No top-ups found.'}</TableStateRow>
              ) : items.map(t => (
                <Tr key={t.orderId}>
                  <Td className="whitespace-nowrap text-muted-foreground">{fmtDate(t.createdAt)}</Td>
                  <Td className="text-foreground">{t.organizerName}</Td>
                  <Td align="right" className="font-medium text-foreground">{rupees(t.amountPaise)}</Td>
                  <Td><StatusBadge status={t.status} holdResolved={t.holdResolved} /></Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">{t.orderId}</Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">{t.paymentId ?? '—'}</Td>
                </Tr>
              ))}
            </TBody>
          </TableFrame>

          {nextCursor && !loading && (
            <LoadMoreButton onClick={() => load({ cursor: nextCursor })} loading={loadingMore} />
          )}
        </>
      )}
    </div>
  )
}
