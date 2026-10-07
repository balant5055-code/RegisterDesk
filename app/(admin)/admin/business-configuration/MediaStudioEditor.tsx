'use client'

// RD-MEDIA-09 · Media Studio configuration editor.
//
// ═══ WHY A SPECIALISED EDITOR ═════════════════════════════════════════════════
// `SectionEditor` renders only the FLAT fields declared in `SECTION_FIELDS`, with kinds
// text/number/boolean/select. It has no nested path.
//
// This is the answer licensing, fees and communication already reached: a section with a
// nested schema gets its own editor. The config engine, the save endpoint and the validator
// are untouched — only the surface that produces the patch.
//
// RD-LEGACY-01 — the retired licence-tier limit table and the retired Media Credits policy
// are no longer shown. Their stored values (`tierLimits`, the credit fields) stay in the
// document untouched — a publish sends the draft, which is a copy of what is stored — and no
// active code reads them: media limits are event override → global, and photo capacity is
// the paid per-event service (max 3,000).
// ══════════════════════════════════════════════════════════════════════════════

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RotateCcw } from 'lucide-react'
import { CONFIG_SECTION_REGISTRY, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

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

const GLOBAL_NUMBERS = [
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
  // decoration. They are the platform's storage-cost levers: turning `keepOriginal` off
  // roughly halves what is stored per photo.
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

export function MediaStudioEditor({
  published, draft, onDraftChange, onPublish, publishing,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
  /** RD-EVENT-COMMERCE-04B — server-decided. Accepted for the shared editor contract; this section
   *  has no price field any more (RD-LEGACY-01 removed the retired Media Credit prices). */
  canEditPricing?: boolean
}) {
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY.mediaStudio.validate(draft), [draft])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])

  const set = (key: string, value: unknown) => onDraftChange({ ...draft, [key]: value })

  const resetToDefaults = () =>
    onDraftChange(JSON.parse(JSON.stringify(BUSINESS_CONFIG_DEFAULTS.mediaStudio)) as SectionDraft)

  return (
    <div className="space-y-4">
      {/* ── Global defaults ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-foreground">Global defaults</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Applies to every event unless a Super Admin has set an override for that event.
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
            const nullable = false
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
