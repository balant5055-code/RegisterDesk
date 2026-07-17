// Phase P.1.5 — Footer link. Server Component.
//
// Renders a registry FooterLink with external / badge / coming-soon handling.

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { FooterLink } from '@/lib/marketing/types'

const BASE = 'inline-flex items-center gap-1.5 text-fs-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded'

export function MarketingFooterLink({ link }: { link: FooterLink }) {
  const inner = (
    <>
      {link.label}
      {link.badge && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{link.badge}</span>}
      {link.comingSoon && <span className="text-[10px] text-muted-foreground/60">Soon</span>}
      {link.external && <ExternalLink className="size-3" aria-hidden />}
    </>
  )

  if (link.comingSoon) {
    return <span className={cn(BASE, 'cursor-default opacity-60')} aria-disabled="true">{inner}</span>
  }

  return (
    <Link
      href={link.href}
      target={link.external ? '_blank' : undefined}
      rel={link.external ? 'noopener noreferrer' : undefined}
      className={BASE}
    >
      {inner}
    </Link>
  )
}
