'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Award, CheckCircle2, Download, Mail, AlertCircle,
  Loader2, Save, ChevronDown, ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { CertificateTemplate, CertificateTemplateInput } from '@/lib/certificates/types'
import type { TemplateResponse }           from '@/app/api/organizer/events/[eventId]/certificates/template/route'
import type { CertificateStatsResponse }   from '@/app/api/organizer/events/[eventId]/certificates/stats/route'
import type { GenerateCertificatesResponse } from '@/app/api/organizer/events/[eventId]/certificates/generate/route'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  eventId: string
  token:   string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number | string; icon: React.ElementType; color: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', color)}>
        <Icon className="size-4 text-foreground/70" aria-hidden />
      </div>
      <div>
        <p className="text-[20px] font-bold leading-none text-foreground">{value}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

// ─── Settings form ────────────────────────────────────────────────────────────

function SettingsSection({
  template,
  defaults,
  token,
  eventId,
  onSaved,
}: {
  template: CertificateTemplate | null
  defaults: CertificateTemplateInput
  token:    string
  eventId:  string
  onSaved:  () => void
}) {
  const init: CertificateTemplateInput = template
    ? {
        enabled:              template.enabled,
        type:                 template.type,
        title:                template.title,
        subtitle:             template.subtitle,
        issuedBy:             template.issuedBy,
        signatoryName:        template.signatoryName,
        signatoryDesignation: template.signatoryDesignation,
        logoUrl:              template.logoUrl,
        signatureUrl:         template.signatureUrl,
        backgroundUrl:        template.backgroundUrl,
      }
    : defaults

  const [form,    setForm]    = useState<CertificateTemplateInput>(init)
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [showDesign, setShowDesign] = useState(false)

  function update<K extends keyof CertificateTemplateInput>(k: K, v: CertificateTemplateInput[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/certificates/template`, {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      if (!res.ok) throw new Error((await res.json() as { error: string }).error)
      setSaved(true)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">

      {/* Enable + type */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-[15px] font-semibold text-foreground">Certificate Settings</h3>

        {/* Enable toggle */}
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
          <div>
            <p className="text-[13px] font-medium text-foreground">Enable Certificates</p>
            <p className="text-[12px] text-muted-foreground">Allow certificate generation for this event</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            onClick={() => update('enabled', !form.enabled)}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200',
              form.enabled ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span className={cn(
              'inline-block size-4 rounded-full bg-white shadow transition-transform duration-200',
              form.enabled ? 'translate-x-6' : 'translate-x-1',
            )} />
          </button>
        </div>

        {/* Certificate type */}
        {form.enabled && (
          <div className="mt-4">
            <p className="mb-2 text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">Certificate Type</p>
            <div className="grid grid-cols-2 gap-3">
              {([ 'participation', 'completion' ] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => update('type', t)}
                  className={cn(
                    'rounded-xl border p-4 text-left transition-colors',
                    form.type === t
                      ? 'border-primary bg-primary/[0.06]'
                      : 'border-border bg-card hover:bg-muted/30',
                  )}
                >
                  <p className={cn('text-[13px] font-semibold capitalize', form.type === t ? 'text-primary' : 'text-foreground')}>
                    {t}
                  </p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    {t === 'participation'
                      ? 'Eligible after confirmed registration'
                      : 'Eligible only after successful check-in'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Certificate design (collapsible) */}
      {form.enabled && (
        <div className="rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setShowDesign(v => !v)}
            className="flex w-full items-center justify-between px-5 py-4 text-left"
          >
            <h3 className="text-[15px] font-semibold text-foreground">Certificate Design</h3>
            {showDesign
              ? <ChevronUp className="size-4 text-muted-foreground" />
              : <ChevronDown className="size-4 text-muted-foreground" />
            }
          </button>

          {showDesign && (
            <div className="border-t border-border px-5 pb-5 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Certificate Title"     value={form.title}                onChange={v => update('title', v)} placeholder="Certificate of Participation" />
                <Field label="Subtitle"              value={form.subtitle ?? ''}       onChange={v => update('subtitle', v)} placeholder="This is to certify that" />
                <Field label="Issued By"             value={form.issuedBy}             onChange={v => update('issuedBy', v)} placeholder="Your Organization Name" />
                <Field label="Signatory Name"        value={form.signatoryName}        onChange={v => update('signatoryName', v)} placeholder="John Doe" />
                <Field label="Signatory Designation" value={form.signatoryDesignation} onChange={v => update('signatoryDesignation', v)} placeholder="Director" />
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field label="Logo URL"       value={form.logoUrl ?? ''}       onChange={v => update('logoUrl', v || undefined)} placeholder="https://…/logo.png" />
                <Field label="Signature URL"  value={form.signatureUrl ?? ''}  onChange={v => update('signatureUrl', v || undefined)} placeholder="https://…/sig.png" />
                <Field label="Background URL" value={form.backgroundUrl ?? ''} onChange={v => update('backgroundUrl', v || undefined)} placeholder="https://…/bg.png" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <AlertCircle className="size-4 shrink-0" />
          {err}
        </div>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
            <CheckCircle2 className="size-4" /> Saved
          </span>
        )}
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      <label className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-card px-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25"
      />
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CertificatesTab({ eventId, token }: Props) {
  const [templateData, setTemplateData] = useState<TemplateResponse | null>(null)
  const [stats,        setStats]        = useState<CertificateStatsResponse | null>(null)
  const [loadingT,     setLoadingT]     = useState(true)
  const [loadingS,     setLoadingS]     = useState(false)
  const [generating,   setGenerating]   = useState(false)
  const [genResult,    setGenResult]    = useState<GenerateCertificatesResponse | null>(null)
  const [genError,     setGenError]     = useState<string | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  // Load template
  useEffect(() => {
    fetch(`/api/organizer/events/${eventId}/certificates/template`, { headers })
      .then(r => r.json() as Promise<TemplateResponse>)
      .then(data => { setTemplateData(data); setLoadingT(false) })
      .catch(() => setLoadingT(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, token])

  // Load stats (when enabled)
  const loadStats = useCallback(() => {
    setLoadingS(true)
    fetch(`/api/organizer/events/${eventId}/certificates/stats`, { headers })
      .then(r => r.json() as Promise<CertificateStatsResponse>)
      .then(data => { setStats(data); setLoadingS(false) })
      .catch(() => setLoadingS(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, token])

  // Load stats once template is loaded and enabled
  useEffect(() => {
    if (templateData?.template?.enabled) loadStats()
  }, [templateData, loadStats])

  async function handleGenerate() {
    setGenerating(true); setGenResult(null); setGenError(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/certificates/generate`, {
        method: 'POST', headers,
      })
      if (!res.ok) {
        const body = await res.json() as { error: string }
        throw new Error(body.error)
      }
      const result = await res.json() as GenerateCertificatesResponse
      setGenResult(result)
      loadStats()
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Failed to generate certificates')
    } finally {
      setGenerating(false)
    }
  }

  if (loadingT) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const template = templateData?.template ?? null
  const defaults = templateData?.defaults ?? {
    enabled: false, type: 'participation' as const,
    title: 'Certificate of Participation', subtitle: 'This is to certify that',
    issuedBy: '', signatoryName: '', signatoryDesignation: '',
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/[0.09]">
          <Award className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <h2 className="text-[16px] font-bold text-foreground">Certificates</h2>
          <p className="text-[13px] text-muted-foreground">
            Generate and send participation or completion certificates to attendees.
          </p>
        </div>
      </div>

      {/* Settings form */}
      <SettingsSection
        template={template}
        defaults={defaults}
        token={token}
        eventId={eventId}
        onSaved={() => {
          fetch(`/api/organizer/events/${eventId}/certificates/template`, { headers })
            .then(r => r.json() as Promise<TemplateResponse>)
            .then(setTemplateData)
            .catch(() => {})
        }}
      />

      {/* Stats + generate section */}
      {template?.enabled && (
        <>
          {/* Stats cards */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-foreground">Certificate Overview</h3>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {generating
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Award className="size-3.5" />
                }
                {generating ? 'Generating…' : 'Generate Certificates'}
              </button>
            </div>

            {loadingS ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : stats ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Generated"  value={stats.generated}  icon={Award}          color="bg-primary/[0.08]" />
                <StatCard label="Downloaded" value={stats.downloaded} icon={Download}        color="bg-emerald-100"   />
                <StatCard label="Emailed"    value={stats.emailed}    icon={Mail}            color="bg-blue-100"      />
                <StatCard label="Pending"    value={stats.pending}    icon={AlertCircle}     color="bg-amber-100"     />
              </div>
            ) : null}
          </div>

          {/* Generate result banner */}
          {genResult && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px]">
              <p className="font-semibold text-emerald-800">
                Generated {genResult.generated} certificate{genResult.generated !== 1 ? 's' : ''}
                {genResult.skipped > 0 && ` · ${genResult.skipped} already existed`}
                {genResult.ineligible > 0 && ` · ${genResult.ineligible} ineligible`}
              </p>
            </div>
          )}
          {genError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              <AlertCircle className="size-4 shrink-0" /> {genError}
            </div>
          )}

          {/* Recent certificates table */}
          {stats && stats.recent.length > 0 && (
            <div>
              <h3 className="mb-3 text-[15px] font-semibold text-foreground">Recent Certificates</h3>
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Attendee</th>
                      <th className="hidden px-4 py-2.5 text-left font-semibold text-muted-foreground sm:table-cell">Certificate ID</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Issued</th>
                      <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground">Downloads</th>
                      <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground">Email</th>
                      <th className="px-4 py-2.5 text-right font-semibold text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stats.recent.map(cert => (
                      <tr key={cert.certificateId} className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{cert.attendeeName}</p>
                          <p className="text-[11px] text-muted-foreground">{cert.attendeeEmail}</p>
                        </td>
                        <td className="hidden px-4 py-3 sm:table-cell">
                          <span className="font-mono text-[11px] text-muted-foreground">{cert.certificateId}</span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {fmtDate(cert.issuedAt)}
                        </td>
                        <td className="px-4 py-3 text-center text-muted-foreground">
                          {cert.downloadCount}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {cert.emailStatus === 'sent'
                            ? <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Sent</span>
                            : cert.emailStatus === 'failed'
                              ? <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">Failed</span>
                              : <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">—</span>
                          }
                        </td>
                        <td className="px-4 py-3 text-right">
                          <a
                            href={`/api/certificates/${cert.certificateId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted/60"
                          >
                            <Download className="size-3" />
                            PDF
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty state */}
          {stats && stats.recent.length === 0 && stats.generated === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-14 text-center">
              <Award className="size-8 text-muted-foreground/40" aria-hidden />
              <p className="text-[14px] font-medium text-foreground">No certificates generated yet</p>
              <p className="text-[13px] text-muted-foreground">
                Click &ldquo;Generate Certificates&rdquo; to create certificates for eligible attendees.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
