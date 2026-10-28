// Custom Event template — the mobile registration bar.
//
// Always visible below lg (no scroll gate — the shared StickyMobileCTA only appears after
// 480px of scroll): the price and live status on the left, the one action on the right.
// Desktop has the sticky aside card instead, so this is `lg:hidden`.
//
// Reads the same admission resolver as the card and the Admission section, so the bar
// can never offer a registration the page says is closed.
//
// Its height is reserved as bottom padding on <body>, only while the bar exists and only
// below lg. An in-flow spacer cannot do this: the route renders the report link AFTER
// this template, under the footer. The rule is a React 19 hoisted <style> (deduped by
// `href`) so it ships with the component instead of living in globals.css.
//
// No hooks, no state: a Server Component, fixed-position, zero layout reflow.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { formatINR } from '@/components/event-templates/shared/utils/format'
import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import { resolveAdmissionPrice, type AdmissionState } from './admissionModel'
import { LUXE_LABEL, formatSalesMoment } from './luxe'

// 64rem = Tailwind's lg breakpoint; 4.5rem = the bar's height (h-[4.5rem] below).
const RESERVE_BAR_SPACE =
  '@media (width < 64rem){body:has([data-rd-register-bar]){padding-bottom:calc(4.5rem + env(safe-area-inset-bottom))}}'

export function CustomMobileBar({ admission, passes, availability, isFreeEvent }: {
  admission: AdmissionState; passes: PassPublic[]; availability: Record<string, PassAvailability>; isFreeEvent: boolean
}) {
  const isOpen = admission.kind === 'open'
  const { free, from } = resolveAdmissionPrice(admission, passes, availability, isFreeEvent)
  const price = from === null ? null : free ? 'Free' : `From ${formatINR(from)}`

  const status =
    admission.kind === 'open'      ? 'Registration open'
    : admission.kind === 'opens'   ? (formatSalesMoment(admission.opensOn) ? `Opens ${formatSalesMoment(admission.opensOn)}` : 'Opens soon')
    : admission.kind === 'soldout' ? 'Sold out'
    : admission.kind === 'soon'    ? 'Opening soon'
    : 'Registration closed'

  const action = isOpen
    ? { label: 'Register now', href: admission.directHref ?? '#tickets' }
    : admission.kind === 'opens' || admission.kind === 'soon'
      ? { label: 'View details', href: '#tickets' }
      : null

  return (
    <>
      <style href="rd-register-bar" precedence="default">{RESERVE_BAR_SPACE}</style>
      <div
        data-rd-register-bar
        role="region"
        aria-label="Registration"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border/70 bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-12px_rgb(11_21_51/0.18)] backdrop-blur-md lg:hidden"
      >
        <div className="mx-auto flex h-[4.5rem] max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="min-w-0">
            <p className={cn(LUXE_LABEL, 'flex items-center gap-1.5 tracking-[0.14em]')}>
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-pill', isOpen ? 'bg-action' : 'bg-hero-accent-rule')} />
              <span className="truncate">{status}</span>
            </p>
            {price && (
              <p className="mt-1 font-display text-fs-xl font-light tabular-nums text-hero-ink leading-none">{price}</p>
            )}
          </div>
  
          {action && (
            <Link
              href={action.href}
              className={cn(
                isOpen
                  ? marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'lg' })
                  : marketingButton({ variant: 'outline', size: 'lg' }),
                'shrink-0 gap-2 px-6',
              )}
            >
              {action.label}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          )}
        </div>
      </div>
    </>
  )
}
