'use client'

// Integrations — a compact trust section (NOT another feature grid). It builds
// confidence that RegisterDesk connects with existing tools via clean status
// chips: live services in one row, roadmap items in the next. Same header rhythm
// + visual language as the rest of the homepage (Eyebrow + gradient heading).
// Fades up once with a 40ms chip stagger; hover only. Respects reduced-motion.
// Reuses Eyebrow · GradientText · the shadow/border/radius/typography tokens.

import { motion, useReducedMotion } from 'framer-motion'
import { typography } from '@/lib/ds/typography'
import { Mail, CreditCard, Flame, FileSpreadsheet, FileText, MessageCircle, Code2, Webhook } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { INTEGRATIONS_HEADING, INTEGRATION_CHIPS, INTEGRATIONS_NOTE } from '@/content/marketing/integrations'
import type { IntegrationChip } from '@/content/marketing/integrations'

const ACCENT = 'tools'
const [TITLE_BEFORE, TITLE_AFTER] = INTEGRATIONS_HEADING.title.split(ACCENT)

const EASE = [0.16, 1, 0.3, 1] as const
const LIST = { hidden: {}, visible: { transition: { staggerChildren: 0.04 } } }
const ITEM = { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } } }

const ICONS: Record<string, LucideIcon> = {
  mail: Mail, card: CreditCard, firebase: Flame, excel: FileSpreadsheet,
  csv: FileText, whatsapp: MessageCircle, api: Code2, webhook: Webhook,
}

function Chip({ chip }: { chip: IntegrationChip }) {
  const Icon = ICONS[chip.icon] ?? Code2
  const live = chip.status === 'live'
  return (
    <motion.li
      variants={ITEM}
      className="flex h-10 list-none items-center gap-2 rounded-full border border-border/60 bg-white px-[18px] shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
      <span className="text-[var(--fs-base)] font-medium text-foreground">{chip.name}</span>
      <span className="ml-1 flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-muted-foreground/40')} aria-hidden />
        <span className={cn('text-[var(--fs-xs)] font-medium', live ? 'text-emerald-600' : 'text-muted-foreground')}>
          {live ? 'Live' : 'Coming soon'}
        </span>
      </span>
    </motion.li>
  )
}

export function IntegrationsSection() {
  const reduce = useReducedMotion() ?? false
  const initial = reduce ? false : 'hidden'
  const live = INTEGRATION_CHIPS.filter(c => c.status === 'live')
  const soon = INTEGRATION_CHIPS.filter(c => c.status === 'coming_soon')

  return (
    <SectionLayout background="white" labelledBy="integrations-heading">
      {/* Header — same rhythm as the other sections */}
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{INTEGRATIONS_HEADING.eyebrow}</Eyebrow>
        <h2 id="integrations-heading" className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}>
          {INTEGRATIONS_HEADING.title.includes(ACCENT) ? (
            <>
              {TITLE_BEFORE}
              <GradientText>{ACCENT}</GradientText>
              {TITLE_AFTER}
            </>
          ) : (
            INTEGRATIONS_HEADING.title
          )}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-[640px] text-muted-foreground`}>
          {INTEGRATIONS_HEADING.description}
        </p>
      </div>

      {/* Chips — live row, then a forced break, then the roadmap row */}
      <motion.ul
        initial={initial}
        whileInView="visible"
        viewport={{ once: true, amount: 0.4 }}
        variants={LIST}
        className="mx-auto mt-10 flex max-w-3xl flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:justify-center"
      >
        {live.map(chip => <Chip key={chip.id} chip={chip} />)}
        <li aria-hidden className="hidden basis-full sm:block" />
        {soon.map(chip => <Chip key={chip.id} chip={chip} />)}
      </motion.ul>

      {/* Bottom note */}
      <motion.p
        initial={initial}
        whileInView="visible"
        viewport={{ once: true }}
        variants={ITEM}
        className={`${typography.body} mx-auto mt-8 max-w-xl text-center text-muted-foreground`}
      >
        {INTEGRATIONS_NOTE}
      </motion.p>
    </SectionLayout>
  )
}
