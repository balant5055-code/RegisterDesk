'use client'

import { useCallback, useEffect, useState } from 'react'
import Link                                 from 'next/link'
import { auth }                             from '@/lib/firebase/auth'
import { cn }                               from '@/lib/utils/cn'
import { Loader2, X, ShieldOff, ShieldCheck, Ban, Eye, LayoutGrid, Trash2 } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { DeleteOrganizerDialog } from '@/components/admin/DeleteOrganizerDialog'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  SearchInput, FilterTabs, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import type {
  AccountStatus,
  AdminOrganizerSummary,
  AdminOrganizersListResponse,
  AdminOrganizerDetail,
} from '@/lib/admin/organizerTypes'
import {
  fmtSafeDate, rupees, walletAmountLabel, payoutLabel, emailVerificationLabel,
  PENDING_VERIFICATION_LABEL, WITHHELD,
} from '@/lib/admin/organizerDisplay'

// Organizer visibility (Option A) · "All" is every organizer, pending signups included —
// each is badged "Pending verification" rather than hidden, so the list matches the
// organizer count the admin stats report. "Pending" still narrows to just those signups.
const STATUS_FILTERS: { value: '' | AccountStatus; label: string }[] = [
  { value: '',          label: 'All' },
  { value: 'active',    label: 'Active' },
  { value: 'pending',   label: 'Pending' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'banned',    label: 'Banned' },
]

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

// absent or unparseable timestamps read '—' (never "Invalid Date")
function fmtDate(iso: string | null): string {
  return fmtSafeDate(iso)
}

const STATUS_TONE: Record<AccountStatus, PillTone> = {
  active:    'success',
  // Neutral, not a warning: an unverified signup is an ordinary state on the way in,
  // not something an admin has to act on.
  pending:   'neutral',
  suspended: 'warning',
  banned:    'danger',
}

function StatusBadge({ status, pendingVerification, statusRecorded }: {
  status: AccountStatus; pendingVerification?: boolean; statusRecorded?: boolean
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>
      {pendingVerification && <StatusPill tone="warning">{PENDING_VERIFICATION_LABEL}</StatusPill>}
      {/* legacy record: no accountStatus stored, effective status shown */}
      {statusRecorded === false && <span className="text-[11px] text-muted-foreground" title="This profile records no account status; it is treated as active.">no status recorded</span>}
    </span>
  )
}

export default function AdminOrganizersPage() {
  const [items,      setItems]      = useState<AdminOrganizerSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | AccountStatus>('')

  const [busyUid, setBusyUid] = useState<string | null>(null)
  const [detailUid, setDetailUid] = useState<string | null>(null)
  // The row being considered for deletion. Held as the whole row, not just the uid, so the
  // dialog can name the organizer immediately instead of flashing placeholders while it loads.
  const [deleteTarget, setDeleteTarget] = useState<AdminOrganizerSummary | null>(null)
  const { confirm, prompt } = useConfirm()

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '25' })
      if (search) qs.set('search', search)
      if (status) qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)

      const res = await fetch(`/api/admin/organizers?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as AdminOrganizersListResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load organizers')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [search, status])

  // Reload from the start whenever filters change (debounced for search).
  useEffect(() => {
    const t = setTimeout(() => { void load() }, 300)
    return () => clearTimeout(t)
  }, [load])

  async function moderate(uid: string, action: 'suspend' | 'reactivate' | 'ban') {
    let reason = ''
    if (action !== 'reactivate') {
      reason = (await prompt({ title: `${action[0].toUpperCase()}${action.slice(1)} organizer`, message: `Reason for ${action}:`, required: true, tone: 'danger' }))?.trim() ?? ''
      if (!reason) return  // cancelled or empty
    } else if (!(await confirm({ title: 'Reactivate organizer', message: 'Reactivate this organizer?' }))) {
      return
    }

    setBusyUid(uid)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/organizers/${uid}`, {
        method:  'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ action, reason }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as { uid: string; accountStatus: AccountStatus }
      setItems(prev => prev.map(i => i.uid === uid
        ? { ...i, accountStatus: data.accountStatus, statusReason: reason || null }
        : i,
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyUid(null)
    }
  }

  return (
    <div className="space-y-5">
      <AdminToolbar title="Organizers" description="Review and moderate organizer accounts." />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, email, organization…"
          className="max-w-xs flex-1"
        />
        <FilterTabs
          options={STATUS_FILTERS}
          value={status}
          onChange={setStatus}
          aria-label="Filter by account status"
        />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Table */}
      <TableFrame minWidth="min-w-[760px]">
        <THead>
          <Th>Name</Th>
          <Th>Email</Th>
          <Th>Organization</Th>
          <Th>Status</Th>
          <Th>Created</Th>
          <Th align="right">Actions</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={6}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={6}>No organizers found.</TableStateRow>
          ) : items.map(o => {
            const busy = busyUid === o.uid
            return (
              <Tr key={o.uid}>
                <Td className="font-medium text-foreground">{o.name || '—'}</Td>
                <Td className="text-muted-foreground">{o.email || '—'}</Td>
                <Td className="text-muted-foreground">{o.organizationName || '—'}</Td>
                <Td><StatusBadge status={o.accountStatus} pendingVerification={o.pendingVerification} statusRecorded={o.statusRecorded} /></Td>
                <Td className="text-muted-foreground">{fmtDate(o.createdAt)}</Td>
                <Td>
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => setDetailUid(o.uid)} title="View" className={btnGhost}>
                      <Eye className="size-3.5" />
                    </button>
                    <Link href={`/admin/organizers/${o.uid}`} title="Open Organizer 360 console" className={btnGhost}>
                      <LayoutGrid className="size-3.5" />
                    </Link>
                    {/* D3 · 'pending' is not a moderation state, so it has no Reactivate.
                        Gated on the two states a reactivation can legally return FROM,
                        rather than on "anything that is not active". */}
                    {(o.accountStatus === 'suspended' || o.accountStatus === 'banned') && (
                      <button onClick={() => moderate(o.uid, 'reactivate')} disabled={busy} title="Reactivate" className={cn(btnGhost, 'text-emerald-600 hover:bg-emerald-50')}>
                        <ShieldCheck className="size-3.5" />
                      </button>
                    )}
                    {o.accountStatus !== 'suspended' && o.accountStatus !== 'banned' && (
                      <button onClick={() => moderate(o.uid, 'suspend')} disabled={busy} title="Suspend" className={cn(btnGhost, 'text-amber-600 hover:bg-amber-50')}>
                        <ShieldOff className="size-3.5" />
                      </button>
                    )}
                    {o.accountStatus !== 'banned' && (
                      <button onClick={() => moderate(o.uid, 'ban')} disabled={busy} title="Ban" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
                      </button>
                    )}
                    {/* Delete — irreversible, so it is last in the cluster and the only action
                        that opens a dialog. The dialog asks the SERVER whether this organizer is
                        deletable; nothing here predicts that, because a prediction shown as an
                        enabled-looking button is a promise the server may refuse. */}
                    <button
                      onClick={() => setDeleteTarget(o)}
                      disabled={busy}
                      title="Delete organizer"
                      className={cn(btnGhost, 'text-red-700 hover:bg-red-50')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </Td>
              </Tr>
            )
          })}
        </TBody>
      </TableFrame>

      {nextCursor && !loading && (
        <LoadMoreButton onClick={() => load({ cursor: nextCursor })} loading={loadingMore} />
      )}

      {detailUid && <OrganizerDetailModal uid={detailUid} onClose={() => setDetailUid(null)} />}

      {deleteTarget && (
        <DeleteOrganizerDialog
          uid={deleteTarget.uid}
          fallback={{
            name:             deleteTarget.name ?? '',
            email:            deleteTarget.email ?? '',
            organizationName: deleteTarget.organizationName ?? '',
          }}
          getToken={getToken}
          onClose={() => setDeleteTarget(null)}
          // Drop the row locally rather than refetching: the account is gone, and a refetch
          // would briefly show it again on a stale read.
          onDeleted={uid => setItems(prev => prev.filter(i => i.uid !== uid))}
        />
      )}
    </div>
  )
}

const btnGhost = 'flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'

// ─── Detail modal ───────────────────────────────────────────────────────────────

function OrganizerDetailModal({ uid, onClose }: { uid: string; onClose: () => void }) {
  // wallet / payoutProfile / settlements are null when the caller's financial view is redacted
  const [detail, setDetail] = useState<(AdminOrganizerDetail & { financialRedacted?: boolean }) | null>(null)
  const [error,  setError]  = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`/api/admin/organizers/${uid}`, {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const data = await res.json() as AdminOrganizerDetail
        if (!cancelled) setDetail(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      }
    })()
    return () => { cancelled = true }
  }, [uid])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-foreground">Organizer detail</h2>
          <IconButton onClick={onClose}><X className="size-4" /></IconButton>
        </div>

        {error ? (
          <p className="text-[13px] text-destructive">{error}</p>
        ) : !detail ? (
          <div className="py-10 text-center text-muted-foreground"><Loader2 className="mx-auto size-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4 text-[13.5px]">
            <div>
              <p className="font-semibold text-foreground">{detail.profile.name || '—'}</p>
              <p className="text-muted-foreground">{detail.profile.email}</p>
              <p className="text-muted-foreground">{detail.profile.organizationName || '—'}</p>
              <div className="mt-2"><StatusBadge status={detail.profile.accountStatus} pendingVerification={detail.profile.pendingVerification} statusRecorded={detail.profile.statusRecorded} /></div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Signed up: {detail.profile.createdAt ? fmtDate(detail.profile.createdAt) : 'Not recorded'}
                {' · '}Email: {emailVerificationLabel(detail.profile.emailVerification)}
              </p>
              {detail.profile.statusReason && (
                <p className="mt-1 text-[12px] text-muted-foreground">Reason: {detail.profile.statusReason}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Events"    value={String(detail.eventCount)} />
              <Stat label="Campaigns" value={String(detail.campaignCount)} />
              <Stat label="Available" value={walletAmountLabel(detail.wallet, 'availablePaise', detail.financialRedacted === true)} />
              <Stat label="Pending"   value={walletAmountLabel(detail.wallet, 'pendingPaise', detail.financialRedacted === true)} />
              <Stat label="Payout"    value={payoutLabel(detail.payoutProfile, detail.financialRedacted === true)} />
              <Stat label="Settled"   value={walletAmountLabel(detail.wallet, 'settledPaise', detail.financialRedacted === true)} />
            </div>

            {(detail.financialRedacted === true || detail.settlements === null) && (
              <p className="text-[12px] text-muted-foreground">Settlements: {WITHHELD}</p>
            )}
            {Array.isArray(detail.settlements) && detail.settlements.length > 0 && (
              <div>
                <p className="mb-1.5 text-[12px] font-semibold text-muted-foreground">Recent settlements</p>
                <div className="space-y-1">
                  {detail.settlements.map(s => (
                    <div key={s.id} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5">
                      <span className="capitalize text-muted-foreground">{s.status}</span>
                      <span className="font-medium text-foreground">{rupees(s.amountPaise)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[14px] font-semibold text-foreground">{value}</p>
    </div>
  )
}
