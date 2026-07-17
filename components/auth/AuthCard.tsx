'use client'

import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { EASE, fadeUp } from './authMotion'

// ─── AuthCard ───────────────────────────────────────────────────────────────
// The elevated card that holds an auth form. `layout` animates its height when
// the inner form swaps (e.g. login ↔ signup); `overflow-hidden` clips the
// opacity-only transitions. When mounted inside a `stagger` parent it inherits
// the fade-up entrance; standalone it simply renders.

export interface AuthCardProps {
  children:   ReactNode
  className?: string
}

export function AuthCard({ children, className }: AuthCardProps) {
  return (
    <motion.div
      variants={fadeUp}
      layout
      transition={{ layout: { duration: 0.22, ease: EASE } }}
      className={cn(
        'overflow-hidden rounded-3xl bg-card',
        // Extra horizontal breathing room so controls never sit edge-to-edge.
        // Vertical 24 / 32 / 40 · Horizontal 32 / 40 / 48 (mobile / tablet / desktop).
        'px-8 py-6 sm:px-10 sm:py-8 lg:px-12 lg:py-10',
        // Soft shadow only — no hard border ring (premium enterprise card).
        'shadow-[0_10px_44px_rgb(0_0_0/0.08),0_2px_10px_rgb(0_0_0/0.04)]',
        className,
      )}
    >
      {children}
    </motion.div>
  )
}
