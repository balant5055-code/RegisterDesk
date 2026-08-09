// Phase P.1.5 — Footer column. Server Component.
//
// Typography comes from the semantic roles; every vertical value comes from
// FOOTER_RHYTHM. The column picks neither.
//
// `wide` columns span two grid tracks and flow their links in two sub-columns. That
// exists to keep the navigation band LEVEL: Platform carries 9 links against
// Solutions' 5 and Company's 4, so as a single track it ran twice the height of its
// neighbours and left the band visibly lopsided.

import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { FOOTER_RHYTHM } from '@/lib/marketing/layout'
import { MarketingFooterLink } from './MarketingFooterLink'
import type { FooterColumn } from '@/lib/marketing/types'

export function MarketingFooterColumn({ column, wide = false }: { column: FooterColumn; wide?: boolean }) {
  const headingId = `footer-col-${column.id}`
  return (
    <div className={cn('col-span-2', wide ? 'lg:col-span-2' : 'lg:col-span-1')}>
      <h3 id={headingId} className={cn(typography.tableHeader, 'text-foreground')}>
        {column.title}
      </h3>
      <ul
        aria-labelledby={headingId}
        className={cn(
          FOOTER_RHYTHM.label,
          FOOTER_RHYTHM.rows,
          // Two sub-columns only when the column is wide. space-y is cancelled in
          // that mode (it would only apply down each flow, not across) and the gap
          // takes over.
          wide && 'sm:grid sm:grid-cols-2 sm:gap-x-6 sm:gap-y-1 sm:space-y-0',
        )}
      >
        {column.links.map(link => (
          <li key={`${link.href}-${link.label}`} className="flex">
            <MarketingFooterLink link={link} />
          </li>
        ))}
      </ul>
    </div>
  )
}
