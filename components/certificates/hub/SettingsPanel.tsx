'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, CheckCircle2 } from 'lucide-react'
import {
  CERTIFICATE_TYPE_LABELS, CERTIFICATE_TRIGGER_LABELS,
  CERTIFICATE_TYPES, CERTIFICATE_TRIGGERS,
} from '@/lib/certificates/constants'
import { Spinner, ErrorBox, Toggle, FieldLabel, selectCls, inputCls, btnPrimary } from './ui'
import type { CertApi } from './api'
import type { CertificateSettingsInput, SerializedCertificateTemplateDoc } from '@/lib/certificates/types'

const verLabels: Record<string, string> = {
  enabled: 'Public verification enabled', showParticipantName: 'Show participant name',
  showEventName: 'Show event name', showIssueDate: 'Show issue date', showCertificateType: 'Show certificate type',
}

export default function SettingsPanel({ api }: { api: CertApi }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState<CertificateSettingsInput | null>(null)
  const [templates, setTemplates] = useState<SerializedCertificateTemplateDoc[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let on = true
    Promise.all([api.getSettings(), api.getTemplates()])
      .then(([s, t]) => {
        if (!on) return
        setForm(s.settings ? stripMeta(s.settings) : s.defaults)
        setTemplates(t.templates)
      })
      .catch(e => on && setErr(e.message))
      .finally(() => on && setLoading(false))
    return () => { on = false }
  }, [api])

  function set<K extends keyof CertificateSettingsInput>(k: K, v: CertificateSettingsInput[K]) {
    setForm(f => f && { ...f, [k]: v }); setSaved(false)
  }

  async function save() {
    if (!form) return
    setSaving(true); setErr(null)
    try { await api.putSettings(form); setSaved(true) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  if (loading) return <Spinner />
  if (err && !form) return <ErrorBox message={err} />
  if (!form) return null

  return (
    <div className="max-w-2xl space-y-5">
      {/* Enable */}
      <Card>
        <Between>
          <div><p className="text-[14px] font-medium text-foreground">Enable Certificates</p><p className="text-[13px] text-muted-foreground">Allow certificate generation for this event</p></div>
          <Toggle checked={form.enabled} onChange={v => set('enabled', v)} />
        </Between>
      </Card>

      {form.enabled && <>
        {/* Type + trigger + active template */}
        <Card>
          <h3 className="mb-3 text-[14px] font-semibold text-foreground">Generation</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Default Certificate Type</FieldLabel>
              <select className={selectCls} value={form.defaultType} onChange={e => set('defaultType', e.target.value as CertificateSettingsInput['defaultType'])}>
                {CERTIFICATE_TYPES.map(t => <option key={t} value={t}>{CERTIFICATE_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>Trigger</FieldLabel>
              <select className={selectCls} value={form.trigger} onChange={e => set('trigger', e.target.value as CertificateSettingsInput['trigger'])}>
                {CERTIFICATE_TRIGGERS.map(t => <option key={t} value={t}>{CERTIFICATE_TRIGGER_LABELS[t]}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Active Template</FieldLabel>
              <select className={selectCls} value={form.activeTemplateId ?? ''} onChange={e => set('activeTemplateId', e.target.value || null)}>
                <option value="">None selected</option>
                {templates.map(t => <option key={t.templateId} value={t.templateId}>{t.name} ({t.templateType.toUpperCase()})</option>)}
              </select>
            </div>
          </div>
        </Card>

        {/* Verification */}
        <Card>
          <h3 className="mb-3 text-[14px] font-semibold text-foreground">Public Verification</h3>
          <div className="space-y-3">
            {(Object.keys(verLabels) as (keyof CertificateSettingsInput['verification'])[]).map(k => (
              <Between key={k}>
                <span className="text-[14px] text-foreground">{verLabels[k]}</span>
                <Toggle checked={form.verification[k]} onChange={v => set('verification', { ...form.verification, [k]: v })} />
              </Between>
            ))}
          </div>
        </Card>

        {/* Auto email */}
        <Card>
          <Between>
            <h3 className="text-[14px] font-semibold text-foreground">Auto-email on generation</h3>
            <Toggle checked={form.autoEmail.enabled} onChange={v => set('autoEmail', { ...form.autoEmail, enabled: v })} />
          </Between>
          {form.autoEmail.enabled && (
            <div className="mt-4 space-y-3">
              <div><FieldLabel>Subject</FieldLabel><input className={inputCls} value={form.autoEmail.subject} onChange={e => set('autoEmail', { ...form.autoEmail, subject: e.target.value })} /></div>
              <div><FieldLabel>Message</FieldLabel><textarea rows={4} className={inputCls + ' h-auto py-2'} value={form.autoEmail.message} onChange={e => set('autoEmail', { ...form.autoEmail, message: e.target.value })} /></div>
              <p className="text-[12px] text-muted-foreground">Supports placeholders like {'{{participantName}}'}, {'{{eventName}}'}, {'{{certificateId}}'}.</p>
            </div>
          )}
        </Card>
      </>}

      {err && <ErrorBox message={err} />}
      <div className="flex items-center gap-3">
        <button type="button" className={btnPrimary} onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span className="flex items-center gap-1.5 text-[14px] text-emerald-600"><CheckCircle2 className="size-4" /> Saved</span>}
      </div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-card p-5">{children}</div>
}
function Between({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4">{children}</div>
}

// Strip server-managed metadata into the editable input shape.
function stripMeta(s: NonNullable<Awaited<ReturnType<CertApi['getSettings']>>['settings']>): CertificateSettingsInput {
  return {
    enabled: s.enabled, defaultType: s.defaultType, trigger: s.trigger, activeTemplateId: s.activeTemplateId,
    verification: s.verification, autoEmail: s.autoEmail, download: s.download,
  }
}
