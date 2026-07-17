// Shared marketing content-card shell (LS2.3C-A).
//
// Owns ONLY the static card surface — radius, border, background, padding — plus
// an optional `interactive` treatment. Everything else (flex layout, gap, hover,
// focus, transitions, the rendered element, and content) stays in the consumer's
// className / `as`. Reuses the existing tokens + cn — NOT a new design system.
//
//   <Card className="flex h-full flex-col">…</Card>            // static div
//   <Card as={Link} href={…} className="flex h-full flex-col …">…</Card>  // link card

import type { ElementType, ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils/cn'

/** The static card surface. Exported for the rare consumer that needs the raw class. */
export const CARD_BASE = 'rounded-2xl border border-border/60 bg-white p-6'

/** Opt-in interactive surface (border-first hover + focus ring). */
const CARD_INTERACTIVE =
  'transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

type CardOwnProps = { interactive?: boolean; className?: string }

export function Card<T extends ElementType = 'div'>({
  as,
  interactive = false,
  className,
  ...props
}: { as?: T } & CardOwnProps & Omit<ComponentPropsWithoutRef<T>, 'as' | keyof CardOwnProps>) {
  const Comp: ElementType = as ?? 'div'
  return <Comp className={cn(CARD_BASE, interactive && CARD_INTERACTIVE, className)} {...props} />
}
