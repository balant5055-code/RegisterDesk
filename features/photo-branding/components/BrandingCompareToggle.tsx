'use client'

// RD-PHOTO-09 · With / without branding.
//
// The single most useful control for judging a banner: contrast against the photograph is
// impossible to assess without seeing the same frame both ways.
//
// It lives in the panel's `action` slot, so it costs NO vertical space — the preview section
// was 1214px, of which 1093px was the photo box, and this sprint exists to bring that down.
//
// Built from the same parts as `CompressionSelector`'s segmented control: a bordered group of
// pressed-state buttons. Not a radiogroup — that role commits to arrow-key navigation with a
// roving tabindex, and a two-button toggle does not need one (RD-MEDIA-UX-03 fixed exactly
// that mistake elsewhere).

import { cn } from '@/lib/utils/cn'

export interface BrandingCompareToggleProps {
  /** True when the overlay is drawn on the preview. */
  showOverlay: boolean
  onChange: (showOverlay: boolean) => void
}

export function BrandingCompareToggle({ showOverlay, onChange }: BrandingCompareToggleProps) {
  return (
    <div
      role="group"
      aria-label="Preview with or without branding"
      className="flex shrink-0 gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {[
        { on: true,  label: 'With branding' },
        { on: false, label: 'Without' },
      ].map(opt => (
        <button
          key={opt.label}
          type="button"
          aria-pressed={showOverlay === opt.on}
          onClick={() => onChange(opt.on)}
          className={cn(
            'rounded-md px-2.5 py-1 text-fs-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            showOverlay === opt.on
              ? 'bg-card font-semibold text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
