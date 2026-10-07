import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { AUTH_CANVAS_BG } from './AuthSplitLayout'

// AuthShell — the outer frame of the AuthScreen routes (forgot-password, verify-email,
// verify-email-success).
//
// 2026-09-24 (owner: "I don't want this layout"): the magenta marketing panel beside
// the card is gone. With no `left`, the shell is ONE centred column on the same tinted
// canvas /login uses, so every auth screen reads as the same place. `left` is kept as
// an optional slot so the split can return without a new component, but nothing passes
// it today.

export interface AuthShellProps {
  left?: ReactNode
  right: ReactNode
}

export function AuthShell({ left, right }: AuthShellProps) {
  return (
    <main className={cn('min-h-dvh', AUTH_CANVAS_BG)}>
      {left ? (
        <div className="md:grid md:min-h-dvh md:grid-cols-[40%_60%] lg:grid-cols-[45%_55%]">
          {left}
          {right}
        </div>
      ) : (
        right
      )}
    </main>
  )
}
