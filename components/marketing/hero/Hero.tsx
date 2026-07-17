// Homepage hero — orchestrator (Server Component). Single responsibility: compose
// the hero. Product-first, centered composition (Stripe/Linear/Vercel/Clerk
// pattern): a centered message stacked above a large, centered RegisterDesk
// product canvas. Copy comes from the HERO registry; slides from hero.data.ts.
// Reuses the marketing container + tokens.

import { cn } from '@/lib/utils/cn'
import { MARKETING_CONTAINER } from '@/lib/marketing/layout'
import { HERO } from '@/content/marketing/hero'
import { HeroBackground } from './HeroBackground'
import { HeroAnimatedBackground } from '@/components/marketing/HeroAnimatedBackground'
import { HeroContent } from './HeroContent'
import { HeroProduct } from './HeroProduct'

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden bg-white">
      <HeroBackground />
      <HeroAnimatedBackground />

      <div className={cn(MARKETING_CONTAINER.page, 'relative z-10 flex flex-col items-center pb-4 pt-8 sm:pt-10 lg:pt-14')}>
        <HeroContent content={HERO} />
        <div className="mt-14 w-full sm:mt-16 lg:mt-[72px]">
          <HeroProduct />
        </div>
      </div>
    </section>
  )
}
