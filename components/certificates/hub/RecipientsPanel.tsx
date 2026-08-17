'use client'

// RD-CERT-EMAIL-BULK — Recipients is the SINGLE certificate-delivery surface.
//
// Generation lives in Issue & Bulk and no longer sends anything; every send now starts
// here, where the operator can see what exists, filter it, and retry only what failed.
//
// Two properties this file is built around:
//
//   1. NOTHING LOADS 10,000 ROWS. The list is cursor-paged (the server always supported it;
//      the old panel requested one page and silently dropped the rest), and "select all
//      matching" sends a SCOPE — never a list of ids — so a 100,000-certificate send is the
//      same request as a 10-certificate one.
//   2. THE BROWSER IS NOT A WORKER. Bulk delivery is a persisted job; this polls its
//      progress and stops. Closing the tab, refreshing or navigating away does not pause,
//      restart or duplicate anything.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download, ShieldCheck, Mail, Ban, RotateCcw, RefreshCw, Search, Loader2, AlertTriangle, Send,
} from 'lucide-react'
import { REVOCATION_REASONS, REVOCATION_REASON_LABELS, CERTIFICATE_TYPE_LABELS } from '@/lib/certificates/constants'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import { Spinner, ErrorBox, Badge, btnGhost, btnPrimary, selectCls, inputCls } from './ui'
import type { CertApi } from './api'
import type {
  SerializedCertificate, RevocationReason, SerializedCertificateEmailJob,
} from '@/lib/certificates/types'

const PAGE_SIZE = 50
const POLL_MS   = 4_000

type StatusFilter = 'all' | 'unsent' | 'sent' | 'failed' | 'processing' | 'needs_review'

/**
 * `needs_review` is not a stored status — it is `processing` whose claim has lapsed.
 * Deriving it here keeps the certificate document to the states the claim actually writes.
 */
function isNeedsReview(c: SerializedCertificate): boolean {
  if (c.emailStatus !== 'processing') return false
  const lease = c.emailLeaseExpiresAt ? Date.parse(c.emailLeaseExpiresAt) : 0
  return !lease || lease < Date.now()
}

function deliveryLabel(c: SerializedCertificate): { tone: Parameters<typeof Badge>[0]['tone']; text: string } {
  if (isNeedsReview(c))                return { tone: 'amber', text: 'Delivery unknown' }
  if (c.emailStatus === 'processing')  return { tone: 'blue',  text: 'Sending…' }
  if (c.emailStatus === 'sent')        return { tone: 'green', text: 'Sent' }
  if (c.emailStatus === 'delivered')   return { tone: 'green', text: 'Delivered' }
  if (c.emailStatus === 'failed')      return { tone: 'red',   text: 'Failed' }
  return { tone: 'gray', text: 'Not sent' }
}

function matchesFilter(c: SerializedCertificate, f: StatusFilter): boolean {
  switch (f) {
    case 'all':          return true
    case 'sent':         return c.emailStatus === 'sent' || c.emailStatus === 'delivered'
    case 'failed':       return c.emailStatus === 'failed'
    case 'needs_review': return isNeedsReview(c)
    case 'processing':   return c.emailStatus === 'processing' && !isNeedsReview(c)
    case 'unsent':       return c.emailStatus == null || c.emailStatus === 'pending' || c.emailStatus === 'failed'
  }
}

export default function RecipientsPanel({ api }: { api: CertApi }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [certs, setCerts]     = useState<SerializedCertificate[]>([])
  const [cursor, setCursor]   = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const [q, setQ]             = useState('')
  const [filter, setFilter]   = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false)

  const [busyId, setBusyId]   = useState<string | null>(null)
  /** Certificates awaiting a regeneration confirmation. One entry = a row action, many = bulk.
   *  Null while no dialog is open — the same shape `revoking` uses, so there is one pattern. */
  const [regenerating, setRegenerating] = useState<string[] | null>(null)
  const [regenBusy, setRegenBusy] = useState(false)
  const [revoking, setRevoking] = useState<SerializedCertificate | null>(null)
  const [reviewing, setReviewing] = useState<SerializedCertificate | null>(null)
  const [notice, setNotice]   = useState<string | null>(null)

  const [job, setJob]         = useState<SerializedCertificateEmailJob | null>(null)
  const [pending, setPending] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // No synchronous setState here: `loading` already starts true, and the effect below
  // must not trigger a cascading render (react-hooks/set-state-in-effect).
  const loadFirst = useCallback(() => {
    return api.getRecords({ limit: PAGE_SIZE })
      .then(r => { setCerts(r.certificates); setCursor(r.nextCursor ?? null); setHasMore(!!r.hasMore) })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [api])

  useEffect(() => { void loadFirst() }, [loadFirst])

  // Resume progress for a job already running when the tab opened — progress lives on the
  // job document, so a refresh or a fresh navigation picks it straight back up.
  useEffect(() => {
    api.listEmailJobs()
      .then(r => {
        const active = r.jobs.find(j => j.status === 'pending' || j.status === 'processing')
        if (active) setJob(active)
      })
      .catch(() => {})
  }, [api])

  // Poll the job document. This is a READ — the browser never advances the job.
  useEffect(() => {
    if (!job || (job.status !== 'pending' && job.status !== 'processing')) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => {
      api.getEmailJob(job.jobId)
        .then(r => { setJob(r.job); setPending(r.pending) })
        .catch(() => {})
    }, POLL_MS)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [api, job])

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await api.getRecords({ limit: PAGE_SIZE, cursor })
      setCerts(prev => [...prev, ...r.certificates])
      setCursor(r.nextCursor ?? null)
      setHasMore(!!r.hasMore)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load more') }
    finally { setLoadingMore(false) }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id); setErr(null); setNotice(null)
    try { await fn(); await loadFirst() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') }
    finally { setBusyId(null) }
  }

  /**
   * Regenerates the given certificates in place.
   *
   * THE ROUTE ANSWERS 200 EVEN WHEN EVERY ITEM FAILED — it reports per-item outcomes in
   * `results`. Treating `res.ok` as success is precisely how a fully-failed batch reads as
   * "done" and a stale certificate looks regenerated. So the outcome here is derived from
   * `results[].ok`, and any `error` the server returned is surfaced verbatim.
   */
  async function runRegenerate(ids: string[]) {
    setRegenBusy(true); setErr(null); setNotice(null)
    try {
      const r = await api.regenerate(ids)
      const failures = r.results.filter(x => !x.ok)

      if (failures.length === 0) {
        setNotice(ids.length === 1
          ? 'Certificate regenerated successfully.'
          : `${r.succeeded} certificates regenerated.`)
      } else {
        // Name the certificate and quote the server's reason — "no_active_template" is the
        // one an organizer can actually act on, and hiding it is what makes this silent.
        const detail = failures.map(f => `${f.certificateId}: ${f.error ?? 'failed'}`).join('; ')
        setErr(ids.length === 1
          ? `Certificate regeneration failed: ${failures[0].error ?? 'unknown error'}`
          : `${r.succeeded} regenerated. ${failures.length} failed — ${detail}`)
        if (r.succeeded > 0) setNotice(`${r.succeeded} certificates regenerated.`)
      }

      setRegenerating(null)
      await loadFirst()
    } catch (e) {
      // Transport / auth failure — the request never produced per-item results.
      setErr(e instanceof Error ? e.message : 'Regeneration failed')
    } finally {
      setRegenBusy(false)
    }
  }

  async function startJob(scopeType: 'unsent' | 'failed' | 'selected') {
    setErr(null); setNotice(null)
    try {
      const body = scopeType === 'selected'
        ? { scopeType, certificateIds: [...selected] }
        : { scopeType }
      const { job: created } = await api.createEmailJob(body)
      setJob(created)
      setSelected(new Set()); setAllMatching(false)
      setNotice('Delivery started. It continues on the server — you can close this tab.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to start delivery') }
  }

  if (loading) return <Spinner />

  const term = q.trim().toLowerCase()
  const rows = certs
    .filter(c => matchesFilter(c, filter))
    .filter(c => !term
      || c.attendeeName.toLowerCase().includes(term)
      || c.attendeeEmail.toLowerCase().includes(term)
      || c.certificateId.toLowerCase().includes(term))

  const pageIds = rows.map(r => r.certificateId)
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selected.has(id))
  const active = job && (job.status === 'pending' || job.status === 'processing')

  return (
    <div className="space-y-4">
      {/* ── Delivery progress. Server-owned, so it survives a refresh. ── */}
      {job && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[14px] font-semibold text-foreground">
              Certificate Delivery {active ? '— in progress' : `— ${job.status}`}
            </h3>
            {active && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Total"        value={job.counts?.total ?? 0} />
            <Stat label="Processed"    value={job.counts?.processed ?? 0} />
            <Stat label="Sent"         value={job.counts?.succeeded ?? 0} />
            <Stat label="Failed"       value={job.counts?.failed ?? 0} />
            <Stat label="Needs review" value={job.needsReview ?? 0} />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            {pending} pending · runs on the server, so closing this tab will not stop it.
          </p>
          {job.error && <div className="mt-3"><ErrorBox message={job.error} /></div>}
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input className={cn(inputCls, 'pl-9')} placeholder="Search name, email or ID" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className={cn(selectCls, 'max-w-[190px]')} value={filter} onChange={e => { setFilter(e.target.value as StatusFilter); setSelected(new Set()); setAllMatching(false) }}>
          <option value="all">All</option>
          <option value="unsent">Not sent</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="processing">Sending</option>
          <option value="needs_review">Delivery unknown</option>
        </select>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} disabled={!!active} onClick={() => startJob('unsent')}>
            <Send className="size-3.5" /> Send all not sent
          </button>
          <button type="button" className={btnGhost} disabled={!!active} onClick={() => startJob('failed')}>
            <RotateCcw className="size-3.5" /> Retry failed
          </button>
          {selected.size > 0 && (
            <button type="button" className={btnGhost} disabled={!!active} onClick={() => startJob('selected')}>
              <Mail className="size-3.5" /> Send {selected.size} selected
            </button>
          )}
          {selected.size > 0 && (
            <button type="button" className={btnGhost} disabled={!!active || regenBusy}
              onClick={() => setRegenerating([...selected])}>
              <RefreshCw className="size-3.5" /> Regenerate {selected.size} selected
            </button>
          )}
        </div>
      </div>

      {notice && <p className="text-[13px] text-emerald-600">{notice}</p>}
      {err && <ErrorBox message={err} />}

      {/* ── Selection banner: "all matching" is a SCOPE, never a list of ids. ── */}
      {allPageSelected && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-2 text-[13px] text-muted-foreground">
          {allMatching
            ? <>All certificates matching <strong className="text-foreground">{filter === 'all' ? 'this event' : filter}</strong> will be sent — no per-row selection is stored.{' '}
                <button type="button" className="underline" onClick={() => setAllMatching(false)}>Clear</button></>
            : <>All {pageIds.length} on this page selected.{' '}
                <button type="button" className="underline" onClick={() => setAllMatching(true)}>Select all matching instead</button></>}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">No certificates match.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox" aria-label="Select page" checked={allPageSelected}
                    onChange={e => {
                      setSelected(prev => {
                        const n = new Set(prev)
                        pageIds.forEach(id => { if (e.target.checked) n.add(id); else n.delete(id) })
                        return n
                      })
                      if (!e.target.checked) setAllMatching(false)
                    }}
                  />
                </th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Delivery</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(c => {
                const revoked = c.status === 'revoked'
                const review  = isNeedsReview(c)
                const badge   = deliveryLabel(c)
                return (
                  <tr key={c.certificateId} className="hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox" aria-label={`Select ${c.attendeeName}`}
                        checked={selected.has(c.certificateId)}
                        onChange={e => setSelected(prev => {
                          const n = new Set(prev)
                          if (e.target.checked) n.add(c.certificateId); else n.delete(c.certificateId)
                          return n
                        })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="truncate font-medium text-foreground">{c.attendeeName}</div>
                      <div className="truncate text-[12px] text-muted-foreground">{c.attendeeEmail}</div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{CERTIFICATE_TYPE_LABELS[c.certificateType]}</td>
                    <td className="px-3 py-2">
                      {revoked ? <Badge tone="red">Revoked</Badge> : <Badge tone={badge.tone}>{badge.text}</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" className={btnGhost} title="Download"
                          onClick={() => act(c.certificateId, async () => {
                            const url = await api.downloadCertificateObjectUrl(c.certificateId)
                            window.open(url, '_blank', 'noopener')
                          })}>
                          <Download className="size-3.5" />
                        </button>

                        {/* An unknown delivery is NEVER handled by the ordinary resend —
                            it opens a dialog that states the risk first. */}
                        {!revoked && review && (
                          <button type="button" className={cn(btnGhost, 'text-amber-700')}
                            title="Delivery unknown — review & send"
                            onClick={() => setReviewing(c)}>
                            <AlertTriangle className="size-3.5" /> Review
                          </button>
                        )}
                        {!revoked && !review && (
                          <button type="button" className={btnGhost} title="Resend email"
                            disabled={busyId === c.certificateId}
                            onClick={() => act(c.certificateId, () => api.emailCertificate(c.certificateId, true, 'resend'))}>
                            <Mail className="size-3.5" />
                          </button>
                        )}

                        {/* Regeneration re-renders against the CURRENT active template. Hidden
                            for revoked certificates — the engine refuses them anyway, and the
                            server stays the authority; this only avoids offering a dead action. */}
                        {!revoked && (
                          <button type="button" className={btnGhost} title="Regenerate"
                            aria-label="Regenerate"
                            disabled={busyId === c.certificateId || regenBusy}
                            onClick={() => setRegenerating([c.certificateId])}>
                            <RefreshCw className="size-3.5" />
                          </button>
                        )}

                        {revoked
                          ? <button type="button" className={btnGhost} title="Restore" disabled={busyId === c.certificateId}
                              onClick={() => act(c.certificateId, () => api.restore(c.certificateId))}><RotateCcw className="size-3.5" /></button>
                          : <button type="button" className={btnGhost} title="Revoke" disabled={busyId === c.certificateId}
                              onClick={() => setRevoking(c)}><Ban className="size-3.5" /></button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button type="button" className={btnGhost} disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Load more
          </button>
        </div>
      )}

      {regenerating && (
        <RegenerateDialog
          certificateIds={regenerating}
          busy={regenBusy}
          onClose={() => setRegenerating(null)}
          onConfirm={() => void runRegenerate(regenerating)}
        />
      )}

      {revoking && (
        <RevokeDialog
          certificate={revoking}
          onClose={() => setRevoking(null)}
          onConfirm={(reason, custom) => act(revoking.certificateId, async () => {
            await api.revoke(revoking.certificateId, reason, custom); setRevoking(null)
          })}
        />
      )}

      {reviewing && (
        <ReviewSendDialog
          certificate={reviewing}
          onClose={() => setReviewing(null)}
          onConfirm={() => act(reviewing.certificateId, async () => {
            await api.emailCertificate(reviewing.certificateId, true, 'resend_after_review')
            setReviewing(null)
          })}
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[18px] font-semibold text-foreground">{value}</div>
    </div>
  )
}

/**
 * The one dialog that asks the operator to accept a risk.
 *
 * A certificate reaches this state when a worker claimed it and then died: the provider may
 * or may not have accepted the message, and nothing in the system can tell which. Sending
 * again may deliver a duplicate — so the history is shown BEFORE the button, and the button
 * says what it does.
 */
function ReviewSendDialog({
  certificate, onClose, onConfirm,
}: { certificate: SerializedCertificate; onClose: () => void; onConfirm: () => void }) {
  const history = certificate.emailHistory ?? []
  const last = history[history.length - 1]
  return (
    <Dialog open onClose={onClose} title="Delivery unknown — review & send">
      <div className="space-y-3 text-[13px]">
        <p className="text-muted-foreground">
          A previous attempt claimed this certificate but never recorded an outcome. The email
          provider <strong className="text-foreground">may already have accepted it</strong>.
          Sending again could deliver a duplicate.
        </p>
        <dl className="grid grid-cols-3 gap-y-1 rounded-lg border border-border bg-muted/20 px-3 py-2">
          <dt className="col-span-1 text-muted-foreground">Recipient</dt>
          <dd className="col-span-2 truncate text-foreground">{certificate.attendeeEmail}</dd>
          <dt className="col-span-1 text-muted-foreground">Certificate</dt>
          <dd className="col-span-2 text-foreground">{certificate.certificateId}</dd>
          <dt className="col-span-1 text-muted-foreground">Attempts</dt>
          <dd className="col-span-2 text-foreground">{certificate.emailAttempts ?? 0}</dd>
          <dt className="col-span-1 text-muted-foreground">Last attempt</dt>
          <dd className="col-span-2 text-foreground">{last ? `${last.status} · ${last.timestamp}` : '—'}</dd>
          {last?.error && (<>
            <dt className="col-span-1 text-muted-foreground">Error</dt>
            <dd className="col-span-2 text-foreground">{last.error}</dd>
          </>)}
        </dl>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={onConfirm}>Send anyway</button>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Confirms an in-place regeneration. Destructive in one specific way — it REPLACES the stored
 * PDF — while leaving identity untouched, so the copy states both halves rather than a generic
 * "are you sure".
 */
function RegenerateDialog({
  certificateIds, busy, onClose, onConfirm,
}: {
  certificateIds: string[]
  busy:      boolean
  onClose:   () => void
  onConfirm: () => void
}) {
  const many = certificateIds.length > 1
  return (
    <Dialog
      open
      onClose={onClose}
      title={many ? `Regenerate ${certificateIds.length} certificates?` : `Regenerate ${certificateIds[0]}`}
    >
      <div className="space-y-3">
        <p className="text-[13px] text-muted-foreground">
          {many
            ? 'These certificates will be re-rendered using the event’s current active template.'
            : 'Regenerate this certificate using the event’s current active template?'}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
          <li>The stored PDF is replaced.</li>
          <li>The certificate ID stays the same.</li>
          <li>The verification link stays the same.</li>
          <li>No additional certificate is created.</li>
        </ul>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Regenerate
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function RevokeDialog({
  certificate, onClose, onConfirm,
}: {
  certificate: SerializedCertificate
  onClose: () => void
  onConfirm: (reason: RevocationReason, custom?: string) => void
}) {
  const [reason, setReason] = useState<RevocationReason>('duplicate')
  const [custom, setCustom] = useState('')
  return (
    <Dialog open onClose={onClose} title={`Revoke ${certificate.certificateId}`}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[13px] text-muted-foreground">Reason</label>
          <select className={selectCls} value={reason} onChange={e => setReason(e.target.value as RevocationReason)}>
            {REVOCATION_REASONS.map(r => <option key={r} value={r}>{REVOCATION_REASON_LABELS[r]}</option>)}
          </select>
        </div>
        {reason === 'other' && (
          <div>
            <label className="mb-1 block text-[13px] text-muted-foreground">Details</label>
            <input className={inputCls} value={custom} onChange={e => setCustom(e.target.value)} />
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={() => onConfirm(reason, custom || undefined)}>Revoke</button>
        </div>
      </div>
    </Dialog>
  )
}
