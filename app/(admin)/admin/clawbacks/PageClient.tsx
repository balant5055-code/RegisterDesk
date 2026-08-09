'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, X, Search, AlertTriangle } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { CLAWBACK_STATUS_LABELS, type ClawbackStatus, type ClawbackView } from '@/lib/clawbacks/types'

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`
function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const STATUS_TONE: Record<ClawbackStatus, PillTone> = {
  open:                'danger',
  partially_recovered: 'warning',
  recovered:           'success',
  waived:              'neutral',
}

function StatusBadge({ status }: { status: ClawbackStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{CLAWBACK_STATUS_LABELS[status]}</StatusPill>
}

interface HistoryEntry { action: string; actorUid: string; metadata: unknown; createdAt: string | null }

export default function AdminClawbacksPage() {
  const [items,   setItems]   = useState<ClawbackView[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [statusF, setStatusF] = useState('')
  const [orgF,    setOrgF]     = useState('')
  const [applied, setApplied] = useState({ status: '', organizer: '' })

  const [selected, setSelected] = useState<ClawbackView | null>(null)
  const [history,  setHistory]  = useState<HistoryEntry[]>([])
  const [busy,     setBusy]     = useState(false)
  const { confirm } = useConfirm()
  const { showToast } = useToast()

  const load = useCallback((f: { status: string; organizer: string }) => {
    setLoading(true); setError(null)
    ;(async () => {
      const token = await getToken()
      const qs = new URLSearchParams()
      if (f.status)    qs.set('status', f.status)
      if (f.organizer) qs.set('organizer', f.organizer.trim())
      const res = await fetch(`/api/admin/clawbacks?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      return (await res.json() as { clawbacks: ClawbackView[] }).clawbacks
    })()
      .then(setItems)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load clawbacks'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => load(applied), 0)
    return () => clearTimeout(t)
  }, [load, applied])

  const openDetail = useCallback((c: ClawbackView) => {
    setSelected(c); setHistory([])
    ;(async () => {
      const token = await getToken()
      const res = await fetch(`/api/admin/clawbacks/${c.clawbackId}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (res.ok) {
        const data = await res.json() as { clawback: ClawbackView; history: HistoryEntry[] }
        setSelected(cur => (cur && cur.clawbackId === c.clawbackId ? data.clawback : cur))
        setHistory(data.history)
      }
    })().catch(() => {})
  }, [])

  async function act(action: 'waive' | 'mark_recovered') {
    if (!selected) return
    const label = action === 'waive' ? 'Waive this clawback (write off the debt)?' : 'Mark this clawback fully recovered (collected out-of-band)?'
    if (!(await confirm({ title: action === 'waive' ? 'Waive clawback' : 'Mark recovered', message: label, tone: 'danger' }))) return
    setBusy(true)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/clawbacks/${selected.clawbackId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action }),
      })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? 'Action failed')
      setSelected(null)
      load(applied)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Action failed', 'error')
    } finally { setBusy(false) }
  }

  const totalOutstanding = items.reduce((s, c) => s + c.outstandingAmountPaise, 0)

  return (
    <div className="space-y-5">
      <AdminToolbar title="Clawbacks" description="Insolvent reversal debts — recovered automatically from future revenue, or resolved manually." />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <label className="text-[12.5px]">
          <span className="mb-1 block font-medium text-muted-foreground">Status</span>
          <select value={statusF} onChange={e => setStatusF(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-[13.5px]">
            <option value="">All</option>
            {(Object.keys(CLAWBACK_STATUS_LABELS) as ClawbackStatus[]).map(s => <option key={s} value={s}>{CLAWBACK_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="text-[12.5px]">
          <span className="mb-1 block font-medium text-muted-foreground">Organizer UID</span>
          <input value={orgF} onChange={e => setOrgF(e.target.value)} placeholder="Organizer UID" className="rounded-lg border border-border bg-background px-3 py-2 text-[13.5px]" />
        </label>
        <button onClick={() => setApplied({ status: statusF, organizer: orgF })} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90">
          <Search className="size-4" /> Search
        </button>
        <button onClick={() => { setStatusF(''); setOrgF(''); setApplied({ status: '', organizer: '' }) }} className="rounded-lg border border-border px-4 py-2 text-[13.5px] font-medium text-foreground hover:bg-muted">Clear</button>
        <span className="ml-auto text-[13px] text-muted-foreground">Outstanding (page): <strong className="text-foreground">{inr(totalOutstanding)}</strong></span>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Table */}
      <TableFrame minWidth="min-w-[920px]">
        <THead>
          <Th>Organizer</Th>
          <Th>Source</Th>
          <Th align="right">Amount</Th>
          <Th align="right">Recovered</Th>
          <Th align="right">Outstanding</Th>
          <Th>Status</Th>
          <Th>Created</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={7}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={7}>No clawbacks found.</TableStateRow>
          ) : items.map(c => (
            <Tr key={c.clawbackId} onClick={() => openDetail(c)}>
              <Td className="font-mono text-[12px] text-muted-foreground">{c.organizerUid}</Td>
              <Td className="capitalize text-muted-foreground">{c.sourceType} · <span className="text-[11px]">{c.reason}</span></Td>
              <Td align="right" className="font-semibold text-foreground">{inr(c.reversalAmountPaise)}</Td>
              <Td align="right" className="text-emerald-700">{inr(c.recoveredAmountPaise)}</Td>
              <Td align="right" className="font-semibold text-rose-700">{inr(c.outstandingAmountPaise)}</Td>
              <Td><StatusBadge status={c.status} /></Td>
              <Td className="whitespace-nowrap text-muted-foreground">{fmt(c.createdAt)}</Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setSelected(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[16px] font-semibold text-foreground"><AlertTriangle className="size-4 text-amber-500" /> Clawback</h2>
              <button onClick={() => setSelected(null)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close"><X className="size-4" /></button>
            </div>

            <dl className="space-y-3 text-[13.5px]">
              <Row label="Status"><StatusBadge status={selected.status} /></Row>
              <Row label="Organizer"><span className="font-mono text-[12px] break-all">{selected.organizerUid}</span></Row>
              <Row label="Source"><span className="capitalize">{selected.sourceType} · {selected.reason}</span> <span className="font-mono text-[11px] text-muted-foreground">{selected.sourceId}</span></Row>
              <Row label="Linked transaction"><span className="font-mono text-[12px] break-all">{selected.transactionId}</span></Row>
              <Row label="Reversal amount">{inr(selected.reversalAmountPaise)}</Row>
              <Row label="Recovered"><span className="text-emerald-700">{inr(selected.recoveredAmountPaise)}</span></Row>
              <Row label="Outstanding"><span className="font-semibold text-rose-700">{inr(selected.outstandingAmountPaise)}</span></Row>
              <Row label="Created">{fmt(selected.createdAt)}</Row>
              {selected.resolvedAt && <Row label="Resolved">{fmt(selected.resolvedAt)} {selected.resolvedBy && <span className="text-muted-foreground">by {selected.resolvedBy}</span>}</Row>}
            </dl>

            {/* History */}
            <div className="mt-5">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">History</p>
              {history.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No recorded events.</p>
              ) : (
                <ul className="space-y-2">
                  {history.map((h, i) => (
                    <li key={i} className="rounded-lg border border-border/60 px-3 py-2 text-[12.5px]">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">{h.action.replace('clawback.', '')}</span>
                        <span className="text-[11px] text-muted-foreground">{fmt(h.createdAt)}</span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">by {h.actorUid}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Actions */}
            {(selected.status === 'open' || selected.status === 'partially_recovered') && (
              <div className="mt-5 flex gap-2">
                <button disabled={busy} onClick={() => void act('mark_recovered')} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {busy && <Loader2 className="size-4 animate-spin" />} Mark Recovered
                </button>
                <button disabled={busy} onClick={() => void act('waive')} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-50">
                  Waive
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  )
}
