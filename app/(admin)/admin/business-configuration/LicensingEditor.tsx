'use client'

// Specialized editor for the Licensing section: the capacity commercial model, license coupons and
// the prepaid service allowances (WhatsApp, certificates, photos). Validation reuses the engine's
// own licensing validator.
//
// RD-LEGACY-01 — the retired licence-tier model (Free / Starter / Professional / Business /
// Enterprise prices, limits and feature switches) is NOT editable here any more. Stored
// `tierOverrides` / `tierOverridesV2` values are left exactly as they are (the draft is a copy of
// the published section, so a publish passes them through unchanged); they are read only to
// interpret historical tier licences and orders.

import { useMemo, useState } from 'react'
import { parseRupeesToPaise, paiseToRupeesInput } from '@/lib/licensing/moneyInput'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Undo2, RotateCcw } from 'lucide-react'
import {
  CONFIG_SECTION_REGISTRY,
  BUSINESS_CONFIG_DEFAULTS,
  type LicenseCouponsConfig,
} from '@/lib/config/businessConfig'
import {
  DEFAULT_COMMERCIAL_TERMS, COMMERCIAL_TERM_KEYS, validateCommercialTerms,
  type CommercialTerms,
} from '@/lib/licensing/capacityCommercial'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import {
  SERVICE_KINDS, SERVICE_LABELS, EXHAUSTION_POLICIES, normalizeServiceAllowances, serviceAvailability,
  validateServiceAllowances, priceServiceItem, serviceSaleReadinessErrors,
  type ServiceKind, type PrepaidServiceConfig,
} from '@/lib/licensing/serviceAllowances'
import {
  badgeSettingsOf, badgeSettingsChanged, defaultBadgeSettings,
  describeBadgeSettingsProblems, badgePriceHint, BADGE_REASON_GUIDANCE, type BadgeSettingsField,
} from '@/lib/licensing/printBadgeSettings'
import { PRINT_BADGE_CHARGEABLE_ASSET_TYPES } from '@/lib/licensing/printBadgeCommercial'

/** RD-PRINT-BILL-P2 — the sellable services only (a catalog-only service never joins their checks). */
const sellableOnly = (v: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(v).filter(([k]) => (SERVICE_KINDS as readonly string[]).includes(k)))

type SectionDraft   = Record<string, unknown>
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

/**
 * RD-EVENT-COMMERCE-05A — a price typed in RUPEES ("0.20", "1.90") and stored in integer PAISE
 * (20, 190). The text is kept locally so a half-typed "0." is not fought; every valid value is
 * converted EXACTLY (string arithmetic, see moneyInput.ts). An invalid entry stores NaN, which the
 * validator reports and which disables Publish — it is never silently rounded or dropped.
 * Empty ⇒ `emptyAs` (null = "not set" for a service price).
 */
function RupeeInput({ paise, onChange, emptyAs = null, placeholder }: {
  paise: number | null | undefined; onChange: (paise: number | null) => void; emptyAs?: number | null; placeholder?: string
}) {
  const [text, setText]   = useState(paiseToRupeesInput(paise))
  const [last, setLast]   = useState(paise)
  const [error, setError] = useState<string | null>(null)
  if (paise !== last) { setLast(paise); if (!(typeof paise === 'number' && Number.isNaN(paise))) { setText(paiseToRupeesInput(paise)); setError(null) } }
  return (
    <>
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-muted-foreground">₹</span>
        <input
          type="text" inputMode="decimal" value={text} placeholder={placeholder ?? 'Not set'}
          aria-invalid={error ? true : undefined}
          onChange={e => {
            const v = e.target.value; setText(v)
            const r = parseRupeesToPaise(v)
            if (r.ok) { setError(null); const next = r.paise ?? emptyAs; setLast(next); onChange(next) }
            else { setError(r.error); setLast(NaN); onChange(NaN) }
          }}
          className={cn(inputCls, 'pl-6', error && 'border-destructive')}
        />
      </div>
      {error && <span className="text-[10.5px] text-destructive">{error}</span>}
    </>
  )
}

export function LicensingEditor({
  published, draft, onDraftChange, onPublish, publishing, canEditPricing = false, commercialIntegrity = { ok: true }, serviceSaleStates,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
  /** RD-EVENT-COMMERCE-04A — server-decided: only a Super Admin (ADMIN_UIDS) may publish pricing. */
  canEditPricing?: boolean
  /** RD-EVENT-COMMERCE-04A — integrity of the STORED capacity-pricing group (server-assessed). */
  commercialIntegrity?: { ok: true } | { ok: false; reason: string; errors: string[] }
  /** RD-EVENT-COMMERCE-05 — each service's LIVE sale state (server-resolved from the stored doc). */
  serviceSaleStates?: Partial<Record<ServiceKind, string>>
}) {
  // RD-EVENT-COMMERCE-05 — the server's save-time sale-readiness rules block Publish here too.
  const validation = useMemo(() => {
    const v = CONFIG_SECTION_REGISTRY.licensing.validate(draft)
    const sa = draft.serviceAllowances
    const readiness = serviceSaleReadinessErrors(sa && typeof sa === 'object' ? sellableOnly(sa as Record<string, unknown>) : sa)
    // RD-PRINT-BILL-P2 — badge settings block Publish only when THIS draft changes them (an
    // invalid or incomplete stored print_badges never blocks an unrelated licensing edit).
    // RD-PRINT-BILL-P2.1 — administrator wording (no raw configuration paths).
    const badge = badgeSettingsChanged(badgeSettingsOf(published), badgeSettingsOf(draft))
      ? describeBadgeSettingsProblems(badgeSettingsOf(draft)).map(i => `ID badges: ${i.message}`) : []
    const extra = [...readiness, ...badge]
    return extra.length ? { valid: false, errors: [...v.errors, ...extra] } : v
  }, [draft, published])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])

  const setTop = (key: 'defaultCurrency', value: unknown) => onDraftChange({ ...draft, [key]: value })

  // ── License coupons (EA-4 S2) ───────────────────────────────────────────────
  // The five fields below have existed in the schema, the defaults and the licensing
  // validator since EA-4 S2, and the purchase flow already reads them on every checkout
  // (validateLicenseCoupon ← getLicenseCouponsConfig). They were simply never rendered, so
  // `licensing.coupons.enabled` — the master switch for the whole coupon engine — could not
  // be turned on from the UI. This block only exposes them; nothing about the engine changes.
  //
  // READ-ONLY guard, matching `overrides` above: a malformed/absent `coupons` renders as
  // blank rather than crashing, and NOTHING is written into the draft until the admin edits
  // a control. That matters — `coupons` is REQUIRED by the validator, so if it were somehow
  // absent the existing error list already says so and Publish stays disabled. Seeding a
  // default here would silently repair (and change) stored config on mere page load.
  const coupons = (draft.coupons && typeof draft.coupons === 'object' && !Array.isArray(draft.coupons)
    ? draft.coupons
    : {}) as Partial<LicenseCouponsConfig>

  const setCoupon = (patch: Partial<LicenseCouponsConfig>) =>
    onDraftChange({ ...draft, coupons: { ...coupons, ...patch } })

  // ── RD-CAPACITY-01 · the capacity commercial model ──────────────────────────
  //
  // These six values decide what every organizer pays. They are the GLOBAL DEFAULTS: an
  // event resolves its own effective terms (global ⊕ per-event override) and an already-paid
  // order carries an immutable snapshot of the terms it was charged under — so editing
  // anything here changes FUTURE quotes only. Nothing below can rewrite a historical payment.
  //
  // Read defensively, exactly like `coupons` above: a malformed or absent value renders as
  // blank and nothing is written into the draft until an admin edits a control. Seeding a
  // default on page load would silently change stored configuration by merely visiting.
  const commercial = (draft.commercial && typeof draft.commercial === 'object' && !Array.isArray(draft.commercial)
    ? draft.commercial
    : {}) as Partial<CommercialTerms>

  const setCommercial = (patch: Partial<CommercialTerms>) =>
    onDraftChange({ ...draft, commercial: { ...commercial, ...patch } })

  const commercialErrors = validateCommercialTerms({ ...DEFAULT_COMMERCIAL_TERMS, ...commercial }, 'commercial')

  /** The effective value for a field: what the admin typed, else the platform default. */
  const eff = <K extends keyof CommercialTerms>(k: K): number =>
    typeof commercial[k] === 'number' && Number.isFinite(commercial[k]) ? commercial[k] as number : DEFAULT_COMMERCIAL_TERMS[k]

  const numField = (
    key: keyof CommercialTerms,
    label: string,
    hint: string,
    extra: { min?: number; max?: number; step?: number } = {},
  ) => (
    <label key={key} className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <input
        type="number"
        min={extra.min ?? 0}
        {...(extra.max !== undefined ? { max: extra.max } : {})}
        step={extra.step ?? 1}
        value={typeof commercial[key] === 'number' && Number.isFinite(commercial[key]) ? String(commercial[key]) : ''}
        placeholder={String(DEFAULT_COMMERCIAL_TERMS[key])}
        onChange={e => setCommercial({ [key]: numOrNaN(e.target.value) } as Partial<CommercialTerms>)}
        className={inputCls}
      />
      <span className="text-[10.5px] text-muted-foreground">{hint}</span>
    </label>
  )

  // A worked example, computed from the CURRENT draft values, so an admin sees the
  // consequence of an edit before publishing it rather than after an organizer is charged.
  const exampleCapacity = 500
  const exampleChargeable = Math.max(0, exampleCapacity - eff('freeRegistrationCapacity'))
  const exampleBase = exampleChargeable * eff('activationRatePaise')
  const exampleGst  = Math.round(exampleBase * eff('gstRatePercent') / 100)

  // Empty input → NaN. The validator then
  // reports the field and Publish disables, rather than a blank silently becoming 0.
  const numOrNaN = (v: string) => (v === '' ? NaN : Number(v))

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-bold text-foreground">Licensing</h2>
        {dirty ? <Badge variant="warning" className="text-[11px]">Draft</Badge> : <Badge variant="outline" className="text-[11px]">Published</Badge>}
        {validation.valid ? <Badge variant="success" className="text-[11px]">Valid</Badge> : <Badge variant="destructive" className="text-[11px]">{validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || publishing} onClick={() => onDraftChange({ ...published })}><Undo2 className="size-3.5" /> Revert</Button>
          <Button type="button" variant="ghost" size="sm" disabled={publishing} onClick={() => onDraftChange(toDraft(BUSINESS_CONFIG_DEFAULTS.licensing))}><RotateCcw className="size-3.5" /> Defaults</Button>
          <Button type="button" variant="primary" size="sm" disabled={!canEditPricing || !dirty || !validation.valid || publishing} isLoading={publishing} onClick={onPublish}>Publish</Button>
        </div>
      </div>
      {/* RD-EVENT-COMMERCE-04A — the server refuses a non-Super-Admin publish (403); say so up front. */}
      {!canEditPricing && (
        <p role="status" className="border-b border-border bg-muted/40 px-4 py-2 text-[11.5px] text-muted-foreground">
          View only. Changing commercial pricing requires a Super Admin.
        </p>
      )}
      {!commercialIntegrity.ok && (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-[11.5px] text-destructive">
          <p className="font-semibold">Stored capacity pricing is {commercialIntegrity.reason === 'CONFIG_UNREADABLE' ? 'unreadable' : 'invalid'} — every activation and capacity purchase is currently REFUSED.</p>
          <p className="mt-0.5">The values below are the platform defaults, not what is stored. Review them and publish to correct the stored configuration. Nothing is repaired automatically.</p>
          {commercialIntegrity.errors.length > 0 && <ul className="mt-1 list-disc pl-4">{commercialIntegrity.errors.map(e => <li key={e}>{e}</li>)}</ul>}
        </div>
      )}

      <div className="space-y-4 p-4">
        {/* ── RD-CAPACITY-01 · Commercial model (GLOBAL DEFAULTS) ───────────────
            Rendered first: it is the commercial configuration every new event is priced by. */}
        <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Commercial Model — Global Defaults
            </p>
            {commercialErrors.length > 0
              ? <Badge variant="destructive" className="text-[10.5px]">{commercialErrors.length} error{commercialErrors.length === 1 ? '' : 's'}</Badge>
              : <Badge variant="success" className="text-[10.5px]">Valid</Badge>}
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground">
            Applies to every event that has no event-specific override. Changing these values
            reprices FUTURE activations and capacity changes only — completed payments keep the
            terms they were charged under, and no historical record is recalculated.
          </p>

          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {numField('freeRegistrationCapacity', 'Free registration capacity',
              'Registrations included at no charge.')}
            {/* RD-EVENT-COMMERCE-05A — entered in RUPEES, stored in paise. */}
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Activation rate (₹ per additional registration, excl. GST)</span>
              <RupeeInput paise={typeof commercial.activationRatePaise === 'number' ? commercial.activationRatePaise : undefined}
                placeholder={paiseToRupeesInput(DEFAULT_COMMERCIAL_TERMS.activationRatePaise)}
                emptyAs={null}
                onChange={v => {
                  // Blank ⇒ REMOVE the key so the default is inherited (an undefined value would fail validation).
                  const next = { ...commercial } as Partial<CommercialTerms>
                  if (v === null) delete next.activationRatePaise; else next.activationRatePaise = v
                  onDraftChange({ ...draft, commercial: next })
                }} />
              <span className="text-[10.5px] text-muted-foreground">Currently {formatPaise(eff('activationRatePaise'))} per chargeable registration. A blank field inherits the default.</span>
            </label>
            {numField('gstRatePercent', 'GST on activation (%)',
              'Applied to the activation fee and to the capacity-reduction charge.',
              { max: 100, step: 0.01 })}
            {numField('attendeeTransactionFeePercent', 'Attendee transaction fee (%)',
              'Platform fee on ticket revenue. Separate from activation.',
              { max: 100, step: 0.01 })}
            {numField('capacityDecreaseFeePercent', 'Capacity reduction charge (%)',
              'Percentage of the removed capacity value. No refund is ever issued.',
              { max: 100, step: 0.01 })}
            {numField('maximumEventCapacity', 'Maximum event capacity',
              'The ceiling an organizer cannot exceed.')}
          </div>

          {/* The consequence of the current draft, stated in rupees. */}
          <p className="mt-3 text-[11px] text-muted-foreground tabular-nums">
            Example · {exampleCapacity.toLocaleString('en-IN')} registrations →{' '}
            {exampleChargeable.toLocaleString('en-IN')} chargeable ×{' '}
            {formatPaise(eff('activationRatePaise'))} = {formatPaise(exampleBase)} + GST{' '}
            {formatPaise(exampleGst)} = <span className="font-semibold text-foreground">{formatPaise(exampleBase + exampleGst)}</span>
          </p>

          {commercialErrors.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-destructive">
              {commercialErrors.map(e => <li key={e}>{e}</li>)}
            </ul>
          )}
          {/* RD-EVENT-COMMERCE-04 — valid but consequential: stated, never blocked (a
              deliberate promotion is an admin decision, not a validation error). */}
          {commercialErrors.length === 0 && (eff('activationRatePaise') === 0 || eff('freeRegistrationCapacity') >= eff('maximumEventCapacity')) && (
            <p role="status" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning-foreground">
              With these values every activation and capacity increase is FREE for events without an
              event-specific override. Publish only if that is intended.
            </p>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground">
            {COMMERCIAL_TERM_KEYS.length} values, all editable. A blank field inherits the
            platform default shown as its placeholder.
          </p>
        </div>

        {/* ── RD-EVENT-COMMERCE-02 · Prepaid service allowances ─────────────────
            Nothing here has a default price. A service is offered for sale on the License &
            Services step ONLY when every value below is filled in and it is enabled. */}
        <ServiceAllowancesBlock
          liveStates={serviceSaleStates}
          value={draft.serviceAllowances}
          onChange={v => onDraftChange({ ...draft, serviceAllowances: v })}
        />

        {/* ── RD-PRINT-BILL-P2 · ID badges — registered, NOT released for purchase ── */}
        <PrintBadgesBlock
          draft={draft}
          published={published}
          liveState={(serviceSaleStates as Record<string, string> | undefined)?.print_badges}
          onChange={next => onDraftChange(next)}
        />

        {/* Top-level operational settings */}
        <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-foreground">Default currency</span>
            <input value={typeof draft.defaultCurrency === 'string' ? draft.defaultCurrency : ''} onChange={e => setTop('defaultCurrency', e.target.value)} className={inputCls} />
          </label>
        </div>

        {/* License coupons — the existing licensing.coupons policy, now editable.
            Same block chrome as the commercial model so no new visual language is introduced. */}
        <div className="rounded-lg border border-border/70 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            License Coupons
          </p>

          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Enable License Coupons</span>
              <div className="flex h-8 items-center gap-2">
                <Toggle checked={coupons.enabled === true} onChange={v => setCoupon({ enabled: v })} />
                <span className="text-[12px] text-muted-foreground">
                  {coupons.enabled === true ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Max percentage discount (0–100)</span>
              <input
                type="number" min={0} max={100}
                value={typeof coupons.maxPercentageDiscount === 'number' && Number.isFinite(coupons.maxPercentageDiscount) ? String(coupons.maxPercentageDiscount) : ''}
                onChange={e => setCoupon({ maxPercentageDiscount: numOrNaN(e.target.value) })}
                className={inputCls}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Max fixed discount (paise, 0 = no cap)</span>
              <input
                type="number" min={0}
                value={typeof coupons.maxFixedDiscountPaise === 'number' && Number.isFinite(coupons.maxFixedDiscountPaise) ? String(coupons.maxFixedDiscountPaise) : ''}
                onChange={e => setCoupon({ maxFixedDiscountPaise: numOrNaN(e.target.value) })}
                className={inputCls}
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Allow Free License</span>
              <div className="flex h-8 items-center gap-2">
                <Toggle checked={coupons.allowFreeLicense === true} onChange={v => setCoupon({ allowFreeLicense: v })} />
                <span className="text-[12px] text-muted-foreground">
                  {coupons.allowFreeLicense === true ? 'Allowed' : 'Not allowed'}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">Allow Coupon Stacking</span>
              <div className="flex h-8 items-center gap-2">
                <Toggle checked={coupons.allowStacking === true} onChange={v => setCoupon({ allowStacking: v })} />
                <span className="text-[12px] text-muted-foreground">
                  {coupons.allowStacking === true ? 'Allowed' : 'Not allowed'}
                </span>
              </div>
            </div>
          </div>

          {/* Honest note: the flag is reserved in the schema and the engine does not stack
              coupons today, so an admin turning it on must not expect stacking to work. */}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Coupon stacking is reserved for a future release — the checkout applies one coupon
            per license purchase regardless of this setting.
          </p>
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

// ─── RD-EVENT-COMMERCE-02 · Prepaid service allowances ─────────────────────────
// RD-COMMS-P1 — 'wallet_payg' is RETIRED as a current rule: an exhausted allowance never starts a
// new pay-as-you-go charge (only an existing legacy balance may drain — lib/communications/capacity).
// It is offered only so a value already stored stays visible; it behaves as Block.
const EXHAUSTION_LABEL: Record<string, string> = {
  block:       'Block further sends / issuance (recorded + logged)',
  wallet_payg: 'Retired: wallet fallback (now behaves as Block)',
}

/** RD-EVENT-COMMERCE-05 — what organizers see RIGHT NOW for each service (from the stored doc). */
const LIVE_STATE_LABEL: Record<string, string> = {
  available: 'Live — on sale to organizers', not_configured: 'Live — not priced yet', disabled: 'Live — sales paused',
  invalid: 'Live — stored value INVALID, not sold', unavailable: 'Live — configuration unreadable',
  not_released: 'Live — not released for purchase',
}

function ServiceAllowancesBlock({ value, onChange, liveStates }: { value: unknown; onChange: (v: Record<ServiceKind, PrepaidServiceConfig>) => void; liveStates?: Partial<Record<ServiceKind, string>> }) {
  const cfg = normalizeServiceAllowances(value)
  // RD-PRINT-BILL-P2 — the sellable services only; ID badges are judged in their own block.
  const errors = value === undefined ? [] : [
    ...validateServiceAllowances(cfg, 'serviceAllowances', { catalogOnly: 'exclude' }),
    ...serviceSaleReadinessErrors(sellableOnly(cfg), 'serviceAllowances'),
  ]
  const set = (k: ServiceKind, patch: Partial<PrepaidServiceConfig>) => onChange({ ...cfg, [k]: { ...cfg[k], ...patch } })
  // Blank ⇒ null (NOT configured). Never a silent 0.
  const nullableInt = (v: string): number | null => (v.trim() === '' ? null : Number(v))
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Prepaid Service Allowances</p>
        {errors.length > 0
          ? <Badge variant="destructive" className="text-[10.5px]">{errors.length} error{errors.length === 1 ? '' : 's'}</Badge>
          : <Badge variant="outline" className="text-[10.5px]">Per event</Badge>}
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Sold per event on the License &amp; Services step, in the same payment as the activation. Prices
        are in RUPEES, EXCLUDING GST (stored in paise). A service is offered only when its unit price,
        GST rate and exhaustion policy are set and it is on sale — otherwise organizers are told
        exactly what is missing. A blank maximum means no RegisterDesk cap. Purchased units are
        tracked in a separate allowance ledger, never the communication wallet. Changes apply to
        future purchases only.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {SERVICE_KINDS.map(k => {
          const c = cfg[k]
          const avail = serviceAvailability(c)
          const example = avail.purchasable ? priceServiceItem(k, Math.max(c.minQuantity, 100), c) : null
          return (
            <div key={k} className="rounded-lg border border-border/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-foreground">{SERVICE_LABELS[k].title}</p>
                  {liveStates?.[k] && (
                    <p className={cn('text-[10.5px]', liveStates[k] === 'available' ? 'text-emerald-700' : liveStates[k] === 'invalid' ? 'text-destructive' : 'text-muted-foreground')}>
                      {LIVE_STATE_LABEL[liveStates[k]!] ?? liveStates[k]}
                    </p>
                  )}
                </div>
                <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                  <Toggle checked={c.enabled} onChange={v => set(k, { enabled: v })} />{c.enabled ? 'For sale' : 'Not for sale'}
                </label>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Unit price (₹, excluding GST)</span>
                  <RupeeInput paise={c.unitPricePaise} onChange={v => set(k, { unitPricePaise: v })} /></label>
                <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">GST (%)</span>
                  <input type="number" min={0} max={100} step={0.01} value={c.gstRatePercent ?? ''} placeholder="Not set" onChange={e => set(k, { gstRatePercent: nullableInt(e.target.value) })} className={inputCls} /></label>
                <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Minimum quantity</span>
                  <input type="number" min={1} value={c.minQuantity} onChange={e => set(k, { minQuantity: e.target.value === '' ? NaN : Number(e.target.value) })} className={inputCls} /></label>
                <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Maximum quantity (blank = no maximum)</span>
                  <input type="number" min={1} value={c.maxQuantity ?? ''} placeholder="No maximum" onChange={e => set(k, { maxQuantity: nullableInt(e.target.value) })} className={inputCls} /></label>
                <label className="col-span-2 flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Quick-select presets (comma-separated)</span>
                  <input value={c.presets.join(', ')} placeholder="e.g. 500, 1000, 5000" onChange={e => set(k, { presets: e.target.value.split(',').map(x => x.trim()).filter(Boolean).map(Number) })} className={inputCls} /></label>
                <label className="col-span-2 flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">When the allowance is used up</span>
                  <select value={c.onExhausted ?? ''} onChange={e => set(k, { onExhausted: e.target.value === '' ? null : e.target.value as PrepaidServiceConfig['onExhausted'] })} className={inputCls}>
                    <option value="">Not set</option>
                    {EXHAUSTION_POLICIES.filter(p => p !== 'wallet_payg' || c.onExhausted === 'wallet_payg').map(p => <option key={p} value={p}>{EXHAUSTION_LABEL[p]}</option>)}
                  </select></label>
              </div>
              <p className="mt-2 text-[10.5px] text-muted-foreground tabular-nums">
                {example
                  ? <>Example · {example.quantity.toLocaleString('en-IN')} × {formatPaise(example.unitPricePaise)} = {formatPaise(example.basePaise)} + GST {formatPaise(example.gstPaise)} = <span className="font-semibold text-foreground">{formatPaise(example.totalPaise)}</span></>
                  : <>Not offered to organizers — awaiting {avail.missing.join(', ')}.</>}
              </p>
            </div>
          )
        })}
      </div>
      {errors.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-destructive">{errors.map(e => <li key={e}>{e}</li>)}</ul>
      )}
    </div>
  )
}

/**
 * RD-PRINT-BILL-P2 — ID badges (print_badges): visible, but SAFELY RESTRICTED.
 *   • Purchases are blocked in code (RELEASED_FOR_PURCHASE) whatever is set here, and the
 *     for-sale switch and paid generation are LOCKED off (the server refuses either).
 *   • Price (GST-INCLUSIVE), GST rate and quantities can be prepared; a change needs a reason of
 *     3–500 characters and is audited. Its errors block Publish only when this draft changes it.
 *   • Reset to defaults restores the approved values (₹0.20 incl. GST, minimum 100, rate unset).
 */
function PrintBadgesBlock({ draft, published, liveState, onChange }: {
  draft: SectionDraft; published: unknown; liveState?: string; onChange: (next: SectionDraft) => void
}) {
  const sa = (draft.serviceAllowances && typeof draft.serviceAllowances === 'object' ? draft.serviceAllowances : {}) as Record<string, unknown>
  const c = normalizeServiceAllowances(sa).print_badges
  const billing = (draft.printBadgeBilling && typeof draft.printBadgeBilling === 'object' ? draft.printBadgeBilling : {}) as Record<string, unknown>
  const after = badgeSettingsOf(draft)
  const changed = badgeSettingsChanged(badgeSettingsOf(published), after)
  // RD-PRINT-BILL-P2.1 — administrator wording, each issue tied to its field where it has one.
  const issues = describeBadgeSettingsProblems(after)
  const fieldIssues = (f: BadgeSettingsField) => issues.filter(i => i.field === f)
  const set = (patch: Partial<PrepaidServiceConfig>) =>
    onChange({ ...draft, serviceAllowances: { ...sa, print_badges: { ...c, ...patch } } })
  const reset = () => {
    const d = defaultBadgeSettings()
    onChange({ ...draft, serviceAllowances: { ...sa, print_badges: d.printBadges }, printBadgeBilling: d.printBadgeBilling, printBadgePilot: d.printBadgePilot })
  }
  // RD-PRINT-P8 (W5) — the paid ID-badge pilot: workspace-owner uids, one per line. Saved like every
  // badge setting (reason + audit); the server reads the STORED list and is the only authority.
  const pilotCfg = (draft.printBadgePilot && typeof draft.printBadgePilot === 'object' ? draft.printBadgePilot : {}) as Record<string, unknown>
  const pilotUids = Array.isArray(pilotCfg.organizerUids) ? pilotCfg.organizerUids.map(String) : []
  const setPilotText = (text: string) => onChange({
    ...draft,
    printBadgePilot: { enforced: true, organizerUids: text.split(/[\s,]+/).map(u => u.trim()).filter(Boolean) },
  })
  const nullableNum = (v: string): number | null => (v.trim() === '' ? null : Number(v))
  // Distinguishes "GST not set" from "GST invalid" (and the other gaps) — never assumes a rate.
  const hint = badgePriceHint(c)
  const fieldIssue = (f: BadgeSettingsField) => {
    const list = fieldIssues(f)
    return list.length > 0 ? <span id={`pb-${f}-err`} className="text-[10.5px] leading-snug text-destructive">{list.map(i => i.message).join(' ')}</span> : null
  }
  const inv = (f: BadgeSettingsField) => (fieldIssues(f).length > 0 ? { 'aria-invalid': true as const, 'aria-describedby': `pb-${f}-err` } : {})
  const blockIssues = issues.filter(i => i.field === null || i.field === 'enabled' || i.field === 'paidGenerationEnabled' || i.field === 'allowFreeCoupons')
  // RD-PRINT-BILL-P3 — the one EDITABLE badge switch: whether a badge-purchase coupon may make a purchase free.
  const setBilling = (patch: Record<string, unknown>) => onChange({ ...draft, printBadgeBilling: { ...billing, ...patch } })
  return (
    <div className="rounded-lg border border-border/70 p-3" data-testid="print-badges-block">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">ID badges (Print &amp; Assets)</p>
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10.5px] text-amber-800">Not released — purchases blocked</Badge>
        {changed && <Badge variant="outline" className="text-[10.5px]">Changed</Badge>}
        {issues.length > 0 && <Badge variant="destructive" className="text-[10.5px]">{issues.length} issue{issues.length === 1 ? '' : 's'}</Badge>}
      </div>
      <p className="mb-1 text-[11px] text-muted-foreground">
        Prepaid badge units, one per attendee badge ({PRINT_BADGE_CHARGEABLE_ASSET_TYPES.join(', ')} templates). The unit price
        INCLUDES GST — GST is never added on top. Organizers cannot buy units, and badge generation stays free, until badge
        billing is released; the switches here are locked until then.
        {liveState && <> <span className="font-medium text-foreground">{LIVE_STATE_LABEL[liveState] ?? liveState}.</span></>}
      </p>
      <p className="mb-3 text-[11px] font-medium text-foreground" data-testid="print-badges-reason-guidance">{BADGE_REASON_GUIDANCE}</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border/60 p-3">
          <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Unit price (₹, INCLUDING GST)</span>
              <RupeeInput paise={c.unitPricePaise} onChange={v => set({ unitPricePaise: v })} />
              {fieldIssue('unitPricePaise')}</label>
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">GST (%) — set after accountant approval</span>
              <input type="number" min={0} max={100} step={0.01} value={c.gstRatePercent ?? ''} placeholder="Not set" onChange={e => set({ gstRatePercent: nullableNum(e.target.value) })} className={inputCls} {...inv('gstRatePercent')} />
              {fieldIssue('gstRatePercent')}</label>
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Minimum purchase (badges)</span>
              <input type="number" min={1} value={Number.isFinite(c.minQuantity) ? c.minQuantity : ''} onChange={e => set({ minQuantity: e.target.value === '' ? NaN : Number(e.target.value) })} className={inputCls} {...inv('minQuantity')} />
              {fieldIssue('minQuantity')}</label>
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Maximum (blank = no maximum)</span>
              <input type="number" min={1} value={c.maxQuantity ?? ''} placeholder="No maximum" onChange={e => set({ maxQuantity: nullableNum(e.target.value) })} className={inputCls} {...inv('maxQuantity')} />
              {fieldIssue('maxQuantity')}</label>
          </div>
          <p className={cn('mt-2 text-[10.5px] tabular-nums', hint.kind === 'example' ? 'text-muted-foreground' : hint.kind === 'gst_unset' || hint.kind === 'price_unset' ? 'text-muted-foreground' : 'text-destructive')} data-testid="print-badges-price-hint">
            {hint.kind === 'example'
              ? <>Example · {hint.quantity.toLocaleString('en-IN')} × {formatPaise(hint.unitPricePaise)} = <span className="font-semibold text-foreground">{formatPaise(hint.totalPaise)}</span> (includes GST {formatPaise(hint.gstPaise)} on {formatPaise(hint.basePaise)})</>
              : hint.text}
          </p>
        </div>
        <div className="space-y-2 rounded-lg border border-border/60 p-3 text-[11.5px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Badge units for sale</span>
            <span className="flex items-center gap-2 text-muted-foreground" title="Locked until badge purchases are released">
              <span aria-disabled="true" className="pointer-events-none opacity-50"><Toggle checked={c.enabled === true} onChange={() => {}} /></span>Locked
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Paid badge generation</span>
            <span className="flex items-center gap-2 text-muted-foreground" title="Locked until badge billing is released — generation is free">
              <span aria-disabled="true" className="pointer-events-none opacity-50"><Toggle checked={billing.paidGenerationEnabled === true} onChange={() => {}} /></span>Locked · free
            </span>
          </div>
          <div className="flex items-center justify-between gap-2" data-testid="print-badges-free-coupons">
            <span className="text-muted-foreground">Allow free (100%) badge coupons</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <Toggle checked={billing.allowFreeCoupons === true} onChange={v => setBilling({ allowFreeCoupons: v })} />{billing.allowFreeCoupons === true ? 'Allowed' : 'Not allowed'}
            </span>
          </div>
          <label className="flex flex-col gap-1 pt-1" data-testid="print-badges-pilot">
            <span className="text-muted-foreground">Paid ID-badge pilot — organizer uids, one per line ({pilotUids.length} listed)</span>
            <textarea key={pilotUids.join('|')} defaultValue={pilotUids.join('\n')} rows={3} spellCheck={false}
              onBlur={e => setPilotText(e.target.value)} placeholder="No pilot organizers — nobody can buy badges or be charged"
              className={cn(inputCls, 'h-auto py-1.5 font-mono text-[11.5px]')} {...inv('printBadgePilot')} />
            <span className="text-[10.5px] text-muted-foreground">Only these organizers can buy badge units or use paid badge generation; everyone else stays free. The server decides.</span>
            {fieldIssue('printBadgePilot')}
          </label>
          <Button type="button" variant="outline" size="sm" onClick={reset} className="mt-1"><RotateCcw className="size-3.5" /> Reset to defaults</Button>
        </div>
      </div>
      {blockIssues.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-destructive" data-testid="print-badges-issues">{blockIssues.map(i => <li key={i.message}>{i.message}</li>)}</ul>
      )}
      {!changed && issues.length > 0 && (
        <p className="mt-1 text-[10.5px] text-muted-foreground">These stored values are not in use (nothing is sold) and do not block other changes. Reset to defaults to clear them.</p>
      )}
    </div>
  )
}
