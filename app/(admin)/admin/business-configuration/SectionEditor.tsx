'use client'

// Editor for a single configuration section. Renders inputs from the field
// descriptors, validates the draft with the ENGINE's own validators (reused from
// lib/config/businessConfig — Step 6), and reports dirty/validity + publish intent
// upward. It edits ONLY its own section's schema.

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RotateCcw, Undo2 } from 'lucide-react'
import {
  CONFIG_SECTION_REGISTRY,
  BUSINESS_CONFIG_DEFAULTS,
  CENTRAL_PRICING_FIELDS,
  SUPER_ADMIN_ONLY_FIELDS,
  type BusinessConfigSectionKey,
} from '@/lib/config/businessConfig'
import { SECTION_FIELDS, SECTION_LABELS, type FieldDef } from './fields'

type SectionDraft = Record<string, unknown>

// Widen a typed section value into an editable plain draft (deep copy so the
// engine's default objects are never mutated).
const toDraft = (v: unknown): SectionDraft => JSON.parse(JSON.stringify(v ?? {})) as SectionDraft

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

function FieldRow({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-foreground">{def.label}</span>
      {def.kind === 'boolean' ? (
        <div className="flex h-9 items-center">
          <Toggle checked={value === true} onChange={onChange} disabled={def.readOnly} />
          <span className="ml-2 text-[12px] text-muted-foreground">{value === true ? 'Enabled' : 'Disabled'}</span>
        </div>
      ) : def.kind === 'select' ? (
        <select
          disabled={def.readOnly}
          value={typeof value === 'string' ? value : (def.options?.[0] ?? '')}
          onChange={e => onChange(e.target.value)}
          className={cn(
            'h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground',
            'focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15',
            def.readOnly && 'cursor-not-allowed opacity-60',
          )}
        >
          {(def.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={def.kind === 'number' ? 'number' : 'text'}
          readOnly={def.readOnly}
          value={def.kind === 'number' ? (typeof value === 'number' && Number.isFinite(value) ? String(value) : '') : (typeof value === 'string' ? value : '')}
          onChange={e => onChange(def.kind === 'number' ? (e.target.value === '' ? NaN : Number(e.target.value)) : e.target.value)}
          className={cn(
            'h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground',
            'focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15',
            def.readOnly && 'cursor-not-allowed opacity-60',
          )}
        />
      )}
      {def.hint && <span className="text-[11px] text-muted-foreground">{def.hint}</span>}
    </label>
  )
}

export function SectionEditor({
  sectionKey, published, draft, onDraftChange, onPublish, publishing, canEditPricing = false,
}: {
  sectionKey:    BusinessConfigSectionKey
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
  /** RD-PHASE4-S2 — server-decided. Fields in CENTRAL_PRICING_FIELDS (e.g. settlement fee/tax) lock without it. */
  canEditPricing?: boolean
}) {
  const pricingList = CENTRAL_PRICING_FIELDS[sectionKey]
  const lockedKeys  = new Set(canEditPricing ? [] : pricingList === '*' ? SECTION_FIELDS[sectionKey].map(d => d.key) : (pricingList ?? []))
  // RD-WALLET-CFG-01 — Super Admin-only fields are not SHOWN to anyone else (the server already left
  // them out of the response, and refuses any change to them — this is presentation, not the boundary).
  const hiddenKeys = useMemo(() => new Set(canEditPricing ? [] : (SUPER_ADMIN_ONLY_FIELDS[sectionKey] ?? [])), [canEditPricing, sectionKey])
  const withoutHidden = (d: SectionDraft): SectionDraft => Object.fromEntries(Object.entries(d).filter(([k]) => !hiddenKeys.has(k)))
  // The section validator needs every field; a hidden one is validated as its code default (the
  // server validates the real stored value on save).
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY[sectionKey].validate(
    hiddenKeys.size > 0 ? { ...toDraft(BUSINESS_CONFIG_DEFAULTS[sectionKey]), ...draft } : draft,
  ), [sectionKey, draft, hiddenKeys])
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])

  const setField = (key: string, value: unknown) => onDraftChange({ ...draft, [key]: value })

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-bold text-foreground">{SECTION_LABELS[sectionKey]}</h2>
        {dirty
          ? <Badge variant="warning" className="text-[11px]">Draft</Badge>
          : <Badge variant="outline" className="text-[11px]">Published</Badge>}
        {validation.valid
          ? <Badge variant="success" className="text-[11px]">Valid</Badge>
          : <Badge variant="destructive" className="text-[11px]">{validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || publishing} onClick={() => onDraftChange({ ...published })}>
            <Undo2 className="size-3.5" /> Revert
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={publishing} onClick={() => onDraftChange(withoutHidden(toDraft(BUSINESS_CONFIG_DEFAULTS[sectionKey])))}>
            <RotateCcw className="size-3.5" /> Defaults
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={!dirty || !validation.valid || publishing} isLoading={publishing} onClick={onPublish}>
            Publish
          </Button>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {SECTION_FIELDS[sectionKey].filter(def => !hiddenKeys.has(def.key)).map(def => (
            <FieldRow key={def.key} def={lockedKeys.has(def.key) ? { ...def, readOnly: true } : def} value={draft[def.key]} onChange={v => setField(def.key, v)} />
          ))}
        </div>

        {hiddenKeys.size > 0 && (
          <p className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
            Financial controls (negative balance, freeze, refunds and top-up limits) are managed by a Super Admin and are not shown here.
          </p>
        )}

        {!validation.valid && (
          <ul className="mt-4 space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            {validation.errors.map((err, i) => <li key={i}>• {err}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
