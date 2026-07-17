'use client'

// Specialized editor for the Communication section (nested email/whatsapp/sms/
// general). Reuses the config page's draft workflow + the engine's own validator.
// Some fields are reserved (defined in config but not yet enforced at runtime — see
// RD-CONF-04); they are still editable here so future wiring needs no UI change.

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Undo2, RotateCcw } from 'lucide-react'
import { CONFIG_SECTION_REGISTRY, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

type SectionDraft = Record<string, unknown>
type SubKey       = 'email' | 'whatsapp' | 'sms' | 'certificates' | 'general'
type FieldKind    = 'text' | 'number' | 'boolean'
interface FieldSpec { key: string; label: string; kind: FieldKind }

const toDraft = (v: unknown): SectionDraft => JSON.parse(JSON.stringify(v ?? {})) as SectionDraft

// Shared commercial fields every channel exposes (GA-3 S4A).
const COMMERCIAL_FIELDS: FieldSpec[] = [
  { key: 'displayName',   label: 'Display name', kind: 'text' },
  { key: 'description',   label: 'Description', kind: 'text' },
  { key: 'billingMode',   label: 'Billing mode (free|wallet|settlement)', kind: 'text' },
  { key: 'pricePaise',    label: 'Price (paise / unit)', kind: 'number' },
  { key: 'freeAllowance', label: 'Free allowance (units)', kind: 'number' },
  { key: 'walletBilling', label: 'Wallet billing', kind: 'boolean' },
]

const SUBSECTIONS: Array<{ key: SubKey; title: string; fields: FieldSpec[] }> = [
  { key: 'email', title: 'Email', fields: [
    { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    { key: 'provider', label: 'Provider', kind: 'text' },
    ...COMMERCIAL_FIELDS,
    { key: 'fromName', label: 'From name', kind: 'text' },
    { key: 'replyTo', label: 'Reply-to', kind: 'text' },
    { key: 'freeForAllLicenses', label: 'Free for all licenses', kind: 'boolean' },
    { key: 'dailyLimit', label: 'Daily limit (0=∞)', kind: 'number' },
    { key: 'hourlyLimit', label: 'Hourly limit (0=∞)', kind: 'number' },
    { key: 'sesRegion', label: 'SES region', kind: 'text' },
    { key: 'sesSender', label: 'SES sender', kind: 'text' },
    { key: 'sesReplyTo', label: 'SES reply-to', kind: 'text' },
  ] },
  { key: 'whatsapp', title: 'WhatsApp', fields: [
    { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    { key: 'provider', label: 'Provider', kind: 'text' },
    ...COMMERCIAL_FIELDS,
    { key: 'freeOrganizerNotifications', label: 'Free organizer notifications', kind: 'boolean' },
    { key: 'walletChargeAttendeeNotifications', label: 'Charge attendee to wallet', kind: 'boolean' },
    { key: 'defaultLanguage', label: 'Default language', kind: 'text' },
    { key: 'apiVersion', label: 'API version', kind: 'text' },
    { key: 'dailyLimit', label: 'Daily limit (0=∞)', kind: 'number' },
    { key: 'hourlyLimit', label: 'Hourly limit (0=∞)', kind: 'number' },
  ] },
  { key: 'sms', title: 'SMS', fields: [
    { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    { key: 'provider', label: 'Provider', kind: 'text' },
    ...COMMERCIAL_FIELDS,
    { key: 'dailyLimit', label: 'Daily limit (0=∞)', kind: 'number' },
    { key: 'hourlyLimit', label: 'Hourly limit (0=∞)', kind: 'number' },
  ] },
  { key: 'certificates', title: 'Certificates', fields: [
    { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    { key: 'provider', label: 'Provider', kind: 'text' },
    ...COMMERCIAL_FIELDS,
  ] },
  { key: 'general', title: 'General', fields: [
    { key: 'retryEnabled', label: 'Retry enabled', kind: 'boolean' },
    { key: 'retryCount', label: 'Retry count', kind: 'number' },
    { key: 'queueEnabled', label: 'Queue enabled', kind: 'boolean' },
    { key: 'communicationLogEnabled', label: 'Communication log', kind: 'boolean' },
  ] },
]

const inputCls = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}>
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

export function CommunicationEditor({
  published, draft, onDraftChange, onPublish, publishing,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
}) {
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY.communication.validate(draft), [draft])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])

  const setField = (sub: SubKey, key: string, value: unknown) => {
    const cur = { ...((draft[sub] as Record<string, unknown> | undefined) ?? {}) }
    cur[key] = value
    onDraftChange({ ...draft, [sub]: cur })
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-bold text-foreground">Communication</h2>
        {dirty ? <Badge variant="warning" className="text-[11px]">Draft</Badge> : <Badge variant="outline" className="text-[11px]">Published</Badge>}
        {validation.valid ? <Badge variant="success" className="text-[11px]">Valid</Badge> : <Badge variant="destructive" className="text-[11px]">{validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || publishing} onClick={() => onDraftChange({ ...published })}><Undo2 className="size-3.5" /> Revert</Button>
          <Button type="button" variant="ghost" size="sm" disabled={publishing} onClick={() => onDraftChange(toDraft(BUSINESS_CONFIG_DEFAULTS.communication))}><RotateCcw className="size-3.5" /> Defaults</Button>
          <Button type="button" variant="primary" size="sm" disabled={!dirty || !validation.valid || publishing} isLoading={publishing} onClick={onPublish}>Publish</Button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {SUBSECTIONS.map(sub => {
          const val = (draft[sub.key] as Record<string, unknown> | undefined) ?? {}
          return (
            <div key={sub.key} className="rounded-lg border border-border/70 p-3">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{sub.title}</p>
              <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {sub.fields.map(f => (
                  <label key={f.key} className="flex flex-col gap-1">
                    <span className="text-[11.5px] text-muted-foreground">{f.label}</span>
                    {f.kind === 'boolean' ? (
                      <div className="flex h-8 items-center gap-2"><Toggle checked={val[f.key] === true} onChange={v => setField(sub.key, f.key, v)} /><span className="text-[11.5px] text-muted-foreground">{val[f.key] === true ? 'On' : 'Off'}</span></div>
                    ) : (
                      <input
                        type={f.kind === 'number' ? 'number' : 'text'}
                        value={f.kind === 'number' ? (typeof val[f.key] === 'number' && Number.isFinite(val[f.key]) ? String(val[f.key]) : '') : (typeof val[f.key] === 'string' ? String(val[f.key]) : '')}
                        onChange={e => setField(sub.key, f.key, f.kind === 'number' ? (e.target.value === '' ? NaN : Number(e.target.value)) : e.target.value)}
                        className={inputCls}
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          )
        })}

        {!validation.valid && (
          <ul className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            {validation.errors.map((err, i) => <li key={i}>• {err}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
