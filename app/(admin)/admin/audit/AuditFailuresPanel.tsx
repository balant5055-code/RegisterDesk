'use client'

// RD-PHASE4-S4 closeout — failed audit writes (adminAuditFailures), Super Admin only (the server
// decides; a plain admin sees the 403 message). Each row is an action whose money already moved but
// whose audit row could not be written. Reconcile by REPLAYING the stored audit copy, or — only when
// the server finds the original row after all — by marking it present. Both need a reason and are
// themselves audited. Nothing here touches money.

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2 } from 'lucide-react'
import {
  StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import type {
  AuditFailureItem, AuditFailureListResponse, AuditFailureDetailResponse, AuditFailureStatusFilter,
} from '@/lib/admin/auditFailureTypes'

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  const token = await u.getIdToken()
  return fetch(url, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` }, cache: 'no-store' })
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

export function AuditFailuresPanel() {
  const { prompt } = useConfirm()
  const { showToast } = useToast()
  const [status, setStatus]   = useState<AuditFailureStatusFilter>('open')
  const [entityId, setEntityId] = useState('')
  const [items, setItems]     = useState<AuditFailureItem[]>([])
  const [cursor, setCursor]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [busy, setBusy]       = useState<string | null>(null)
  const [matches, setMatches] = useState<Record<string, number>>({})

  const load = useCallback(async (from: string | null) => {
    setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams({ status, ...(entityId.trim() ? { entityId: entityId.trim() } : {}), ...(from ? { cursor: from } : {}) })
      const res = await authedFetch(`/api/admin/audit-failures?${qs.toString()}`)
      const body = await res.json().catch(() => ({})) as Partial<AuditFailureListResponse> & { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setItems(prev => (from ? [...prev, ...(body.items ?? [])] : (body.items ?? [])))
      setCursor(body.nextCursor ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally { setLoading(false) }
  }, [status, entityId])

  // Deferred a tick, like the audit log above (no synchronous setState inside the effect).
  useEffect(() => {
    const t = setTimeout(() => { void load(null) }, 0)
    return () => clearTimeout(t)
  }, [load])

  async function check(id: string) {
    setBusy(id)
    try {
      const res = await authedFetch(`/api/admin/audit-failures/${encodeURIComponent(id)}`)
      const body = await res.json().catch(() => ({})) as Partial<AuditFailureDetailResponse> & { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setMatches(m => ({ ...m, [id]: body.existingMatches?.length ?? 0 }))
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Check failed', 'error')
    } finally { setBusy(null) }
  }

  async function reconcile(id: string, action: 'replay' | 'mark_present') {
    const reason = (await prompt({
      title: 'Reason required',
      message: action === 'replay' ? 'Reason for replaying this missing audit row:' : 'Reason for marking the original audit row as present:',
      required: true,
    }))?.trim()
    if (!reason) return
    setBusy(id)
    try {
      const res = await authedFetch(`/api/admin/audit-failures/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, reason }),
      })
      const body = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      showToast(action === 'replay' ? 'Audit row replayed.' : 'Marked as present.', 'success')
      void load(null)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Reconciliation failed', 'error')
    } finally { setBusy(null) }
  }

  const inputCls = 'rounded-lg border border-border bg-background px-3 py-2 text-[13.5px]'

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Failed audit writes</h2>
          <p className="text-[12.5px] text-muted-foreground">
            Actions whose money already moved but whose audit row could not be written. Super Admin only.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value as AuditFailureStatusFilter)} className={inputCls}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
          <input aria-label="Entity ID" value={entityId} onChange={e => setEntityId(e.target.value)} placeholder="Entity ID" className={inputCls} />
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <TableFrame minWidth="min-w-[860px]">
        <THead>
          <Th>Recorded</Th>
          <Th>Action</Th>
          <Th>Entity</Th>
          <Th>Error</Th>
          <Th>Status</Th>
          <Th>Reconcile</Th>
        </THead>
        <TBody>
          {loading && items.length === 0 ? (
            <TableStateRow colSpan={6}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={6}>No failed audit writes.</TableStateRow>
          ) : items.map(it => (
            <Tr key={it.id}>
              <Td className="whitespace-nowrap text-muted-foreground">{fmt(it.createdAt)}</Td>
              <Td className="font-mono text-[12px]">{it.audit.action}</Td>
              <Td className="font-mono text-[12px] text-muted-foreground">{it.audit.entityType}/{it.audit.entityId}</Td>
              <Td className="text-muted-foreground"><span className="line-clamp-2" title={it.error}>{it.error}</span></Td>
              <Td>
                <StatusPill className="normal-case">
                  {it.status === 'open' ? 'open' : `resolved · ${it.resolution?.kind ?? ''}`}
                </StatusPill>
              </Td>
              <Td>
                {it.status === 'open' ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button disabled={busy === it.id} onClick={() => void reconcile(it.id, 'replay')}
                      className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                      Replay
                    </button>
                    {matches[it.id] === undefined ? (
                      <button disabled={busy === it.id} onClick={() => void check(it.id)}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
                        Check for original
                      </button>
                    ) : matches[it.id] > 0 ? (
                      <button disabled={busy === it.id} onClick={() => void reconcile(it.id, 'mark_present')}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-50">
                        Mark present ({matches[it.id]})
                      </button>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">No original found</span>
                    )}
                  </div>
                ) : (
                  <span className="text-[12px] text-muted-foreground" title={it.resolution?.reason}>
                    {fmt(it.resolution?.at ?? null)}
                  </span>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>

      {cursor && !loading && <LoadMoreButton onClick={() => void load(cursor)} loading={loading} />}
    </section>
  )
}
