import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── IconButton ────────────────────────────────────────────────────────────────
// RD-DS-V3.2 — shared icon-only button. Consolidates the repeated
//   `rounded-md p-1 text-muted-foreground hover:bg-muted`
// close/dismiss control that was hand-rolled across modals and panels.
//
// It renders a plain <button> with the SAME class set — deliberately no injected
// `type`, focus ring, shadow, or size tokens — so every migrated call site is
// pixel-identical AND behaviour-identical (a caller that omitted `type` still
// gets the native default; callers that set `type="button"` keep it). Per-site
// tweaks (e.g. `hover:text-foreground`) are passed via `className` and merged.
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function IconButton({ className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn('rounded-md p-1 text-muted-foreground hover:bg-muted', className)}
        {...props}
      >
        {children}
      </button>
    )
  },
)
