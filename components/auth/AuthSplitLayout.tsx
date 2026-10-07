import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── AuthSplitLayout ─────────────────────────────────────────────────────────
//
// The sign-in shell. Purely structural: it knows nothing about Firebase, roles,
// redirects, email verification, validation, social providers or admin
// authorization — it takes two slots and decides where they sit.
//
// ═══ IT HAS TWO SHAPES, AND /login NOW USES THE SECOND ═══════════════════════
// With a `visual`, it is the split it is named for: form left, brand panel right,
// from lg. Without one, there is nothing to split against, so `main` is a single
// full-width column and the form centres itself inside it.
//
// /login is now the second shape. The photograph was removed on request, and the
// important part is that removing it is not "the split with one column empty":
// a `lg:grid-cols-[55fr_45fr]` with a single child pins that child to the first
// 55% of the screen, which would leave the form hard against the left edge of an
// otherwise blank page. The grid is therefore not applied at all when there is no
// panel to grid against.
//
// The split shape is kept because it is still the right composition for an auth
// screen that wants brand imagery, and AuthCarousel + authCarouselSlides are still
// here to fill it.
//
// ═══ WHY THIS IS NOT AuthScreen ══════════════════════════════════════════════
// AuthScreen is THE shared shell for forgot-password, verify-email and
// verify-email-success, and its own header says it exists "so the four panels never
// drift". Redesigning it would redesign those three pages, which are out of scope.
// Teaching it a `variant` prop would be worse: a route-specific branch inside the
// component whose entire job is to be identical everywhere.
//
// ═══ THE VISUAL IS NEVER LOAD-BEARING ════════════════════════════════════════
// Below lg it is not rendered at all — not merely hidden, so a phone never pays for
// the image and the form is the first thing on screen. Above lg it is decorative:
// aria-hidden, and the form column scrolls independently of it.

/**
 * The auth canvas (2026-09-24 luxury pass): a quiet tint — 45% --muted into
 * --background — so the white form panel stands off the page as an object rather than
 * sitting flush on white. A SOLID mix, not an alpha, so anything pinned over it (the
 * phone footer strip, its fade) can paint the identical colour. Token-built, so it
 * follows the theme. Exported for exactly those pinned pieces.
 */
export const AUTH_CANVAS_BG = 'bg-[color-mix(in_srgb,var(--muted)_45%,var(--background))]'
export const AUTH_CANVAS_FROM = 'from-[color-mix(in_srgb,var(--muted)_45%,var(--background))]'

export interface AuthSplitLayoutProps {
  /** The authentication column. Always rendered, at every width. */
  form: ReactNode
  /** Decorative brand panel. Rendered only from lg; omit it and the form centres. */
  visual?: ReactNode
}

export function AuthSplitLayout({ form, visual }: AuthSplitLayoutProps) {
  return (
    <main
      className={cn(
        'min-h-dvh',
        AUTH_CANVAS_BG,
        // The height rule is the same either way — one viewport, no page scroll
        // from lg. Only the grid is conditional.
        'lg:h-dvh lg:overflow-hidden',
        visual && 'lg:grid lg:grid-cols-[55fr_45fr]',
      )}
    >
      {/* The form column owns its own scroll from lg, so a long signup form scrolls
          against a stationary shell rather than moving the whole page.

          `lg:h-full` matters ONLY in the no-panel shape. With a panel, `main` is a
          grid and a grid item stretches to its row by default. Without one, `main`
          is a plain block and this column is a block child, so `lg:min-h-0` leaves
          it at content height — measured, the page footer then sat directly under
          the form at y=645 on a 900px screen instead of at the bottom of it. */}
      <div className={cn('flex min-h-dvh flex-col lg:min-h-0 lg:overflow-y-auto', !visual && 'lg:h-full')}>
        {form}
      </div>

      {visual && (
        <div aria-hidden className="relative hidden overflow-hidden lg:block">
          {visual}
        </div>
      )}
    </main>
  )
}
