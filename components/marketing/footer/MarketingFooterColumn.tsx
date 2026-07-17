// Phase P.1.5 — Footer column. Server Component.

import { MarketingFooterLink } from './MarketingFooterLink'
import type { FooterColumn } from '@/lib/marketing/types'

export function MarketingFooterColumn({ column }: { column: FooterColumn }) {
  const headingId = `footer-col-${column.id}`
  return (
    <div>
      <h3 id={headingId} className="text-fs-xs font-semibold uppercase tracking-wider text-foreground">
        {column.title}
      </h3>
      <ul aria-labelledby={headingId} className="mt-3 space-y-2">
        {column.links.map(link => (
          <li key={`${link.href}-${link.label}`}>
            <MarketingFooterLink link={link} />
          </li>
        ))}
      </ul>
    </div>
  )
}
