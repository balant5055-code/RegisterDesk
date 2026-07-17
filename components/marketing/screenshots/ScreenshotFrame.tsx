// Phase P.1.3 — ScreenshotFrame. Server Component.
//
// The single reusable product-screenshot frame. Variants: browser · dashboard ·
// desktop · tablet · mobile. Renders a SKELETON until a REAL capture exists
// (screenshot.status === 'available' with an imagePath) — no fake/illustrated
// screenshots are ever shown. When real images land, it renders next/image.

import Image from 'next/image'
import { cn } from '@/lib/utils/cn'
import type { ScreenshotDef, ScreenshotFrameVariant } from '@/lib/marketing/types'

function Chrome({ variant }: { variant: ScreenshotFrameVariant }) {
  if (variant === 'browser') {
    return (
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/60 px-3 py-2" aria-hidden>
        <span className="size-2.5 rounded-full bg-rose-300" />
        <span className="size-2.5 rounded-full bg-amber-300" />
        <span className="size-2.5 rounded-full bg-emerald-300" />
        <span className="ml-2 h-4 flex-1 rounded-full bg-white" />
      </div>
    )
  }
  if (variant === 'dashboard') {
    return (
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/60 px-3 py-2" aria-hidden>
        <span className="size-4 rounded bg-primary/30" />
        <span className="h-3 w-24 rounded bg-white" />
        <span className="ml-auto h-3 w-10 rounded bg-white" />
      </div>
    )
  }
  return null
}

export interface ScreenshotFrameProps {
  screenshot?: ScreenshotDef
  variant?:    ScreenshotFrameVariant
  alt?:        string
  className?:  string
}

export function ScreenshotFrame({ screenshot, variant, alt, className }: ScreenshotFrameProps) {
  const v        = screenshot?.frame ?? variant ?? 'browser'
  const isDevice = v === 'tablet' || v === 'mobile'
  const radius   = v === 'mobile' ? 'rounded-[2rem]' : 'rounded-2xl'
  const available = screenshot?.status === 'available' && !!screenshot.imagePath

  // Until a REAL capture exists, render nothing — no pulsing skeleton ships on the
  // live marketing site (it reads as unfinished). Each frame lights up automatically
  // the moment its screenshot flips to status 'available' with an imagePath; no
  // other change is needed here or in the consuming sections.
  if (!available || !screenshot) return null

  return (
    <figure className={cn('overflow-hidden border border-border/60 bg-card shadow-lg', radius, isDevice && 'mx-auto max-w-xs p-2', className)}>
      <div className={cn('overflow-hidden', isDevice && 'rounded-2xl')}>
        {!isDevice && <Chrome variant={v} />}
        <Image
          src={screenshot.imagePath as string}
          alt={screenshot.alt || alt || ''}
          width={screenshot.width ?? 2400}
          height={screenshot.height ?? 1500}
          className="h-auto w-full"
        />
      </div>
      {screenshot.title && (
        <figcaption className="px-3 py-2 text-[var(--fs-xs)] text-muted-foreground">{screenshot.title}</figcaption>
      )}
    </figure>
  )
}
