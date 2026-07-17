import type { ReactNode } from 'react'

// ─── AuthShell ──────────────────────────────────────────────────────────────
// Slot-based two-column auth layout. Purely structural — it owns NO branding
// and NO auth logic. Each caller (organizer / admin / future support) supplies
// its own `left` brand panel and `right` form column.
//
//   <AuthShell left={<BrandPanel />} right={<FormColumn />} />
//
// The grid is a two-column split from `md` up (40/60 on tablet, 45/55 on
// desktop) and collapses to a single column below `md`; callers render their
// own mobile brand treatment inside `right`.

export interface AuthShellProps {
  left:  ReactNode
  right: ReactNode
}

export function AuthShell({ left, right }: AuthShellProps) {
  return (
    <main className="min-h-dvh bg-background md:h-dvh md:overflow-hidden">
      {/* Desktop 45 / 55 (marketing / auth) · Tablet 40 / 60 · Mobile single column */}
      <div className="md:grid md:h-full md:grid-cols-[40%_60%] lg:grid-cols-[45%_55%]">
        {left}
        {right}
      </div>
    </main>
  )
}
