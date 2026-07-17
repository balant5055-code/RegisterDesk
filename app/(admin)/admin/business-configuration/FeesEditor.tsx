'use client'

// Specialized editor for the Fees section. Handles the two nullable overrides
// (platformFeePercent / donationPlatformFee — null = inherit the per-license fee
// matrix) and the rounding-mode enum, which the flat SectionEditor can't. Reuses
// the config page's draft workflow + the engine's own validator. Some fields are
// reserved (defined but not yet enforced — see RD-CONF-06).

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Undo2, RotateCcw } from 'lucide-react'
import { CONFIG_SECTION_REGISTRY, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

type SectionDraft = Record<string, unknown>
const toDraft = (v: unknown): SectionDraft => JSON.parse(JSON.stringify(v ?? {})) as SectionDraft
const inputCls = 'h-8 rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}>
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

function OverrideRow({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const enabled = value !== null
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={e => onChange(e.target.checked ? 0 : null)} /> Override
        </label>
        <input type="number" disabled={!enabled}
          value={enabled ? String(value) : ''} placeholder="matrix"
          onChange={e => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
          className={cn(inputCls, 'w-24', !enabled && 'opacity-50')} />
        <span className="text-[11px] text-muted-foreground">%</span>
      </div>
    </div>
  )
}

function NumberField({ label, value, onChange, unit }: { label: string; value: unknown; onChange: (v: number) => void; unit?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}{unit ? ` (${unit})` : ''}</span>
      <input type="number" value={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
        onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className={cn(inputCls, 'w-full')} />
    </label>
  )
}

function BoolField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: boolean) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <div className="flex h-8 items-center gap-2"><Toggle checked={value === true} onChange={onChange} /><span className="text-[11.5px] text-muted-foreground">{value === true ? 'On' : 'Off'}</span></div>
    </label>
  )
}

function TextField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <input value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} className={cn(inputCls, 'w-full')} />
    </label>
  )
}

function SelectField({ label, value, options, onChange }: { label: string; value: unknown; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <select value={typeof value === 'string' ? value : options[0]} onChange={e => onChange(e.target.value)} className={cn(inputCls, 'w-full')}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

export function FeesEditor({
  published, draft, onDraftChange, onPublish, publishing,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
}) {
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY.fees.validate(draft), [draft])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])
  const set = (key: string, value: unknown) => onDraftChange({ ...draft, [key]: value })

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-bold text-foreground">Fees</h2>
        {dirty ? <Badge variant="warning" className="text-[11px]">Draft</Badge> : <Badge variant="outline" className="text-[11px]">Published</Badge>}
        {validation.valid ? <Badge variant="success" className="text-[11px]">Valid</Badge> : <Badge variant="destructive" className="text-[11px]">{validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || publishing} onClick={() => onDraftChange({ ...published })}><Undo2 className="size-3.5" /> Revert</Button>
          <Button type="button" variant="ghost" size="sm" disabled={publishing} onClick={() => onDraftChange(toDraft(BUSINESS_CONFIG_DEFAULTS.fees))}><RotateCcw className="size-3.5" /> Defaults</Button>
          <Button type="button" variant="primary" size="sm" disabled={!dirty || !validation.valid || publishing} isLoading={publishing} onClick={onPublish}>Publish</Button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Platform fee</p>
          <p className="mb-2 text-[11px] text-muted-foreground">Override unchecked = inherit the per-license fee matrix. Type/flat/min/max are reserved (defined; the per-transaction calculation is unchanged).</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <BoolField label="Platform fee enabled" value={draft.platformFeeEnabled} onChange={v => set('platformFeeEnabled', v)} />
            <OverrideRow label="Platform fee %" value={(draft.platformFeePercent as number | null) ?? null} onChange={v => set('platformFeePercent', v)} />
            <OverrideRow label="Donation platform fee %" value={(draft.donationPlatformFee as number | null) ?? null} onChange={v => set('donationPlatformFee', v)} />
            <SelectField label="Calc type" value={draft.platformFeeType} options={['percentage', 'flat']} onChange={v => set('platformFeeType', v)} />
            <NumberField label="Flat amount" value={draft.platformFeeFlatPaise} onChange={v => set('platformFeeFlatPaise', v)} unit="paise" />
            <NumberField label="Min fee (0=none)" value={draft.platformFeeMinPaise} onChange={v => set('platformFeeMinPaise', v)} unit="paise" />
            <NumberField label="Max fee (0=uncapped)" value={draft.platformFeeMaxPaise} onChange={v => set('platformFeeMaxPaise', v)} unit="paise" />
            <TextField label="Display name" value={draft.platformFeeDisplayName} onChange={v => set('platformFeeDisplayName', v)} />
            <TextField label="Description" value={draft.platformFeeDescription} onChange={v => set('platformFeeDescription', v)} />
          </div>
        </div>

        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Gateway fee</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <BoolField label="Gateway fee enabled" value={draft.gatewayFeeEnabled} onChange={v => set('gatewayFeeEnabled', v)} />
            <SelectField label="Calc type" value={draft.gatewayFeeType} options={['percentage', 'flat']} onChange={v => set('gatewayFeeType', v)} />
            <NumberField label="Gateway fee %" value={draft.gatewayFeePercent} onChange={v => set('gatewayFeePercent', v)} />
            <NumberField label="Flat amount" value={draft.gatewayFeeFlatPaise} onChange={v => set('gatewayFeeFlatPaise', v)} unit="paise" />
            <TextField label="Provider override" value={draft.gatewayProvider} onChange={v => set('gatewayProvider', v)} />
            <NumberField label="Min fee (0=none)" value={draft.gatewayFeeMinPaise} onChange={v => set('gatewayFeeMinPaise', v)} unit="paise" />
            <NumberField label="Max fee (0=uncapped)" value={draft.gatewayFeeMaxPaise} onChange={v => set('gatewayFeeMaxPaise', v)} unit="paise" />
            <TextField label="Description" value={draft.gatewayFeeDescription} onChange={v => set('gatewayFeeDescription', v)} />
          </div>
        </div>

        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">GST</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <BoolField label="GST enabled" value={draft.gstEnabled} onChange={v => set('gstEnabled', v)} />
            <NumberField label="GST %" value={draft.gstPercent} onChange={v => set('gstPercent', v)} />
            <BoolField label="Tax inclusive" value={draft.gstInclusive} onChange={v => set('gstInclusive', v)} />
            <TextField label="Description" value={draft.gstDescription} onChange={v => set('gstDescription', v)} />
          </div>
        </div>

        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Fee collection method</p>
          <p className="mb-2 text-[11px] text-muted-foreground">Default mode for who bears the fees. &lsquo;mixed&rsquo; is reserved for a future split model.</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField label="Default mode" value={draft.feeCollectionMethod} options={['attendee', 'organizer', 'mixed']} onChange={v => set('feeCollectionMethod', v)} />
            <TextField label="Description" value={draft.feeCollectionDescription} onChange={v => set('feeCollectionDescription', v)} />
          </div>
        </div>

        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Other charges</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <BoolField label="Convenience fee enabled" value={draft.convenienceFeeEnabled} onChange={v => set('convenienceFeeEnabled', v)} />
            <NumberField label="Convenience fee %" value={draft.convenienceFeePercent} onChange={v => set('convenienceFeePercent', v)} />
            <NumberField label="Refund processing fee" value={draft.refundProcessingFee} onChange={v => set('refundProcessingFee', v)} unit="paise" />
          </div>
        </div>

        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Policy</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <BoolField label="Allow organizer absorb fee" value={draft.allowOrganizerAbsorbFee} onChange={v => set('allowOrganizerAbsorbFee', v)} />
            <BoolField label="Allow attendee absorb fee" value={draft.allowAttendeeAbsorbFee} onChange={v => set('allowAttendeeAbsorbFee', v)} />
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Currency</span>
              <input value={typeof draft.currency === 'string' ? draft.currency : ''} onChange={e => set('currency', e.target.value)} className={cn(inputCls, 'w-full')} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Rounding mode</span>
              <select value={typeof draft.roundingMode === 'string' ? draft.roundingMode : 'round'} onChange={e => set('roundingMode', e.target.value)} className={cn(inputCls, 'w-full')}>
                <option value="round">round</option>
                <option value="floor">floor</option>
                <option value="ceil">ceil</option>
              </select>
            </label>
          </div>
        </div>

        {!validation.valid && (
          <ul className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            {validation.errors.map((err, i) => <li key={i}>• {err}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
