// Phase P.1.3 — Section heading (eyebrow · title · subtitle). Server Component.
//
// Token-based typography (reuses the app `fs` scale). Heading level is semantic
// (`as`); visual size is fixed at the section-title scale. No hardcoded copy —
// callers pass strings from the content registries.

import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { marketingType } from '@/lib/marketing/theme'
import { Eyebrow } from '@/components/marketing/Eyebrow'

export interface SectionHeaderProps {
  title:     string
  eyebrow?:  string
  subtitle?: string
  align?:    'left' | 'center'
  as?:       'h1' | 'h2' | 'h3'
  id?:       string
  className?: string
}

export function SectionHeader({ title, eyebrow, subtitle, align = 'left', as = 'h2', id, className }: SectionHeaderProps) {
  const Tag = as
  return (
    <div className={cn('flex flex-col gap-5', align === 'center' && 'items-center text-center', className)}>
      {eyebrow && <Eyebrow className={align === 'center' ? undefined : 'self-start'}>{eyebrow}</Eyebrow>}
      <Tag id={id} className={cn(marketingType.sectionHeading)}>
        {title}
      </Tag>
      {subtitle && (
        <p className={cn(typography.body, 'text-muted-foreground', align === 'center' && 'max-w-2xl')}>
          {subtitle}
        </p>
      )}
    </div>
  )
}
