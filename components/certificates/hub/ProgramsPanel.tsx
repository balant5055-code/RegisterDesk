'use client'

// GA-7D S3 — Programs & Assignment. Surfaces the EXISTING assignment engine
// (lib/certificates/assignment) and the settings.assignmentRules schema through a
// visual, non-technical rule builder. No new engine, no scripting: each rule reads
// one participant field with an existing operator and routes to a program (an
// existing certificate template). Rules are saved via the existing settings PATCH;
// the existing /resolve endpoint powers the live preview.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, Loader2, Save, FlaskConical, Info } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Spinner, ErrorBox, Badge, inputCls, selectCls, btnPrimary, btnGhost } from './ui'
import { RULE_OPS, type RuleOp, type AssignmentRule } from '@/lib/certificates/assignment'
import type { CertApi, CertResolveResponse } from './api'
import type { SerializedCertificateTemplateDoc, CertificateSettings, CertificateSettingsInput, CertificateType } from '@/lib/certificates/types'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

const OP_LABELS: Record<RuleOp, string> = {
  eq: 'is', neq: 'is not', lt: 'less than', lte: 'at most', gt: 'greater than',
  gte: 'at least', in: 'is one of', contains: 'contains', exists: 'is present', isTrue: 'is true',
}
const NO_VALUE_OPS = new Set<RuleOp>(['exists', 'isTrue'])
const FIELD_SUGGESTIONS = ['passType', 'passName', 'category', 'bibCategory', 'company', 'designation', 'checkedIn', 'status', 'bibNumber']
const CERT_TYPES: CertificateType[] = ['participation', 'completion', 'achievement', 'winner', 'runner_up', 'volunteer', 'speaker', 'sponsor', 'custom']

interface EditRule {
  id: string; label: string; field: string; op: RuleOp; value: string; templateId: string; certificateType: CertificateType
}

function randId() { return `rule_${Math.random().toString(36).slice(2, 9)}` }

function toEdit(r: AssignmentRule): EditRule {
  return {
    id: r.id || randId(),
    label: r.label ?? '',
    field: r.field,
    op: r.op,
    value: Array.isArray(r.value) ? r.value.join(', ') : (r.value == null ? '' : String(r.value)),
    templateId: r.templateId,
    certificateType: r.certificateType ?? 'participation',
  }
}
function toRule(e: EditRule): AssignmentRule {
  const base: AssignmentRule = {
    id: e.id, field: e.field.trim(), op: e.op, templateId: e.templateId,
    certificateType: e.certificateType, label: e.label.trim() || undefined,
  }
  if (!NO_VALUE_OPS.has(e.op)) {
    base.value = e.op === 'in'
      ? e.value.split(',').map(s => s.trim()).filter(Boolean)
      : e.value.trim()
  }
  return base
}

export default function ProgramsPanel({ api }: { api: CertApi }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<CertificateSettings | CertificateSettingsInput | null>(null)
  const [templates, setTemplates] = useState<SerializedCertificateTemplateDoc[]>([])
  const [rules, setRules] = useState<EditRule[]>([])
  const [dirty, setDirty] = useState(false)

  // Preview
  const [attendees, setAttendees] = useState<SerializedRegistration[]>([])
  const [previewRegId, setPreviewRegId] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<CertResolveResponse | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    const [s, t] = await Promise.all([api.getSettings(), api.getTemplates()])
    const eff = s.settings ?? s.defaults
    setSettings(eff)
    setTemplates(t.templates)
    setRules((eff.assignmentRules ?? []).map(toEdit))
    setDirty(false)
  }, [api])

  useEffect(() => { load().catch(e => setErr(e.message)).finally(() => setLoading(false)) }, [load])

  const templateName = useMemo(() => {
    const m = new Map(templates.map(t => [t.templateId, t.name]))
    return (id: string) => m.get(id) ?? '—'
  }, [templates])

  const activeTemplateId = settings?.activeTemplateId ?? null
  const defaultType = settings?.defaultType ?? 'participation'

  function mutate(next: EditRule[]) { setRules(next); setDirty(true) }
  function patchRule(i: number, patch: Partial<EditRule>) { mutate(rules.map((r, idx) => idx === i ? { ...r, ...patch } : r)) }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules];[next[i], next[j]] = [next[j], next[i]]; mutate(next)
  }

  async function save() {
    // Every rule must target a program (template).
    const missing = rules.find(r => !r.templateId)
    if (missing) { setErr('Every rule must select a program (template).'); return }
    setSaving(true); setErr(null)
    try {
      await api.patchSettings({ assignmentRules: rules.map(toRule) })
      setDirty(false)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  async function runPreview() {
    if (!previewRegId) return
    setPreviewing(true); setErr(null); setPreview(null)
    try { setPreview(await api.resolvePreview(previewRegId)) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Preview failed') }
    finally { setPreviewing(false) }
  }

  async function loadAttendees() {
    if (attendees.length) return
    try { setAttendees((await api.getConfirmedAttendees()).registrations) }
    catch { /* preview is optional */ }
  }

  if (loading) return <Spinner />

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-[13px] text-muted-foreground">
          Programs route different participants to different certificate templates. Rules run top-to-bottom and the
          <span className="font-medium text-foreground"> first match wins</span>. If none match, the default program below is used —
          so single-template events are unaffected.
        </p>
      </div>

      {err && <ErrorBox message={err} />}

      {/* Rules */}
      <div className="space-y-3">
        {rules.map((r, i) => (
          <div key={r.id} className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <input
                className={cn(inputCls, 'h-8 max-w-[240px]')}
                placeholder={`Program ${i + 1} name (optional)`}
                value={r.label}
                onChange={e => patchRule(i, { label: e.target.value })}
              />
              <div className="flex items-center gap-1">
                <button type="button" className={btnGhost} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></button>
                <button type="button" className={btnGhost} title="Move down" disabled={i === rules.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></button>
                <button type="button" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')} title="Remove" onClick={() => mutate(rules.filter((_, idx) => idx !== i))}><Trash2 className="size-3.5" /></button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">When</span>
              <div className="flex flex-wrap items-center gap-2">
                <input list="cert-fields" className={cn(inputCls, 'h-8 w-40')} placeholder="field" value={r.field} onChange={e => patchRule(i, { field: e.target.value })} />
                <select className={cn(selectCls, 'h-8 w-40')} value={r.op} onChange={e => patchRule(i, { op: e.target.value as RuleOp })}>
                  {RULE_OPS.map(op => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
                </select>
                {!NO_VALUE_OPS.has(r.op) && (
                  <input className={cn(inputCls, 'h-8 w-44')} placeholder={r.op === 'in' ? 'a, b, c' : 'value'} value={r.value} onChange={e => patchRule(i, { value: e.target.value })} />
                )}
              </div>

              <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Issue</span>
              <div className="flex flex-wrap items-center gap-2">
                <select className={cn(selectCls, 'h-8 w-52', !r.templateId && 'text-muted-foreground')} value={r.templateId} onChange={e => patchRule(i, { templateId: e.target.value })}>
                  <option value="">Select a template…</option>
                  {templates.map(t => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
                </select>
                <span className="text-[12px] text-muted-foreground">as</span>
                <select className={cn(selectCls, 'h-8 w-40')} value={r.certificateType} onChange={e => patchRule(i, { certificateType: e.target.value as CertificateType })}>
                  {CERT_TYPES.map(ct => <option key={ct} value={ct}>{ct.replace('_', ' ')}</option>)}
                </select>
              </div>
            </div>
          </div>
        ))}
        <datalist id="cert-fields">{FIELD_SUGGESTIONS.map(f => <option key={f} value={f} />)}</datalist>

        <button type="button" className={btnGhost} onClick={() => mutate([...rules, { id: randId(), label: '', field: 'passType', op: 'eq', value: '', templateId: '', certificateType: 'participation' }])}>
          <Plus className="size-3.5" /> Add program rule
        </button>
      </div>

      {/* Default program (fallback) */}
      <div className="rounded-xl border border-dashed border-border bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <Badge tone="gray">Default program</Badge>
          <p className="text-[13px] text-foreground">
            {activeTemplateId ? templateName(activeTemplateId) : 'No active template'} · <span className="capitalize">{defaultType.replace('_', ' ')}</span>
          </p>
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">Used when no rule above matches. Set the active template in the Templates tab.</p>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button type="button" className={btnPrimary} disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save programs
        </button>
        {dirty && <span className="text-[12px] text-muted-foreground">Unsaved changes</span>}
      </div>

      {/* Preview */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <FlaskConical className="size-4 text-primary" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Test a participant</p>
        </div>
        <p className="mb-3 text-[12px] text-muted-foreground">See which program a specific attendee resolves to (uses your saved rules).</p>
        <div className="flex flex-wrap items-center gap-2">
          <select className={cn(selectCls, 'h-9 max-w-[320px]')} value={previewRegId} onFocus={() => void loadAttendees()} onChange={e => setPreviewRegId(e.target.value)}>
            <option value="">Select an attendee…</option>
            {attendees.map(a => <option key={a.id} value={a.id}>{a.attendee?.name || a.ticketCode || a.id}{a.passName ? ` · ${a.passName}` : ''}</option>)}
          </select>
          <button type="button" className={btnGhost} disabled={!previewRegId || previewing} onClick={() => void runPreview()}>
            {previewing ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />} Test
          </button>
        </div>

        {preview && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={preview.resolved.isDefault ? 'gray' : 'green'}>{preview.resolved.isDefault ? 'Default program' : (preview.resolved.ruleLabel || 'Matched rule')}</Badge>
              <span className="text-foreground">→ {preview.resolved.programTemplateName ?? '—'}</span>
              <span className="text-muted-foreground">as</span>
              <span className="capitalize text-foreground">{preview.resolved.certificateType.replace('_', ' ')}</span>
            </div>
            <details className="text-[12px] text-muted-foreground">
              <summary className="cursor-pointer select-none">Fields evaluated</summary>
              <div className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {Object.entries(preview.context).filter(([, v]) => v !== '' && v != null).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><span className="truncate text-foreground">{String(v)}</span></div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
