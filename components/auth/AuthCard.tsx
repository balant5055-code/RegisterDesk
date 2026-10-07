'use client'

import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { EASE, fadeUp } from './authMotion'

// AuthCard — the panel an AuthScreen route renders its step into.
//
// 2026-09-24 luxury pass: the same object as /login's form panel — the 10px panel
// radius, a hairline, a soft elevation-1 lift off the tinted canvas — instead of a
// 24px-radius card floating on a heavy shadow.

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
        'overflow-hidden rounded-[var(--radius-panel)] border border-border/70 bg-card shadow-elevation-1',
        'px-6 py-7 sm:px-10 sm:py-9',
        className,
      )}
    >
      {children}
    </motion.div>
  )
}
