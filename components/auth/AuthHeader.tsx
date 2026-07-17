import type { ReactNode } from 'react'

// ─── AuthHeader ─────────────────────────────────────────────────────────────
// Title + optional subtitle above an auth form. Brand-neutral: the caller
// supplies the copy ("Organizer Login", "Platform Administration", …).

export interface AuthHeaderProps {
  title:     ReactNode
  subtitle?: ReactNode
}

export function AuthHeader({ title, subtitle }: AuthHeaderProps) {
  return (
    <div className="mb-6">
      <h2 className="text-[var(--fs-xl)] font-bold leading-tight tracking-tight text-foreground">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1.5 text-sm leading-snug text-muted-foreground">
          {subtitle}
        </p>
      )}
    </div>
  )
}
