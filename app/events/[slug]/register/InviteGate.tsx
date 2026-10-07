'use client'

// InviteGate — the invite-code screen of /events/[slug]/register.
//
// Lifted out of RegisterClient (behaviour, handlers and verification unchanged — the
// parent still owns the state and calls the same handleVerifyInviteCode). The screen is
// designed as an invitation rather than a lock screen: the event the attendee was
// invited TO sits on the left (poster, name, date, place, pass), the one field they need
// sits on the right. It speaks the same editorial language as the public event page they
// arrived from (Fraunces display, bronze hairline, the public --action indigo → violet),
// so the handoff from "Register now" does not feel like a different product.
//
// The rest of /register still runs on the product accent (--primary). This screen was moved
// to the public theme on the owner's instruction (2026-09-23: "we are not going to use"
// the pink); publicEventBrandMigration §3 exempts THIS file by name.
//
// Canvas, top bar and panel come from the route's own registerTheme / RegistrationUI.

import type { FormEvent } from 'react'
import { KeyRound, ArrowRight, CalendarDays, MapPin, Globe, Ticket, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { formatDate, formatTime } from '@/components/event-templates/shared/utils/format'
import { CANVAS_STYLE, CANVAS, PAGE, PANEL } from './registerTheme'
import { CheckoutTopBar, CheckoutBreadcrumb, CheckoutFooter } from './RegistrationUI'
import { controlCls, FieldError } from './formControls'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

const LABEL = 'text-fs-2xs font-semibold uppercase tracking-[0.2em] text-hero-eyebrow'

export interface InviteGateProps {
  eventSlug:  string
  eventName:  string
  bannerUrl:  string
  startDate:  string | null
  startTime:  string | null
  venueName:  string
  venueCity:  string
  venueType:  string
  passName:   string | null
  value:      string
  error:      string | null
  checking:   boolean
  onChange:   (value: string) => void
  onSubmit:   () => void
}

export function InviteGate({
  eventSlug, eventName, bannerUrl, startDate, startTime, venueName, venueCity, venueType,
  passName, value, error, checking, onChange, onSubmit,
}: InviteGateProps) {
  const date  = formatDate(startDate ?? '')
  const when  = [date, startTime ? formatTime(startTime) : ''].filter(Boolean).join(' · ')
  const venue = venueName.trim()
  const city  = venueCity.trim()
  // Never print the city twice when the venue label already carries it.
  const where = venueType === 'online'
    ? 'Online'
    : [venue, city && !venue.toLowerCase().includes(city.toLowerCase()) ? city : ''].filter(Boolean).join(', ')

  const facts = [
    when  && { Icon: CalendarDays, text: when },
    where && { Icon: venueType === 'online' ? Globe : MapPin, text: where },
    passName?.trim() && { Icon: Ticket, text: passName.trim() },
  ].filter(Boolean) as { Icon: typeof MapPin; text: string }[]

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!checking) onSubmit()
  }

  return (
    <div style={CANVAS_STYLE} className={cn('flex min-h-screen flex-col', CANVAS)}>
      <CheckoutTopBar eventSlug={eventSlug} secure={false} />

      <main className={cn(PAGE, 'flex flex-1 flex-col pt-5 sm:pt-7')}>
        <CheckoutBreadcrumb eventSlug={eventSlug} eventName={eventName} />

        <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
          <div className={cn(PANEL, 'grid w-full max-w-4xl overflow-hidden md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]')}>

            {/* ── The invitation ─────────────────────────────────────────────── */}
            <aside className="flex flex-col border-b border-border/60 bg-surface-3/50 p-5 sm:p-7 md:border-b-0 md:border-r">
              {/* Mobile: a thumbnail beside the name, so the code field stays above the fold.
                  From md the poster is shown whole above it. */}
              <div className="flex items-center gap-4 md:block">
                <div className="w-20 shrink-0 rounded-xl border border-border/70 bg-card p-1 md:w-auto md:p-2">
                  {bannerUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- organizer artwork of arbitrary aspect; shown whole
                    <img
                      src={bannerUrl}
                      alt={`${eventName} — event poster`}
                      className="mx-auto block aspect-square w-full rounded-lg object-cover md:aspect-auto md:h-auto md:max-h-64 md:object-contain"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-surface-3/60 md:aspect-[16/10]">
                      <span aria-hidden className="font-display text-fs-2xl font-light text-hero-accent-rule leading-none md:text-fs-5xl">
                        {eventName.trim().charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>

                <div className="min-w-0 md:mt-6">
                  <p className={cn(LABEL, 'flex items-center gap-2.5')}>
                    <span aria-hidden className="h-px w-6 bg-hero-accent-rule" />
                    You&apos;re invited to
                  </p>
                  <p className="mt-1.5 text-balance font-display text-fs-lg text-hero-ink leading-snug sm:text-fs-xl md:mt-2 md:text-fs-2xl">
                    {eventName}
                  </p>
                </div>
              </div>

              {facts.length > 0 && (
                <ul className="mt-4 space-y-2 border-t border-border/60 pt-4 md:mt-5 md:space-y-2.5 md:pt-5">
                  {facts.map(({ Icon, text }) => (
                    <li key={text} className="flex items-start gap-2.5 text-fs-sm text-hero-ink">
                      <Icon className="mt-0.5 size-4 shrink-0 text-hero-accent-rule" aria-hidden />
                      <span className="min-w-0">{text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </aside>

            {/* ── The code ───────────────────────────────────────────────────── */}
            <form onSubmit={handleSubmit} noValidate className="flex flex-col justify-center p-5 sm:p-8 md:p-10">
              <span className="hidden size-11 items-center justify-center rounded-full border border-hero-accent-rule/50 bg-card text-hero-accent-rule md:inline-flex">
                <KeyRound className="size-5" aria-hidden />
              </span>

              <h1 className={`md:mt-5 ${PAGE_TITLE}`}>
                By invitation only
              </h1>
              <p className="mt-2.5 max-w-sm text-fs-base text-hero-ink-soft leading-relaxed">
                Registration for this event is private. Enter the invite code you received from the organizer to continue.
              </p>

              <label htmlFor="invite-code" className={cn(LABEL, 'mt-6 block md:mt-8')}>Invite code</label>
              <input
                id="invite-code"
                type="text"
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="Enter your code"
                value={value}
                onChange={e => onChange(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'invite-code-error' : undefined}
                className={cn(
                  controlCls(!!error),
                  // 6px (--radius-control): a squarer field than the route's rounded-xl default. Written
                  // as an arbitrary value because cn()/tailwind-merge does not know the custom
                  // `rounded-control` name and would keep rounded-xl beside it (which wins).
                  'mt-2 h-12 rounded-[var(--radius-control)] text-center font-mono text-fs-md tracking-[0.28em] placeholder:font-sans placeholder:tracking-normal',
                  !error && 'focus:border-action/70 focus:shadow-[0_0_0_4px_rgb(var(--action-rgb)_/_0.12)]',
                )}
              />
              {error && <FieldError id="invite-code-error">{error}</FieldError>}

              <button
                type="submit"
                disabled={checking}
                className={cn(marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'lg' }), 'mt-4 h-12 w-full gap-2 rounded-[var(--radius-control)]')}
              >
                {checking ? 'Verifying…' : 'Continue'}
                {!checking && <ArrowRight className="size-4" aria-hidden />}
              </button>

              <p className="mt-7 flex items-start gap-2.5 border-t border-border/60 pt-5 text-fs-xs text-hero-ink-soft leading-relaxed">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-hero-accent-rule" aria-hidden />
                No code yet? Invite codes are shared privately by the event organizer.
              </p>
            </form>
          </div>
        </div>
      </main>

      <CheckoutFooter />
    </div>
  )
}
