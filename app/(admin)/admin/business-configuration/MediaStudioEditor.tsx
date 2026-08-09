'use client'

// RD-MEDIA-09 · Media Studio configuration editor.
//
// ═══ WHY A SPECIALISED EDITOR ═════════════════════════════════════════════════
// `SectionEditor` renders only the FLAT fields declared in `SECTION_FIELDS`, with kinds
// text/number/boolean/select. It has no nested path.
//
// So `mediaStudio.tierLimits` — the entire licence layer — round-tripped through the draft
// untouched and could never be CHANGED. Every global value was editable and every per-tier
// value was effectively code-only, which is exactly what RD-MEDIA-08 set out to remove.
//
// This is the answer licensing, fees and communication already reached: a section with a
// nested schema gets its own editor. The config engine, the save endpoint and the validator
// are untouched — only the surface that produces the patch.
// ══════════════════════════════════════════════════════════════════════════════

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { RotateCcw, Coins } from 'lucide-react'
import { ROUTES } from '@/config/navigation'
import { CONFIG_SECTION_REGISTRY, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { EVENT_LICENSE_TIERS_V2 } from '@/lib/licensing/eventLicense'

type SectionDraft = Record<string, unknown>

const inputCls = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

/** Fields a licence tier may override. Numbers only — the booleans are global policy. */
const TIER_FIELDS = [
  { key: 'maxPhotosPerEvent',      label: 'Max photos' },
  { key: 'maxUploadBatchSize',     label: 'Max batch' },
  { key: 'maxUploadFileSizeBytes', label: 'Max file bytes' },
  { key: 'maxGalleriesPerEvent',   label: 'Max galleries' },
  { key: 'maxAlbumsPerGallery',    label: 'Max albums' },
] as const

/**
 * RD-MS-CLOSURE-01 · per-tier BOOLEAN deltas.
 *
 * `tierLimits` is `Partial<MediaOverridableConfig>`, so the resolver has always honoured
 * these — there was simply no way to set one, because the tier table offered number inputs
 * only. That made the storage-cost lever unreachable at the layer it matters most: the whole
 * point of turning `keepOriginal` off is to do it for the Free tier and not for Enterprise.
 *
 * Three states, not two. `undefined` means INHERIT and is not the same as `false`, so a
 * checkbox would be wrong — it would turn "not set" into "off" the first time anyone looked
 * at the row.
 */
const TIER_BOOLEANS = [
  { key: 'keepOriginal',      label: 'Full-size' },
  { key: 'generateMedium',    label: 'Medium' },
  { key: 'generateThumbnail', label: 'Thumbnail' },
] as const

const GLOBAL_NUMBERS = [
  { key: 'maxPhotosPerEvent',      label: 'Maximum photos per event', hint: 'Blank = unlimited' },
  { key: 'maxUploadBatchSize',     label: 'Maximum upload batch size', hint: 'Files per request' },
  { key: 'maxUploadFileSizeBytes', label: 'Maximum upload file size',  hint: 'Bytes · 52428800 = 50 MB' },
  { key: 'maxGalleriesPerEvent',   label: 'Maximum galleries per event', hint: '' },
  { key: 'maxAlbumsPerGallery',    label: 'Maximum albums per gallery',  hint: '' },
  { key: 'signedUrlExpirySeconds', label: 'Signed URL expiry', hint: 'Seconds' },
] as const

const GLOBAL_BOOLEANS = [
  // RD-MS-CLOSURE-01 · the three rendition switches are back, because they now DO something.
  //
  // RD-MS-CLEANUP-02 removed them from this editor when the renditions settings UI went, and
  // the keys stayed in the config — configurable in the schema, resolvable by the resolver,
  // and ignored by an import client that hardcoded all three to true. This sprint wired the
  // import client to the resolved values, so the switches are controls again rather than
  // decoration. They are the platform's storage-cost levers: turning `keepOriginal` off on a
  // tier roughly halves what that tier stores per photo.
  { key: 'keepOriginal',      label: 'Store full-size rendition' },
  { key: 'generateMedium',    label: 'Generate medium rendition' },
  { key: 'generateThumbnail', label: 'Generate thumbnail' },
  { key: 'publicGalleryEnabled', label: 'Public gallery enabled' },
  // RD-MS-CLOSURE-01 · the platform branding switch. Branding had NO admin surface at all —
  // the platform could neither see nor stop it. Off blocks new branded imports everywhere;
  // photos already imported keep their overlay, because it is baked into the stored bytes.
  { key: 'brandingEnabled',      label: 'Photo branding enabled' },
] as const

// RD-MS-CLEANUP-01 · 'original' and 'premium' were withdrawn as offered profiles. An event
// still storing either id resolves to 'balanced' via findProfile, so no migration is needed —
// but neither may be SET again, which is why they are gone from this list and from
// VALID_PROFILE_IDS in the overrides route.
const PROFILES = ['balanced', 'web', 'ultra']

// MC-01 — Media Credits. Numeric policy fields, all DISABLED until `creditsEnabled` is on.
// Shown rather than hidden so a Super Admin can see the policy that will apply before
// enabling it; disabled so a value cannot be tuned while the feature is inert and untested.
const CREDIT_NUMBERS = [
  { key: 'creditsPerPhoto',      label: 'Credits per photo',   hint: 'Charged per stored photo' },
  { key: 'creditUnitPricePaise', label: 'Credit unit price',   hint: 'Paise · 100 = ₹1' },
  { key: 'minCreditPurchase',    label: 'Minimum purchase',    hint: 'Credits' },
  { key: 'refundWindowDays',     label: 'Refund window',       hint: 'Days after purchase' },
  // MC-05 — refund service charge. Admin-only by placement: organizers have no surface that
  // writes these, so they cannot reduce the charge levied on their own refund.
  { key: 'refundServiceChargePercent',    label: 'Service charge %',   hint: '0–100 · of the purchase amount' },
  { key: 'refundServiceChargeFixedPaise', label: 'Service charge flat', hint: 'Paise · 100 = ₹1' },
  { key: 'minRefundablePaise',            label: 'Minimum refundable',  hint: 'Paise · below this a refund is refused' },
  // MC-12.1 — MC-11 added these to the config and to the engine but never to this editor,
  // so they were only reachable by writing Firestore by hand. All three are enforced today.
  { key: 'minRefundCredits',              label: 'Minimum refund credits', hint: 'Credits · 0 = no minimum' },
  { key: 'maxRefundPerRequestPaise',      label: 'Maximum per refund',     hint: 'Paise · 0 = no ceiling' },
  { key: 'refundAutoRejectDays',          label: 'Auto-reject after',      hint: 'Days a request may wait · 0 = never' },
] as const

/** MC-05 — which parts of the service charge apply. Drives the two numeric fields above. */
const SERVICE_CHARGE_METHODS = [
  { value: 'percent',            label: 'Percentage only' },
  { value: 'fixed',              label: 'Flat fee only' },
  { value: 'percent_plus_fixed', label: 'Percentage + flat fee' },
] as const

export function MediaStudioEditor({
  published, draft, onDraftChange, onPublish, publishing,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
}) {
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY.mediaStudio.validate(draft), [draft])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])

  const set = (key: string, value: unknown) => onDraftChange({ ...draft, [key]: value })

  const tierLimits = (draft.tierLimits ?? {}) as Record<string, Record<string, unknown> | undefined>

  /**
   * Sets or CLEARS one tier's delta for one field.
   *
   * Clearing DELETES the key rather than storing a blank. A tier delta must carry only what
   * differs, or raising a global limit would never reach that tier (RD-MEDIA-08).
   */
  const setTier = (tier: string, key: string, value: number | boolean | undefined) => {
    const next  = { ...tierLimits }
    const delta = { ...(next[tier] ?? {}) }

    if (value === undefined) delete delta[key]
    else delta[key] = value

    if (Object.keys(delta).length === 0) delete next[tier]
    else next[tier] = delta

    onDraftChange({ ...draft, tierLimits: next })
  }

  const resetToDefaults = () =>
    onDraftChange(JSON.parse(JSON.stringify(BUSINESS_CONFIG_DEFAULTS.mediaStudio)) as SectionDraft)

  // MC-01 — every credit field except the master switch is gated on this.
  const creditsOn = Boolean(draft.creditsEnabled)

  return (
    <div className="space-y-4">
      {/* RD-ADMIN-CLOSURE-01 · the return half of the media contextual link.
          Media Credits (Finance) links here for the prices; this links back to the console
          where those prices are actually spent, so the loop closes from either end. A link,
          not a sidebar entry — the IA is untouched. */}
      <nav aria-label="Related consoles" className="flex flex-wrap items-center gap-2">
        <Link
          href={ROUTES.ADMIN_MEDIA_CREDITS}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Coins className="size-3.5 text-muted-foreground" aria-hidden />
          Media Credits console
        </Link>
      </nav>

      {/* ── Global defaults ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-foreground">Global defaults</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              The bottom layer. Applies wherever a licence tier and an event override leave a
              value unset.
            </p>
          </div>
          <button
            type="button" onClick={resetToDefaults}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="size-3.5" aria-hidden /> Reset to code defaults
          </button>
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {GLOBAL_NUMBERS.map(f => {
            const nullable = f.key === 'maxPhotosPerEvent'
            const raw = draft[f.key]
            return (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-[11.5px] text-muted-foreground">{f.label}</span>
                <input
                  type="number"
                  className={inputCls}
                  placeholder={nullable ? 'Unlimited' : ''}
                  value={raw === null || raw === undefined ? '' : String(raw)}
                  onChange={e => {
                    const text = e.target.value
                    if (text === '') { set(f.key, nullable ? null : NaN); return }
                    set(f.key, Number(text))
                  }}
                />
                {f.hint && <span className="text-[11px] text-muted-foreground">{f.hint}</span>}
              </label>
            )
          })}

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">Default compression profile</span>
            <select
              className={inputCls}
              value={String(draft.defaultCompressionProfileId ?? '')}
              onChange={e => set('defaultCompressionProfileId', e.target.value)}
            >
              {PROFILES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">Default visibility</span>
            <select
              className={inputCls}
              value={String(draft.defaultVisibility ?? 'PUBLIC')}
              onChange={e => set('defaultVisibility', e.target.value)}
            >
              <option value="PUBLIC">PUBLIC</option>
              <option value="SIGNED_URL">SIGNED_URL</option>
            </select>
          </label>

          <div className="sm:col-span-2 lg:col-span-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {GLOBAL_BOOLEANS.map(f => (
              <div key={f.key} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                <span className="text-[12.5px] text-foreground">{f.label}</span>
                <Toggle checked={Boolean(draft[f.key])} onChange={v => set(f.key, v)} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── MC-01 · Media Credits ────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold text-foreground">Media Credits</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {creditsOn
              ? 'Credits are enabled. The spend path ships in MC-02 — no credit is charged yet.'
              : 'Credits are disabled. Media Studio behaves exactly as it does today and no credit is charged.'}
          </p>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
            <span className="text-[12.5px] text-foreground">Credits enabled</span>
            <Toggle checked={creditsOn} onChange={v => set('creditsEnabled', v)} />
          </div>

          {/* A plain checkbox, not the shared Toggle: Toggle exposes no `disabled` prop and
              MC-01 must not modify a shared component to add one. */}
          <label className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
            <span className="text-[12.5px] text-foreground">Refunds enabled</span>
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)] disabled:opacity-50"
              checked={Boolean(draft.refundsEnabled)}
              disabled={!creditsOn}
              onChange={e => set('refundsEnabled', e.target.checked)}
            />
          </label>

          {/* MC-12.1 — the two decision-note policies. Checkboxes rather than the shared
              Toggle for the same reason as "Refunds enabled" above: Toggle has no
              `disabled` prop and a shared component must not be changed to add one. */}
          <label className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
            <span className="text-[12.5px] text-foreground">Refund reason required</span>
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)] disabled:opacity-50"
              checked={Boolean(draft.refundReasonRequired)}
              disabled={!creditsOn}
              onChange={e => set('refundReasonRequired', e.target.checked)}
            />
          </label>

          <label className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
            <span className="text-[12.5px] text-foreground">Admin note required</span>
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)] disabled:opacity-50"
              checked={Boolean(draft.refundNoteRequired)}
              disabled={!creditsOn}
              onChange={e => set('refundNoteRequired', e.target.checked)}
            />
          </label>

          {/* MC-05 — the method decides which of the two charge fields below actually
              applies. Rendered before them so the numbers read in context. */}
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">Service charge method</span>
            <select
              className={inputCls}
              value={String(draft.refundServiceChargeMethod ?? 'percent')}
              disabled={!creditsOn}
              onChange={e => set('refundServiceChargeMethod', e.target.value)}
            >
              {SERVICE_CHARGE_METHODS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground/80">
              What the platform keeps when a purchase is refunded
            </span>
          </label>

          {CREDIT_NUMBERS.map(f => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">{f.label}</span>
              <input
                type="number"
                className={inputCls}
                value={String(draft[f.key] ?? '')}
                disabled={!creditsOn}
                onChange={e => set(f.key, e.target.value === '' ? 0 : Number(e.target.value))}
              />
              <span className="text-[11px] text-muted-foreground/80">{f.hint}</span>
            </label>
          ))}
        </div>
      </div>

      {/* ── Per-tier limits ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold text-foreground">Licence tier limits</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            The middle layer. A blank cell <strong>inherits the global default</strong> — it is
            not zero. Clearing a cell removes the override entirely, so a later change to the
            global value reaches that tier again.
          </p>
        </div>

        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[760px] text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-semibold">Tier</th>
                {TIER_FIELDS.map(f => (
                  <th key={f.key} scope="col" className="px-2 py-2 font-semibold">{f.label}</th>
                ))}
                {TIER_BOOLEANS.map(f => (
                  <th key={f.key} scope="col" className="px-2 py-2 font-semibold">{f.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENT_LICENSE_TIERS_V2.map(tier => {
                const delta = tierLimits[tier] ?? {}
                return (
                  <tr key={tier} className="border-b border-border/50">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium capitalize text-foreground">
                      {tier}
                    </th>
                    {TIER_FIELDS.map(f => {
                      const raw = delta[f.key]
                      const overridden = raw !== undefined
                      const inherited = draft[f.key]
                      return (
                        <td key={f.key} className="px-2 py-1.5">
                          <input
                            aria-label={`${tier} — ${f.label}`}
                            type="number"
                            className={cn(inputCls, overridden && 'border-primary/60')}
                            placeholder={inherited === null ? 'Unlimited' : String(inherited ?? '')}
                            value={raw === undefined || raw === null ? '' : String(raw)}
                            onChange={e => {
                              const text = e.target.value
                              if (text === '') { setTier(tier, f.key, undefined); return }
                              const n = Number(text)
                              setTier(tier, f.key, Number.isFinite(n) ? n : undefined)
                            }}
                          />
                        </td>
                      )
                    })}
                    {/* RD-MS-CLOSURE-01 · tri-state. "Inherit" is the absence of a key, not a
                        value — the same rule the number cells follow with a blank input. */}
                    {TIER_BOOLEANS.map(f => {
                      const raw = delta[f.key]
                      const overridden = raw !== undefined
                      const inherited = Boolean(draft[f.key])
                      return (
                        <td key={f.key} className="px-2 py-1.5">
                          <select
                            aria-label={`${tier} — ${f.label}`}
                            className={cn(inputCls, overridden && 'border-primary/60')}
                            value={raw === undefined ? '' : String(raw)}
                            onChange={e => {
                              const v = e.target.value
                              setTier(tier, f.key, v === '' ? undefined : v === 'true')
                            }}
                          >
                            <option value="">{inherited ? 'Inherit · on' : 'Inherit · off'}</option>
                            <option value="true">On</option>
                            <option value="false">Off</option>
                          </select>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">
            A highlighted cell is an override. The placeholder shows what would be inherited.
          </p>
        </div>
      </div>

      {/* ── Publish ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onPublish} disabled={!dirty || publishing || !validation.valid}>
          {publishing ? 'Publishing…' : 'Publish changes'}
        </Button>
        {!validation.valid && <Badge variant="destructive" className="text-[11px]">Invalid</Badge>}
        {!dirty && validation.valid && (
          <span className="text-[12.5px] text-muted-foreground">No changes to publish.</span>
        )}
        {!validation.valid && (
          <ul className="w-full space-y-0.5 text-[12px] text-destructive">
            {validation.errors.map(e => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
