'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth }                             from '@/lib/firebase/auth'
import { cn }                               from '@/lib/utils/cn'
import { Loader2, X, Search }               from 'lucide-react'
import { IconButton }                       from '@/components/ui'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@/lib/admin/auditConstants'
import type { AdminAuditAction }            from '@/lib/admin/auditConstants'
import type { AuditLogItem, AuditLogResponse } from '@/lib/admin/auditViewerTypes'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

type Category = 'finance' | 'moderation' | 'organizer' | 'report' | 'unknown'

function categoryOf(action: string): Category {
  if (action.startsWith('settlement.') || action.startsWith('finance.') || action.startsWith('payout_profile.') || action.startsWith('failed_refund.')) return 'finance'
  if (action.startsWith('event.') || action.startsWith('campaign.')) return 'moderation'
  if (action.startsWith('organizer.')) return 'organizer'
  if (action.startsWith('report.')) return 'report'
  return 'unknown'
}

const CATEGORY_CLASS: Record<Category, string> = {
  finance:    'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  moderation: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  organizer:  'bg-blue-50 text-blue-700 ring-blue-600/20',
  report:     'bg-purple-50 text-purple-700 ring-purple-600/20',
  unknown:    'bg-muted text-muted-foreground ring-border',
}

function ActionBadge({ action }: { action: string }) {
  // Preserves the per-category colour map and the non-capitalised action string
  // (className overrides the pill's default tone + capitalize via tailwind-merge).
  return (
    <StatusPill className={cn('normal-case', CATEGORY_CLASS[categoryOf(action)])}>
      {action}
    </StatusPill>
  )
}

function summarize(item: AuditLogItem): string {
  const m = item.metadata
  if (!m) return '—'
  const parts: string[] = []
  if (typeof m.oldStatus === 'string' && typeof m.newStatus === 'string') parts.push(`${m.oldStatus} → ${m.newStatus}`)
  if (typeof m.reason === 'string' && m.reason) parts.push(m.reason)
  if (typeof m.resolution === 'string' && m.resolution) parts.push(m.resolution)
  if (typeof m.amountPaise === 'number') parts.push(`₹${(m.amountPaise / 100).toLocaleString('en-IN')}`)
  if (typeof m.targetType === 'string' && typeof m.targetId === 'string') parts.push(`${m.targetType}:${m.targetId}`)
  return parts.length ? parts.join(' · ') : '—'
}

// ─── Filters state ──────────────────────────────────────────────────────────

interface FilterState {
  action:     string
  entityType: string
  adminUid:   string
  entityId:   string
  startDate:  string
  endDate:    string
}

const EMPTY_FILTERS: FilterState = { action: '', entityType: '', adminUid: '', entityId: '', startDate: '', endDate: '' }

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminAuditPage() {
  const [draft,   setDraft]   = useState<FilterState>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<FilterState>(EMPTY_FILTERS)

  const [items,       setItems]       = useState<AuditLogItem[]>([])
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [selected,    setSelected]    = useState<AuditLogItem | null>(null)

  const load = useCallback(async (f: FilterState, opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '50' })
      if (f.action)     qs.set('action', f.action)
      if (f.entityType) qs.set('entityType', f.entityType)
      if (f.adminUid)   qs.set('adminUid', f.adminUid.trim())
      if (f.entityId)   qs.set('entityId', f.entityId.trim())
      if (f.startDate)  qs.set('startDate', `${f.startDate}T00:00:00`)
      if (f.endDate)    qs.set('endDate', `${f.endDate}T23:59:59`)
      if (opts.cursor)  qs.set('cursor', opts.cursor)

      const res = await fetch(`/api/admin/audit-logs?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as AuditLogResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit logs')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [])

  // Initial + on-applied-filters load. Deferred via a timer so the fetch's
  // setState calls don't run synchronously inside the effect body.
  useEffect(() => {
    const t = setTimeout(() => { void load(applied) }, 0)
    return () => clearTimeout(t)
  }, [load, applied])

  function openDetail(item: AuditLogItem) {
    setSelected(item)
    // Refresh from the canonical record (server detail endpoint).
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`/api/admin/audit-logs/${item.id}`, {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (res.ok) {
          const data = await res.json() as { log: AuditLogItem }
          setSelected(cur => (cur && cur.id === item.id ? data.log : cur))
        }
      } catch { /* keep the row data */ }
    })()
  }

  return (
    <div className="space-y-5">
      <AdminToolbar title="Audit Log" description="Searchable trail of every admin action. Newest first." />

      {/* Filters */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Action">
          <select value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })} className={selectCls}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a: AdminAuditAction) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Entity type">
          <select value={draft.entityType} onChange={e => setDraft({ ...draft, entityType: e.target.value })} className={selectCls}>
            <option value="">All types</option>
            {AUDIT_ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Admin UID">
          <input value={draft.adminUid} onChange={e => setDraft({ ...draft, adminUid: e.target.value })} placeholder="Admin UID" className={inputCls} />
        </Field>
        <Field label="Entity ID">
          <input value={draft.entityId} onChange={e => setDraft({ ...draft, entityId: e.target.value })} placeholder="Entity ID (slug / uid)" className={inputCls} />
        </Field>
        <Field label="From">
          <input type="date" value={draft.startDate} onChange={e => setDraft({ ...draft, startDate: e.target.value })} className={inputCls} />
        </Field>
        <Field label="To">
          <input type="date" value={draft.endDate} onChange={e => setDraft({ ...draft, endDate: e.target.value })} className={inputCls} />
        </Field>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
          <button
            onClick={() => setApplied({ ...draft })}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
          >
            <Search className="size-4" /> Search
          </button>
          <button
            onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS) }}
            className="rounded-lg border border-border px-4 py-2 text-[13.5px] font-medium text-foreground hover:bg-muted"
          >
            Clear
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Table */}
      <TableFrame minWidth="min-w-[860px]">
        <THead>
          <Th>Time</Th>
          <Th>Admin</Th>
          <Th>Action</Th>
          <Th>Entity type</Th>
          <Th>Entity ID</Th>
          <Th>Summary</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={6}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={6}>No audit entries found.</TableStateRow>
          ) : items.map(item => (
            <Tr key={item.id} onClick={() => openDetail(item)}>
              <Td className="whitespace-nowrap text-muted-foreground">{fmtTime(item.createdAt)}</Td>
              <Td className="font-mono text-[12px] text-muted-foreground">{item.adminUid || '—'}</Td>
              <Td><ActionBadge action={item.action} /></Td>
              <Td className="capitalize text-muted-foreground">{item.entityType}</Td>
              <Td className="font-mono text-[12px] text-muted-foreground">{item.entityId || '—'}</Td>
              <Td className="text-muted-foreground"><span className="line-clamp-1">{summarize(item)}</span></Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>

      {nextCursor && !loading && (
        <LoadMoreButton onClick={() => load(applied, { cursor: nextCursor })} loading={loadingMore} />
      )}

      {selected && <AuditDetailDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

// ─── Detail drawer ──────────────────────────────────────────────────────────

function AuditDetailDrawer({ item, onClose }: { item: AuditLogItem; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-foreground">Audit entry</h2>
          <IconButton onClick={onClose} aria-label="Close"><X className="size-4" /></IconButton>
        </div>

        <dl className="space-y-3 text-[13.5px]">
          <Row label="Timestamp" value={fmtTime(item.createdAt)} />
          <Row label="Admin UID" value={item.adminUid || '—'} mono />
          <div>
            <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Action</dt>
            <dd className="mt-1"><ActionBadge action={item.action} /></dd>
          </div>
          <Row label="Entity type" value={item.entityType} />
          <Row label="Entity ID" value={item.entityId || '—'} mono />
          <div>
            <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Metadata</dt>
            <dd className="mt-1">
              <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[12px] text-foreground">
                {item.metadata ? JSON.stringify(item.metadata, null, 2) : '— no metadata —'}
              </pre>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

// ─── Small UI bits ──────────────────────────────────────────────────────────

const inputCls  = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary'
const selectCls = inputCls

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-foreground', mono && 'font-mono text-[12px] break-all')}>{value}</dd>
    </div>
  )
}
