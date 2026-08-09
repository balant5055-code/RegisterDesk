// RD-PHOTO-01 · Photo Branding.
// RD-PHOTO-04 · Rewritten for UPLOAD-TIME branding.
//
// Everything on this page previously described download-time compositing — that the
// stored photo was never touched, and that branding could be changed at any time. Both
// became false in RD-PHOTO-03, and on the one decision that is irreversible a reassuring
// falsehood is worse than no page at all. Every claim below is now the upload-time truth.
//
// Wording that also appears elsewhere comes from `brandingCopy`, so the import gate, the
// hub card and this page cannot describe branding differently.
//
// Not a licensing feature — every organizer with the existing `events` permission can use
// it. Nothing on this page or behind it consults a tier.
//
// The interactive half (upload, validation, preview, templates) is `BrandingClient`.
// Everything below is static guidance, deliberately ON THE PAGE rather than in
// documentation, because artwork is made before anyone reads docs.
//
// Built from the existing dashboard design system: `MediaStudioHeader`, `StudioSection`,
// `Card`, and the token type scale. No new spacing, typography or colour.

import {
  Ban, Check, Image as ImageIcon, Lock, Sparkles, Upload, Wand2,
} from 'lucide-react'
import { Banner, Card } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { StudioSection } from '@/features/media-studio/components/MediaStudioShell'
import { BrandingClient } from '@/features/photo-branding/components/BrandingClient'
import { SafeAreaDiagram } from '@/features/photo-branding/components/SafeAreaDiagram'
import {
  DEFAULT_STYLE, formatBytes, formatDimensions, specFor,
} from '@/features/photo-branding/utils/artworkSpec'
import {
  BRANDING_DECIDE_ONCE, BRANDING_NOT_PROTECTION, BRANDING_PERMANENT, BRANDING_WHAT,
  BRANDING_WHY_LOCKED,
} from '@/features/photo-branding/utils/brandingCopy'

export const metadata = { title: 'Photo Branding — Media Studio' }

const SPEC = specFor(DEFAULT_STYLE)

/** Every requirement, derived from the spec so the page cannot contradict the validator. */
const REQUIREMENTS: { label: string; value: string }[] = [
  { label: 'Required format',        value: 'PNG' },
  { label: 'Background',             value: 'Transparent' },
  { label: 'Colour mode',            value: 'RGBA' },
  { label: 'Recommended size',       value: formatDimensions(SPEC.recommendedWidth, SPEC.recommendedHeight) },
  { label: 'Minimum',                value: formatDimensions(SPEC.minWidth, SPEC.minHeight) },
  { label: 'Maximum',                value: formatDimensions(SPEC.maxWidth, SPEC.maxHeight) },
  { label: 'Maximum file size',      value: formatBytes(SPEC.maxBytes) },
  { label: 'Position',               value: SPEC.position },
  { label: 'Recommended resolution', value: `${SPEC.recommendedDpi} DPI` },
]

const RECOMMENDED = [
  'Event logo',
  'Event name',
  'Sponsors',
  'Website',
  'Social media handles',
  'QR code (optional)',
]

const AVOID = [
  'JPG — it cannot hold transparency',
  'A solid background — it will cover the photo',
  'Important text outside the safe area',
  'Tiny fonts that vanish at phone size',
  'Low-resolution logos that look soft when scaled',
]

const STEPS = [
  { icon: Wand2,     title: 'Decide',           text: 'Choose whether this event uses branding. Asked once, on the Import Media page, before your first photo.' },
  { icon: Upload,    title: 'Upload artwork',   text: 'One transparent PNG for the event. Replace it as often as you like — until photos exist.' },
  { icon: ImageIcon, title: 'Import photos',    text: 'Your artwork is merged into each photo during the compression that already happens in your browser.' },
  { icon: Sparkles,  title: 'One image stored', text: 'The branded photo IS the stored photo. No second copy, no extra storage, no processing at download time.' },
  { icon: Lock,      title: 'Branding locks',   text: 'Once the event has photos, branding can no longer be changed — the artwork is already part of every stored image.' },
]

const FAQ = [
  {
    q: 'Will my imported photos be modified?',
    a: 'Yes — deliberately. Your artwork is merged into each photo as it is imported, and that branded image is the one stored. There is no separate unbranded copy, which is what keeps storage cost and download speed unchanged.',
  },
  {
    q: 'Can I change the branding later?',
    a: 'Only until the event has its first photo. After that branding is locked. ' + BRANDING_WHY_LOCKED,
  },
  {
    q: 'Does this affect photos I have already imported?',
    a: 'No. Branding is applied at the moment of import, so it affects future imports only. Photos already in your galleries keep whatever branding they were imported with.',
  },
  {
    q: 'What if I import photos without branding and change my mind?',
    a: 'Those photos cannot be branded afterwards. The only way is to delete them and import again with branding enabled — which is why the choice is asked before your first import rather than left as a setting to find later.',
  },
  {
    q: 'Can I upload a JPG?',
    a: 'No, and the reason matters: a JPEG has no transparency, so it would cover the bottom of every photo with a solid rectangle. PNG with an alpha channel is the only format that can sit over a photograph.',
  },
  {
    q: 'Does branding slow down imports or downloads?',
    a: 'Imports, barely — the overlay is drawn onto the same canvas your photos are already resized on, so there is no extra decode and no extra encode. Downloads are unaffected: they are ordinary file downloads, because the branding is already in the stored image.',
  },
]

const PRACTICES = [
  { title: 'Keep the banner around 18–20% of the photo height', text: 'Enough to read, little enough to leave the photograph the subject.' },
  { title: 'Use high-resolution logos',                          text: 'Vector exports, or raster at twice the size you think you need. A soft logo reads as a cheap event.' },
  { title: 'Maintain contrast',                                  text: 'Your artwork sits over unpredictable photographs. A subtle drop shadow or a semi-opaque band keeps text legible over both a bright sky and a dark crowd.' },
  { title: 'Keep important content inside the safe area',        text: 'Anything near the edge can be clipped on unusual photo shapes.' },
  { title: 'Preview before you import',                          text: 'The live preview above uses your own photo when you have one. Look at it on a phone too — once you import, it is final.' },
]

export default function PhotoBrandingPage() {
  return (
    <div className="space-y-6">
      <MediaStudioHeader
        title="Photo Branding"
        subtitle="Merge your event's identity into every photo as it is imported."
        crumb="Photo Branding"
      />

      {/* ── 1 · Hero ─────────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10" aria-hidden>
            <Sparkles className="size-[18px] text-primary" />
          </div>
          <div className="min-w-0 space-y-2">
            <h2 className="text-fs-lg font-bold tracking-tight text-foreground">
              Your logo on every photo, applied once during import
            </h2>
            <p className="max-w-3xl text-fs-base leading-relaxed text-muted-foreground">
              Upload one transparent PNG — your logo, your sponsors, your event.{' '}
              {BRANDING_WHAT} {BRANDING_PERMANENT} Only one image is ever stored, so
              branding costs no extra storage and downloads stay ordinary file downloads.
            </p>
            <p className="max-w-3xl text-fs-sm font-medium leading-relaxed text-foreground">
              {BRANDING_DECIDE_ONCE}
            </p>
            <p className="text-fs-sm text-muted-foreground">
              Available to every organizer. No plan required.
            </p>
          </div>
        </div>
      </Card>

      {/* ── 2–4 · Preview, upload, status, templates (interactive) ───────── */}
      <BrandingClient />

      {/* ── 5 · Artwork requirements ─────────────────────────────────────── */}
      <StudioSection
        title="5 · Artwork requirements"
        description="These are enforced when you upload — nothing here is advisory except the DPI."
      >
        <Card>
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {REQUIREMENTS.map(r => (
              <div key={r.label} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
                <dt className="text-fs-sm text-muted-foreground">{r.label}</dt>
                <dd className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">{r.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-fs-2xs text-muted-foreground">
            PNG carries no reliable DPI value, so the 300 DPI figure is about how you design
            rather than something we can check. Meeting the pixel dimensions is what matters.
          </p>
        </Card>
      </StudioSection>

      {/* ── 6 · Design guidelines ────────────────────────────────────────── */}
      <StudioSection title="6 · Design guidelines">
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <h3 className="text-fs-md font-semibold text-foreground">Include</h3>
            <ul className="mt-2 space-y-1.5">
              {RECOMMENDED.map(item => (
                <li key={item} className="flex items-start gap-2 text-fs-sm text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h3 className="text-fs-md font-semibold text-foreground">Avoid</h3>
            <ul className="mt-2 space-y-1.5">
              {AVOID.map(item => (
                <li key={item} className="flex items-start gap-2 text-fs-sm text-muted-foreground">
                  <Ban className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </StudioSection>

      {/* ── 7 · Safe area ────────────────────────────────────────────────── */}
      <StudioSection
        title="7 · Safe area"
        description="Where your design is guaranteed to survive on every photo shape."
      >
        <SafeAreaDiagram style={DEFAULT_STYLE} />
      </StudioSection>

      {/* ── 8 · How it works ─────────────────────────────────────────────── */}
      <StudioSection
        title="8 · How it works"
        description="Branding is part of importing, not part of downloading."
      >
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <Card className="h-full">
                <div className="flex size-9 items-center justify-center rounded-xl bg-muted" aria-hidden>
                  <step.icon className="size-[17px] text-muted-foreground" />
                </div>
                <p className="mt-2 text-fs-2xs font-bold uppercase tracking-wide text-muted-foreground">
                  Step {i + 1}
                </p>
                <h3 className="mt-0.5 text-fs-sm font-semibold text-foreground">{step.title}</h3>
                <p className="mt-1 text-fs-2xs leading-relaxed text-muted-foreground">{step.text}</p>
              </Card>
            </li>
          ))}
        </ol>
        <Banner tone="warning" title="Branding cannot be undone">
          {BRANDING_WHY_LOCKED} Decide before you import — there is no way to add, remove
          or replace branding on photos that already exist, short of deleting them and
          importing again.
        </Banner>
        <Banner tone="info" title="Branding, not protection">
          {BRANDING_NOT_PROTECTION}
        </Banner>
      </StudioSection>

      {/* ── 9 · FAQ ──────────────────────────────────────────────────────── */}
      <StudioSection title="9 · Frequently asked questions">
        <div className="space-y-2">
          {FAQ.map(item => (
            <details key={item.q} className={cn('group rounded-xl border border-border bg-card')}>
              <summary className="cursor-pointer list-none px-4 py-3 text-fs-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {item.q}
              </summary>
              <p className="px-4 pb-3.5 text-fs-sm leading-relaxed text-muted-foreground">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </StudioSection>

      {/* ── 10 · Best practices ──────────────────────────────────────────── */}
      <StudioSection title="10 · Best practices">
        <ul className="grid gap-3 sm:grid-cols-2">
          {PRACTICES.map(p => (
            <li key={p.title}>
              <Card className="h-full">
                <h3 className="text-fs-sm font-semibold text-foreground">{p.title}</h3>
                <p className="mt-1 text-fs-2xs leading-relaxed text-muted-foreground">{p.text}</p>
              </Card>
            </li>
          ))}
        </ul>
      </StudioSection>
    </div>
  )
}
