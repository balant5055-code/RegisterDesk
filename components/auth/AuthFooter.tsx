import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── AuthFooter ─────────────────────────────────────────────────────────────
// Small centered note beneath the auth card (e.g. "Not an organizer? Browse
// events"). Brand-neutral — the caller supplies the content. Wrap in a motion
// element if an entrance animation is desired.

export interface AuthFooterProps {
  children:   ReactNode
  className?: string
}

export function AuthFooter({ children, className }: AuthFooterProps) {
  return (
    <p className={cn('text-center text-[13px] text-muted-foreground', className)}>
      {children}
    </p>
  )
}
