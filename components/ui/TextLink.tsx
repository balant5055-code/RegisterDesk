import type { ReactNode, MouseEventHandler } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'

// ─── TextLink ──────────────────────────────────────────────────────────────────
// RD-DS-V3.2 — shared inline text link. Consolidates the repeated
//   `text-[13px] text-primary hover:underline`
// styling that was hand-rolled on both <Link> (navigation) and <button> (retry /
// re-load actions). Polymorphic: renders a Next <Link> when `href` is provided,
// otherwise a <button>. The class set is identical to the former markup, so every
// migrated call site is pixel-identical.
export interface TextLinkProps {
  href?:      string
  onClick?:   MouseEventHandler
  className?: string
  children:   ReactNode
}

export function TextLink({ href, onClick, className, children }: TextLinkProps) {
  const cls = cn('text-[13px] text-primary hover:underline', className)
  return href !== undefined
    ? <Link href={href} className={cls}>{children}</Link>
    : <button onClick={onClick} className={cls}>{children}</button>
}
