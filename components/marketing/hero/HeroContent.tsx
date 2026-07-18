'use client'

// Homepage hero — the message column. Single responsibility: eyebrow, headline,
// description, CTAs, and trust points. Owns its staggered fade-up entrance
// (40px / 600ms). Copy is passed in (registry-driven); CTAs resolve from the CTA
// registry.

import Link from 'next/link'
import { ArrowRight, Play, Check } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils/cn'
import { getCta } from '@/lib/marketing/cta'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import type { HeroSectionContent } from '@/lib/marketing/types'

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

// RegisterDesk brand gradient (#fb5a6a → #e5277e — matches --primary-gradient).
const GRADIENT = 'bg-[linear-gradient(90deg,var(--primary-from),var(--primary))]'

// Only these words carry the brand gradient; the rest stays solid #0F172A.
const GRADIENT_WORDS = new Set(['registration', 'settlement'])

function Headline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(registration|settlement)/g).map((part, i) =>
        GRADIENT_WORDS.has(part)
          ? <span key={i} className={cn(GRADIENT, 'bg-clip-text text-transparent [-webkit-background-clip:text]')}>{part}</span>
          : <span key={i}>{part}</span>,
      )}
    </>
  )
}

export function HeroContent({ content }: { content: HeroSectionContent }) {
  const reduce    = useReducedMotion() ?? false
  const primary   = getCta(content.primaryCta)
  const secondary = getCta(content.secondaryCta)

  // Staggered fade-up; inert under reduced motion.
  const rise = (delay: number) =>
    reduce
      ? {}
      : { initial: { opacity: 0, y: 40 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay, ease: EASE } }

  return (
    <div className="mx-auto flex max-w-[800px] flex-col items-center text-center">
      {/* Eyebrow */}
      <motion.div {...rise(0)}>
        <Eyebrow>{content.eyebrow}</Eyebrow>
      </motion.div>

      {/* Headline */}
      <motion.h1
        {...rise(0.06)}
        id="hero-heading"
        className="mt-8 max-w-[780px] text-balance text-[clamp(2.9rem,4vw,3.75rem)] font-black leading-[0.95] tracking-[-0.03em] text-[#0F172A]"
      >
        <Headline text={content.headline} />
      </motion.h1>

      {/* Description */}
      <motion.p
        {...rise(0.12)}
        className="mt-6 max-w-[560px] text-[16px] leading-[1.75] text-[#64748B] sm:text-[18px] lg:text-[20px]"
      >
        {content.description}
      </motion.p>

      {/* CTAs */}
      <motion.div {...rise(0.18)} className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={primary.href}
          className={cn(
            GRADIENT,
            'inline-flex h-11 items-center justify-center gap-2 rounded-[14px] px-6 text-[var(--fs-md)] font-semibold text-white transition-all duration-200 ease-out hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 md:h-[46px] lg:h-12',
          )}
        >
          {primary.label}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
        <Link
          href={secondary.href}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-border/50 bg-white px-6 text-[var(--fs-md)] font-semibold text-[#0F172A] transition-all duration-200 ease-out hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 md:h-[46px] lg:h-12"
        >
          <Play className="size-4" strokeWidth={1.8} aria-hidden />
          {secondary.label}
        </Link>
      </motion.div>

      {/* Trust row */}
      <motion.ul {...rise(0.24)} className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-7">
        {content.trustPoints.map(point => (
          <li key={point} className="flex items-center gap-2.5 text-[var(--fs-md)] font-medium text-[#0F172A]">
            <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full', GRADIENT)}>
              <Check className="size-2.5 text-white" strokeWidth={3} aria-hidden />
            </span>
            {point}
          </li>
        ))}
      </motion.ul>
    </div>
  )
}
