'use client'

// Security & Reliability — a compact enterprise trust section (NOT a card grid).
// Security is already communicated across the page, so this only reassures: a
// gradient heading, six one-line assurances (outlined icon · title · sentence,
// no cards/borders/links), and a trust strip. Same header rhythm + visual
// language as the rest of the homepage. Fades up once with a 40ms stagger; hover
// only. Respects reduced-motion. Reuses Eyebrow · GradientText · existing tokens.

import { motion, useReducedMotion } from 'framer-motion'
import { typography } from '@/lib/ds/typography'
import { KeyRound, Boxes, CreditCard, ScrollText, CalendarCheck, Server } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { SECURITY_TRUST_HEADING, SECURITY_TRUST_ITEMS, SECURITY_TRUST_STRIP } from '@/content/marketing/security'
import type { SecurityTrustItem } from '@/content/marketing/security'

const ACCENT = 'organizations'
const [TITLE_BEFORE, TITLE_AFTER] = SECURITY_TRUST_HEADING.title.split(ACCENT)

const EASE = [0.16, 1, 0.3, 1] as const
const LIST = { hidden: {}, visible: { transition: { staggerChildren: 0.04 } } }
const ITEM = { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } } }

const ICONS: Record<string, LucideIcon> = {
  access: KeyRound, isolation: Boxes, payments: CreditCard,
  audit: ScrollText, event: CalendarCheck, infra: Server,
}

function TrustItem({ item }: { item: SecurityTrustItem }) {
  const Icon = ICONS[item.icon] ?? KeyRound
  return (
    <motion.li variants={ITEM} className="group flex flex-col items-start">
      <span className="flex size-10 items-center justify-center rounded-xl border border-border/60 bg-white transition-transform duration-[180ms] group-hover:-translate-y-0.5">
        <Icon className="size-5 text-primary" strokeWidth={1.8} aria-hidden />
      </span>
      <h3 className="mt-4 text-[16px] font-semibold text-foreground transition-colors duration-[180ms] group-hover:text-primary">{item.title}</h3>
      <p className={`${typography.body} mt-1 text-muted-foreground`}>{item.line}</p>
    </motion.li>
  )
}

export function SecuritySection() {
  const reduce = useReducedMotion() ?? false
  const initial = reduce ? false : 'hidden'

  return (
    <SectionLayout background="white" labelledBy="security-heading">
      {/* Header — same rhythm as the other sections */}
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{SECURITY_TRUST_HEADING.eyebrow}</Eyebrow>
        <h2 id="security-heading" className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}>
          {SECURITY_TRUST_HEADING.title.includes(ACCENT) ? (
            <>
              {TITLE_BEFORE}
              <GradientText>{ACCENT}</GradientText>
              {TITLE_AFTER}
            </>
          ) : (
            SECURITY_TRUST_HEADING.title
          )}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-[680px] text-muted-foreground`}>
          {SECURITY_TRUST_HEADING.description}
        </p>
      </div>

      {/* Assurances — 2 × 3, no cards */}
      <motion.ul
        initial={initial}
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
        variants={LIST}
        className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-x-10 gap-y-10 sm:grid-cols-2"
      >
        {SECURITY_TRUST_ITEMS.map(item => <TrustItem key={item.id} item={item} />)}
      </motion.ul>

      {/* Trust strip */}
      <motion.div
        initial={initial}
        whileInView="visible"
        viewport={{ once: true }}
        variants={ITEM}
        className="mx-auto mt-14 max-w-3xl border-t border-border/60 pt-6 text-center"
      >
        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[var(--fs-sm)] text-muted-foreground">
          <span className="font-medium">Trusted for</span>
          {SECURITY_TRUST_STRIP.map(label => (
            <span key={label} className="flex items-center gap-2">
              <span className="size-1 rounded-full bg-muted-foreground/40" aria-hidden />
              {label}
            </span>
          ))}
        </p>
      </motion.div>
    </SectionLayout>
  )
}
