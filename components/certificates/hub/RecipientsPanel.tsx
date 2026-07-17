'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, ShieldCheck, Mail, Ban, RotateCcw, Search, Loader2 } from 'lucide-react'
import { REVOCATION_REASONS, REVOCATION_REASON_LABELS, CERTIFICATE_TYPE_LABELS } from '@/lib/certificates/constants'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import { Spinner, ErrorBox, Badge, btnGhost, selectCls, inputCls } from './ui'
import type { CertApi } from './api'
import type { SerializedCertificate, RevocationReason } from '@/lib/certificates/types'

export default function RecipientsPanel({ api }: { api: CertApi }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [certs, setCerts] = useState<SerializedCertificate[]>([])
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<SerializedCertificate | null>(null)

  const load = useCallback(() => {
    setErr(null)
    return api.getRecords().then(r => setCerts(r.certificates)).catch(e => setErr(e.message))
  }, [api])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id); setErr(null)
    try { await fn(); await load() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') }
    finally { setBusyId(null) }
  }

  if (loading) return <Spinner />

  const term = q.trim().toLowerCase()
  const rows = term
    ? certs.filter(c => c.attendeeName.toLowerCase().includes(term) || c.attendeeEmail.toLowerCase().includes(term) || c.certificateId.toLowerCase().includes(term))
    : certs

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input className={cn(inputCls, 'pl-9')} placeholder="Search name, email, ID…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button type="button" className={btnGhost} onClick={() => load()}>Refresh</button>
      </div>

      {err && <ErrorBox message={err} />}

      {certs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-14 text-center">
          <p className="text-[14px] font-medium text-foreground">No certificates yet</p>
          <p className="text-[13px] text-muted-foreground">Generate certificates from the Issue &amp; Bulk tab.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-[14px]">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                <th className="px-4 py-2.5">Participant</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Emailed</th>
                <th className="px-4 py-2.5 text-center">Downloads</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(c => {
                const revoked = c.status === 'revoked'
                return (
                  <tr key={c.certificateId} className="hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{c.attendeeName}</p>
                      <p className="text-[12px] text-muted-foreground">{c.attendeeEmail}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{CERTIFICATE_TYPE_LABELS[c.certificateType]}</td>
                    <td className="px-4 py-3">{revoked ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Active</Badge>}</td>
                    <td className="px-4 py-3">
                      {c.emailStatus === 'sent' ? <Badge tone="green">Sent</Badge>
                        : c.emailStatus === 'failed' ? <Badge tone="red">Failed</Badge>
                        : <Badge tone="gray">—</Badge>}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{c.downloadCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button type="button" className={btnGhost} title="Download" disabled={busyId === c.certificateId} onClick={() => act(c.certificateId, async () => {
                          const url = await api.downloadCertificateObjectUrl(c.certificateId)
                          window.open(url, '_blank', 'noopener,noreferrer')
                          setTimeout(() => URL.revokeObjectURL(url), 60_000)
                        })}><Download className="size-3.5" /></button>
                        <a href={`/verify/certificate/${c.certificateId}`} target="_blank" rel="noopener noreferrer" className={btnGhost} title="Verify"><ShieldCheck className="size-3.5" /></a>
                        {!revoked && <button type="button" className={btnGhost} title="Resend email" disabled={busyId === c.certificateId} onClick={() => act(c.certificateId, () => api.emailCertificate(c.certificateId, true))}><Mail className="size-3.5" /></button>}
                        {revoked
                          ? <button type="button" className={btnGhost} title="Restore" disabled={busyId === c.certificateId} onClick={() => act(c.certificateId, () => api.restore(c.certificateId))}><RotateCcw className="size-3.5" /></button>
                          : <button type="button" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')} title="Revoke" disabled={busyId === c.certificateId} onClick={() => setRevoking(c)}><Ban className="size-3.5" /></button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {revoking && (
        <RevokeModal
          name={revoking.attendeeName}
          busy={busyId === revoking.certificateId}
          onClose={() => setRevoking(null)}
          onConfirm={(reason, custom) => act(revoking.certificateId, async () => { await api.revoke(revoking.certificateId, reason, custom); setRevoking(null) })}
        />
      )}
    </div>
  )
}

function RevokeModal({ name, busy, onClose, onConfirm }: {
  name: string; busy: boolean; onClose: () => void; onConfirm: (reason: RevocationReason, custom?: string) => void
}) {
  const [reason, setReason] = useState<RevocationReason>('duplicate')
  const [custom, setCustom] = useState('')
  return (
    <Dialog
      open onClose={onClose} title="Revoke certificate" size="sm"
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="button" className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            disabled={busy || (reason === 'other' && !custom.trim())}
            onClick={() => onConfirm(reason, reason === 'other' ? custom.trim() : undefined)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />} Revoke
          </button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted-foreground">Revoking {name}&apos;s certificate marks it invalid on the public verification page.</p>
      <select className={selectCls} value={reason} onChange={e => setReason(e.target.value as RevocationReason)}>
        {REVOCATION_REASONS.map(r => <option key={r} value={r}>{REVOCATION_REASON_LABELS[r]}</option>)}
      </select>
      {reason === 'other' && <input className={cn(inputCls, 'mt-2')} placeholder="Reason…" value={custom} onChange={e => setCustom(e.target.value)} />}
    </Dialog>
  )
}
