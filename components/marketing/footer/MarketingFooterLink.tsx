// Phase P.1.5 — Footer link. Server Component.
//
// The ONE quiet-link surface the footer uses — navigation columns AND the legal row
// in the bottom bar both render through it. The bottom bar previously re-declared a
// near-identical class string purely because its links are a step smaller; that is
// now the `size` prop, so there is a single source for footer link styling.
//
// When the registry supplies an iconKey, the link renders as an icon row: a small
// raised chip that picks up the brand on hover, with the whole row as the hit area.
// The icon is the SAME one the mega-menu shows for that destination (the key is
// carried through from the nav registry), so the two surfaces never disagree.
//
// Renders a registry FooterLink with external / badge / coming-soon handling.

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { fs } from '@/lib/ds/typography'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import type { FooterLink } from '@/lib/marketing/types'

const BASE =
  'group inline-flex items-center gap-2 rounded-lg text-muted-foreground transition-colors ' +
  'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

/** Icon rows take a padded hit area, pulled back by -mx-2 so text stays aligned. */
const ICON_ROW = '-mx-2 w-full px-2 py-1 hover:bg-white/70'

/** Navigation columns read at 13px; the legal row in the bottom bar at 12px. */
const SIZE = { sm: fs.sm, xs: fs.xs } as const
export type FooterLinkSize = keyof typeof SIZE

const CHIP =
  'flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-white ' +
  'text-muted-foreground/70 transition-colors group-hover:border-primary/40 group-hover:text-primary'

export function MarketingFooterLink({ link, size = 'sm' }: { link: FooterLink; size?: FooterLinkSize }) {
  const Icon = link.iconKey ? MARKETING_ICONS[link.iconKey] : null

  const inner = (
    <>
      {Icon && (
        <span className={CHIP}>
          <Icon className="size-3.5" aria-hidden />
        </span>
      )}
      {/* NOT truncated: footer labels like "Registration & Ticketing" are the only
          description of where the link goes, so they wrap rather than clip. */}
      <span className="min-w-0">{link.label}</span>
      {link.badge && (
        <span className={cn(fs['2xs'], 'rounded-full bg-muted px-1.5 py-0.5 font-medium text-muted-foreground')}>
          {link.badge}
        </span>
      )}
      {link.comingSoon && <span className={cn(fs['2xs'], 'text-muted-foreground/60')}>Soon</span>}
      {link.external && <ExternalLink className="size-3 shrink-0" aria-hidden />}
    </>
  )

  const className = cn(BASE, SIZE[size], Icon && ICON_ROW)

  if (link.comingSoon) {
    return <span className={cn(className, 'cursor-default opacity-60')} aria-disabled="true">{inner}</span>
  }

  return (
    <Link
      href={link.href}
      target={link.external ? '_blank' : undefined}
      rel={link.external ? 'noopener noreferrer' : undefined}
      className={className}
    >
      {inner}
    </Link>
  )
}
