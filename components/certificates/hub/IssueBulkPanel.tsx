'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Users, UserCheck, ListChecks, User, Play, RefreshCw, Ban, X } from 'lucide-react'
import {
  CERTIFICATE_TYPES, CERTIFICATE_TYPE_LABELS, CERTIFICATE_JOB_STATUS_LABELS,
} from '@/lib/certificates/constants'
import { cn } from '@/lib/utils/cn'
import { IconButton } from '@/components/ui'
import { Toggle, ErrorBox, Badge, FieldLabel, selectCls, btnGhost } from './ui'
import type { CertApi } from './api'
import type { CertificateType, CertificateJobScope, SerializedCertificateJob } from '@/lib/certificates/types'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const jobTone: Record<string, Parameters<typeof Badge>[0]['tone']> = {
  pending: 'gray', processing: 'blue', completed: 'green', failed: 'red', cancelled: 'amber',
}

export default function IssueBulkPanel({ api }: { api: CertApi }) {
  const [certType, setCertType] = useState<CertificateType>('participation')
  const [autoEmail, setAutoEmail] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [picker, setPicker] = useState<null | 'selected' | 'single'>(null)
  const [attendees, setAttendees] = useState<SerializedRegistration[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const [jobs, setJobs] = useState<SerializedCertificateJob[]>([])
  const running = useRef<Set<string>>(new Set())

  const refreshJobs = useCallback(() => api.listJobs().then(r => setJobs(r.jobs)).catch(() => {}), [api])
  useEffect(() => { refreshJobs() }, [refreshJobs])

  // Client-side driver: repeatedly call /process until the job is done.
  const drive = useCallback(async (jobId: string) => {
    if (running.current.has(jobId)) return
    running.current.add(jobId)
    try {
      for (let i = 0; i < 100000; i++) {
        const { result, job } = await api.processJob(jobId)
        setJobs(prev => prev.map(j => j.jobId === jobId ? job : j))
        if (result.done) break
        if (result.reason === 'busy') { await sleep(1500); continue }
        await sleep(300)
      }
    } catch { /* surfaced via job status on next refresh */ }
    finally { running.current.delete(jobId) }
  }, [api])

  async function createJob(scope: CertificateJobScope, registrationIds?: string[]) {
    setBusy(true); setErr(null); setNotice(null)
    try {
      const { job } = await api.createJob({ scope, certificateType: certType, registrationIds: registrationIds ?? null, autoEmail })
      setJobs(prev => [job, ...prev])
      setPicker(null); setChosen(new Set())
      void drive(job.jobId)
      setNotice(`Job started for "${scope.replace('_', ' ')}" attendees.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start job')
    } finally { setBusy(false) }
  }

  async function issueSingle(registrationId: string) {
    setBusy(true); setErr(null); setNotice(null)
    try {
      const r = await api.issue(registrationId, certType)
      setNotice(r.created ? 'Certificate generated.' : 'Certificate already existed.')
      setPicker(null); setChosen(new Set())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to issue certificate')
    } finally { setBusy(false) }
  }

  function openPicker(mode: 'selected' | 'single') {
    setPicker(mode); setErr(null); setChosen(new Set())
    if (!attendees) {
      api.getConfirmedAttendees()
        .then(r => setAttendees(r.registrations.filter(x => x.status === 'confirmed')))
        .catch(e => setErr(e.message))
    }
  }

  async function cancelJob(jobId: string) {
    try { await api.cancelJob(jobId); await refreshJobs() } catch { /* ignore */ }
  }

  return (
    <div className="space-y-6">
      {/* Generate controls */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-[14px] font-semibold text-foreground">Generate Certificates</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">Requires an active template (set one in Templates).</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>Certificate Type</FieldLabel>
            <select className={selectCls} value={certType} onChange={e => setCertType(e.target.value as CertificateType)}>
              {CERTIFICATE_TYPES.map(t => <option key={t} value={t}>{CERTIFICATE_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="flex items-end justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2">
            <span className="text-[14px] text-foreground">Auto-email after generation</span>
            <Toggle checked={autoEmail} onChange={setAutoEmail} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={btnGhost} disabled={busy} onClick={() => createJob('all')}><Users className="size-3.5" /> All confirmed</button>
          <button type="button" className={btnGhost} disabled={busy} onClick={() => createJob('checked_in')}><UserCheck className="size-3.5" /> Checked-in</button>
          <button type="button" className={btnGhost} disabled={busy} onClick={() => openPicker('selected')}><ListChecks className="size-3.5" /> Selected…</button>
          <button type="button" className={btnGhost} disabled={busy} onClick={() => openPicker('single')}><User className="size-3.5" /> Single…</button>
        </div>

        {notice && <p className="mt-3 text-[13px] text-emerald-600">{notice}</p>}
        {err && <div className="mt-3"><ErrorBox message={err} /></div>}
      </div>

      {/* Attendee picker */}
      {picker && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-foreground">{picker === 'single' ? 'Pick an attendee' : 'Select attendees'}</h3>
            <IconButton type="button" onClick={() => setPicker(null)}><X className="size-4" /></IconButton>
          </div>
          {!attendees ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : attendees.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No confirmed attendees.</p>
          ) : (
            <>
              <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {attendees.map(a => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/30">
                    <input
                      type={picker === 'single' ? 'radio' : 'checkbox'} name="attendee"
                      checked={chosen.has(a.id)}
                      onChange={() => setChosen(prev => {
                        if (picker === 'single') return new Set([a.id])
                        const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n
                      })}
                    />
                    <span className="flex-1 truncate text-[13px] text-foreground">{a.attendee.name}</span>
                    <span className="truncate text-[12px] text-muted-foreground">{a.attendee.email}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button type="button" className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
                  disabled={busy || chosen.size === 0}
                  onClick={() => picker === 'single' ? issueSingle([...chosen][0]) : createJob('selected', [...chosen])}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {picker === 'single' ? 'Generate certificate' : `Generate for ${chosen.size} selected`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Jobs monitor */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-foreground">Bulk Jobs</h3>
          <button type="button" className={btnGhost} onClick={refreshJobs}><RefreshCw className="size-3.5" /> Refresh</button>
        </div>
        {jobs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">No bulk jobs yet.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map(j => {
              const pct = j.counts.total ? Math.round((j.counts.processed / j.counts.total) * 100) : 0
              const active = j.status === 'pending' || j.status === 'processing'
              return (
                <div key={j.jobId} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={jobTone[j.status]}>{CERTIFICATE_JOB_STATUS_LABELS[j.status]}</Badge>
                      <span className="text-[13px] text-muted-foreground capitalize">{j.scope.replace('_', ' ')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {active && <button type="button" className={btnGhost} onClick={() => drive(j.jobId)}><Play className="size-3.5" /> Process</button>}
                      {active && <button type="button" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')} onClick={() => cancelJob(j.jobId)}><Ban className="size-3.5" /> Cancel</button>}
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 flex gap-4 text-[12px] text-muted-foreground">
                    <span>Processed {j.counts.processed}/{j.counts.total}</span>
                    <span className="text-emerald-600">✓ {j.counts.succeeded}</span>
                    <span className="text-red-600">✗ {j.counts.failed}</span>
                  </div>
                  {j.error && <p className="mt-1 text-[12px] text-red-600">{j.error}</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
