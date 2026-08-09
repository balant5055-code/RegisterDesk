// RD-PHOTO-01 · The safe-area illustration.
//
// An SVG, not a screenshot: it is generated from the SAME spec the validator enforces, so it
// can never describe a rule that is no longer true. "Do not rely on text only" is the
// requirement, and a picture that drifts from the rule would be worse than the text.
//
// Server Component — no hooks, no state.

import { cn } from '@/lib/utils/cn'
import { safeArea, specFor, type BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'

export function SafeAreaDiagram({
  style, className,
}: { style: BrandingStyle; className?: string }) {
  const spec = specFor(style)

  // Drawn in the artwork's own coordinate space, so every label is a real number.
  const W = spec.recommendedWidth
  const H = spec.recommendedHeight
  const safe = safeArea(spec, W, H)

  return (
    <figure className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-xl border border-border bg-card"
        role="img"
        aria-label={
          `Safe area diagram. The artwork is ${W} by ${H} pixels with a transparent background. `
          + `Keep logos and text inside a safe area inset ${Math.round(spec.safeAreaInset * 100)} per cent `
          + `from every edge — ${safe.width} by ${safe.height} pixels.`
        }
      >
        {/* Transparency, drawn the way every design tool draws it. */}
        <defs>
          <pattern id="rd-checker" width="32" height="32" patternUnits="userSpaceOnUse">
            <rect width="32" height="32" fill="var(--muted)" />
            <rect width="16" height="16" fill="var(--background)" />
            <rect x="16" y="16" width="16" height="16" fill="var(--background)" />
          </pattern>
        </defs>

        <rect width={W} height={H} fill="url(#rd-checker)" />

        {/* The safe area. */}
        <rect
          x={safe.x} y={safe.y} width={safe.width} height={safe.height}
          fill="var(--primary)" fillOpacity="0.07"
          stroke="var(--primary)" strokeWidth="4" strokeDasharray="18 12"
        />

        {/* Padding measure, on the left edge. */}
        <line
          x1={0} y1={H / 2} x2={safe.x} y2={H / 2}
          stroke="var(--primary)" strokeWidth="3"
        />
        <text
          x={safe.x / 2} y={H / 2 - 14}
          textAnchor="middle" fontSize="26" fontWeight="700" fill="var(--primary)"
        >
          {safe.x}px
        </text>

        <text
          x={W / 2} y={H / 2 - 8}
          textAnchor="middle" fontSize="34" fontWeight="700" fill="var(--foreground)"
        >
          Safe area — keep logos and text here
        </text>
        <text
          x={W / 2} y={H / 2 + 34}
          textAnchor="middle" fontSize="26" fill="var(--muted-foreground)"
        >
          {safe.width} × {safe.height} px
        </text>

        <text
          x={W / 2} y={H - 16}
          textAnchor="middle" fontSize="24" fill="var(--muted-foreground)"
        >
          Everything outside the dashed line may be cropped on some photo shapes
        </text>
      </svg>

      <figcaption className="mt-2 text-fs-2xs text-muted-foreground">
        Checkerboard = transparent. The dashed rectangle is the safe area:
        {' '}{Math.round(spec.safeAreaInset * 100)}% padding from every edge of a{' '}
        {W} × {H} px banner.
      </figcaption>
    </figure>
  )
}
