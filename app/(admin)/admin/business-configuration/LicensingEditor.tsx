'use client'

// Specialized editor for the Licensing section — the flat SectionEditor can't edit
// the per-tier `tierOverrides` map. Each field is pre-filled with the EFFECTIVE
// value (eventLicense.ts default ⊕ current override); editing a field writes only
// that delta into the override, so untouched tiers keep inheriting the code default.
// Validation reuses the engine's own licensing validator.

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Undo2, RotateCcw } from 'lucide-react'
import {
  CONFIG_SECTION_REGISTRY,
  BUSINESS_CONFIG_DEFAULTS,
  type LicenseTierOverride,
} from '@/lib/config/businessConfig'
import {
  EVENT_LICENSE_TIERS,
  getEventLicenseDefinition,
  isUnlimited,
  type EventLicenseTier,
  type EventLicenseFeature,
} from '@/lib/licensing/eventLicense'

type SectionDraft   = Record<string, unknown>
type OverrideMap    = Partial<Record<EventLicenseTier, LicenseTierOverride>>
const FEATURE_KEYS  = Object.keys(getEventLicenseDefinition('starter').features) as EventLicenseFeature[]
const toDraft = (v: unknown): SectionDraft => JSON.parse(JSON.stringify(v ?? {})) as SectionDraft

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}>
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

const inputCls = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'

export function LicensingEditor({
  published, draft, onDraftChange, onPublish, publishing,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
}) {
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY.licensing.validate(draft), [draft])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])

  const overrides = (draft.tierOverrides && typeof draft.tierOverrides === 'object' && !Array.isArray(draft.tierOverrides) ? draft.tierOverrides : {}) as OverrideMap
  const setTop = (key: 'defaultCurrency' | 'purchasesEnabled', value: unknown) => onDraftChange({ ...draft, [key]: value })
  const setOverride = (tier: EventLicenseTier, patch: Partial<LicenseTierOverride>) => {
    const next: OverrideMap = { ...overrides, [tier]: { ...(overrides[tier] ?? {}), ...patch } }
    onDraftChange({ ...draft, tierOverrides: next })
  }
  const setFeature = (tier: EventLicenseTier, f: EventLicenseFeature, on: boolean) => {
    const cur = overrides[tier] ?? {}
    setOverride(tier, { features: { ...(cur.features ?? {}), [f]: on } })
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-bold text-foreground">Licensing</h2>
        {dirty ? <Badge variant="warning" className="text-[11px]">Draft</Badge> : <Badge variant="outline" className="text-[11px]">Published</Badge>}
        {validation.valid ? <Badge variant="success" className="text-[11px]">Valid</Badge> : <Badge variant="destructive" className="text-[11px]">{validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || publishing} onClick={() => onDraftChange({ ...published })}><Undo2 className="size-3.5" /> Revert</Button>
          <Button type="button" variant="ghost" size="sm" disabled={publishing} onClick={() => onDraftChange(toDraft(BUSINESS_CONFIG_DEFAULTS.licensing))}><RotateCcw className="size-3.5" /> Defaults</Button>
          <Button type="button" variant="primary" size="sm" disabled={!dirty || !validation.valid || publishing} isLoading={publishing} onClick={onPublish}>Publish</Button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {/* Top-level operational settings */}
        <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-foreground">Default currency</span>
            <input value={typeof draft.defaultCurrency === 'string' ? draft.defaultCurrency : ''} onChange={e => setTop('defaultCurrency', e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-foreground">License purchases enabled</span>
            <div className="flex h-8 items-center gap-2"><Toggle checked={draft.purchasesEnabled === true} onChange={v => setTop('purchasesEnabled', v)} /><span className="text-[12px] text-muted-foreground">{draft.purchasesEnabled === true ? 'Enabled' : 'Disabled'}</span></div>
          </label>
        </div>

        {/* Per-tier overrides */}
        {EVENT_LICENSE_TIERS.map(tier => {
          const base = getEventLicenseDefinition(tier)
          const ov   = overrides[tier] ?? {}
          const effName  = ov.name ?? base.name
          const effPrice = ov.licensePricePaise ?? base.licensePricePaise
          const effReg   = ov.maxRegistrations === undefined ? base.limits.maxRegistrations : (ov.maxRegistrations === null ? Infinity : ov.maxRegistrations)
          const unlimited = isUnlimited(effReg)
          const effFeatures = { ...base.features, ...(ov.features ?? {}) }
          const effFeatureList = ov.featureList ?? base.featureList
          return (
            <div key={tier} className="rounded-lg border border-border/70 p-3">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{base.name}</p>
              <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-muted-foreground">Name</span>
                  <input value={effName} onChange={e => setOverride(tier, { name: e.target.value })} className={inputCls} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-muted-foreground">Price (paise)</span>
                  <input type="number" value={Number.isFinite(effPrice) ? String(effPrice) : ''} onChange={e => setOverride(tier, { licensePricePaise: e.target.value === '' ? NaN : Number(e.target.value) })} className={inputCls} />
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-muted-foreground">Max registrations</span>
                  <div className="flex items-center gap-2">
                    <input type="number" disabled={unlimited} value={unlimited ? '' : String(effReg)} onChange={e => setOverride(tier, { maxRegistrations: e.target.value === '' ? NaN : Number(e.target.value) })} className={cn(inputCls, unlimited && 'opacity-50')} />
                    <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <input type="checkbox" checked={unlimited} onChange={e => setOverride(tier, { maxRegistrations: e.target.checked ? null : base.limits.maxRegistrations })} />∞
                    </label>
                  </div>
                </div>
              </div>

              <div className="mt-2.5">
                <span className="text-[11.5px] text-muted-foreground">Features</span>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                  {FEATURE_KEYS.map(f => (
                    <label key={f} className="flex items-center gap-1.5 text-[11.5px] text-foreground">
                      <Toggle checked={effFeatures[f] === true} onChange={v => setFeature(tier, f, v)} />{f}
                    </label>
                  ))}
                </div>
              </div>

              <label className="mt-2.5 flex flex-col gap-1">
                <span className="text-[11.5px] text-muted-foreground">Feature list (one per line)</span>
                <textarea rows={3} value={effFeatureList.join('\n')} onChange={e => setOverride(tier, { featureList: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15" />
              </label>
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
