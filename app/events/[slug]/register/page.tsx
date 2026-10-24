// /events/[slug]/register
//
// Server component — all sensitive data loaded server-side.
// Never trusts passId or any other query parameter for pricing.
// Gate check runs here; blocked states are rendered without round-tripping to client.

import { notFound }            from 'next/navigation'
import Link                    from 'next/link'
import { findPublicEvent }     from '@/lib/events/publicEventAccess'
import { resolveEffectivePriceRupees, eventTimezone } from '@/lib/pricing/earlyBird'
import { checkRegistrationGate, GATE_REASON_LABELS } from '@/lib/registrations/gate'
import { resolveMilestoneAlert } from '@/lib/events/milestoneAlerts'
import type { MilestoneAlert } from '@/lib/events/milestoneAlerts'
import { buildRegisterHref }   from '@/lib/events/registerHref'
import type { Metadata }       from 'next'
import { buildMetadata }       from '@/lib/marketing/seo'
import { ToastProvider } from '@/components/ui/Toast'
import { RegisterClient }      from './RegisterClient'
import { explicitFeeModel }    from '@/lib/fees/explicitFeeModel'
import { resolvePlatformPricing } from '@/lib/platform/pricing/resolver'
import { PassPrice }          from './PassPrice'
import { ageRangeLabel }      from '@/lib/registrations/ageEligibility'
import { WaitlistJoinClient }  from './WaitlistJoinClient'
// RD-RT4.0 — presentation only. `registerTheme` is intentionally NOT a client module, so
// these are real strings here rather than client references; CheckoutTopBar is the one
// client component the server screens render.
import { CheckoutTopBar, CheckoutBreadcrumb, CheckoutFooter } from './RegistrationUI'
import { CANVAS_STYLE, CANVAS, PAGE, PANEL, PANEL_HEAD, PANEL_BODY, FOCUS_RING } from './registerTheme'
import { buttonVariants }      from '@/components/ui/button'
import { Ticket, ArrowRight, ShieldCheck, CalendarX2 } from 'lucide-react'
import type {
  FormSection,
  ConditionalRule,
  RegistrationFormDraft,
} from '@/components/wizard/registrationFormConfig'
import { passAgeLimits } from '@/lib/passes/passRaceRules'

// RD-LAUNCH-07 — registration links are shared constantly (WhatsApp, Slack, DMs) and
// previously produced a preview with no title, description or image at all. Built from
// the event the page already loads, so no extra read is introduced.
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params
  const event = await findPublicEvent(slug)
  const name  = typeof (event?.eventDetails as { info?: { name?: string } } | null)?.info?.name === 'string'
    ? (event!.eventDetails as { info: { name: string } }).info.name
    : 'Event'
  return buildMetadata({
    title:       `Register — ${name} | RegisterDesk`,
    description: `Complete your registration for ${name}.`,
    path:        `/events/${slug}/register`,
    // RD-SEO-01 — this is the checkout step: thin, duplicated from the event page it is
    // reached from, and the wrong result to rank for the event's own name. The event page
    // is the canonical destination for search.
    //
    // noIndex, NOT a robots.txt Disallow: link unfurlers (WhatsApp, Slack) honour
    // robots.txt but ignore the meta robots tag, so this keeps the share preview above
    // working while still keeping the URL out of Google's index.
    noIndex:     true,
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PassPublic {
  id:           string
  name:         string
  price:        number        // effective price — early-bird while active, else regular
  regularPrice: number        // regular price (for strikethrough when early bird is active)
  isFree:       boolean
  unlimited:    boolean
  quantity:     number | null
  status:       string
  description?: string
  // RD-RT1.0: already present on the pricing doc; surfaced so the registration
  // arrival can show "Registration closes". No new query, no schema change.
  salesEndDate?: string
  // RD-RT3.2.2: per-pass age limits set in the pass editor (raceDetails).
  minAge?:       number | null
  maxAge?:       number | null
  // Organizer-configured milestone notices, carried through extractPasses. Declared on the
  // type — not read via a cast — so that dropping it from the projection is a COMPILE error
  // rather than a feature that silently never fires. Reuses the canonical MilestoneAlert
  // shape instead of restating it, so the two can never drift.
  milestoneAlerts?: MilestoneAlert[]
}

// ─── Pass extraction ──────────────────────────────────────────────────────────

function extractPasses(pricing: Record<string, unknown> | null, tz?: string): PassPublic[] {
  if (!pricing) return []
  const raw = Array.isArray(pricing.passes) ? pricing.passes as Record<string, unknown>[] : []
  const now = Date.now()
  return raw
    .filter(p => p.status === 'active')
    .map(p => {
      const regularPrice = typeof p.price === 'number' ? p.price : 0
      // Effective price via the shared resolver so the checkout screen shows the
      // exact amount create-order will charge (early-bird while active, else regular).
      const price = resolveEffectivePriceRupees(
        {
          price:            regularPrice,
          earlyBirdEnabled: p.earlyBirdEnabled === true,
          earlyBirdPrice:   typeof p.earlyBirdPrice === 'number' ? p.earlyBirdPrice : null,
          earlyBirdEndDate: typeof p.earlyBirdEndDate === 'string' ? p.earlyBirdEndDate : undefined,
        },
        now,
        tz,   // RD-CE-FIX — the cutoff is in the event timezone (same as create-order charges)
      )
      return {
        id:          String(p.id ?? ''),
        name:        String(p.name ?? 'Pass'),
        price,
        regularPrice,
        isFree:      regularPrice === 0 || p.isFree === true,
        unlimited:   p.unlimited === true,
        quantity:    typeof p.quantity === 'number' ? p.quantity : null,
        status:      String(p.status ?? 'active'),
        description: typeof p.description === 'string' ? p.description : undefined,
        salesEndDate: typeof p.salesEndDate === 'string' ? p.salesEndDate : undefined,
        // Milestone configuration is CARRIED THROUGH, not spread. This projection deliberately
        // narrows the stored pass — dropping internals the checkout screen has no business
        // seeing — so `...p` would be a regression, not a fix. Copied only when it is genuinely
        // an array: a malformed value stays absent and the resolver treats the pass as
        // unconfigured, which is the same thing it does for every pass today.
        ...(Array.isArray(p.milestoneAlerts)
          ? { milestoneAlerts: p.milestoneAlerts as PassPublic['milestoneAlerts'] }
          : {}),
        // RD-CE-FIX H2 · the age window only — a team size is never shown or enforced as an age.
        ...passAgeLimits(p as Record<string, unknown>),
      }
    })
}

// ─── Blocked state UI ─────────────────────────────────────────────────────────
// RD-RT4.0: the blocked and picker screens now open on the SAME canvas and checkout bar
// as the form, so arriving at a closed event does not look like a different product.
// Presentation only — the gate decision above is untouched.

function BlockedScreen({
  reason,
  eventSlug,
}: {
  reason: string | undefined
  eventSlug: string
}) {
  const label = reason && reason in GATE_REASON_LABELS
    ? GATE_REASON_LABELS[reason as keyof typeof GATE_REASON_LABELS]
    : 'Registration is not available'

  return (
    <div style={CANVAS_STYLE} className={`flex min-h-screen flex-col ${CANVAS}`}>
      <CheckoutTopBar eventSlug={eventSlug} secure={false} />
      <div className={`${PAGE} flex flex-1 items-center justify-center py-12`}>
        <div className={`${PANEL} ${PANEL_BODY} w-full max-w-md text-center`}>
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <CalendarX2 className="size-6" aria-hidden />
          </div>
          <h1 className="text-fs-lg font-bold tracking-tight text-foreground">Registration Unavailable</h1>
          <p className="mx-auto mt-2 max-w-sm text-fs-base leading-relaxed text-muted-foreground">{label}</p>
          <Link
            href={`/events/${eventSlug}`}
            className={`${buttonVariants({ variant: 'primary', size: 'lg' })} mt-6 w-full`}
          >
            Back to Event
          </Link>
        </div>
      </div>
      <CheckoutFooter />
    </div>
  )
}

// ─── Pass selection UI (no passId in query) ───────────────────────────────────
// The FIRST decision of the flow, and previously a list of four-line rows. It is now the
// same selectable-card language the in-form pass switcher uses, so choosing a pass looks
// identical whether you do it here or change your mind two screens later. Same links,
// same buildRegisterHref destination, same data.

function PassSelectionScreen({
  passes,
  eventSlug,
  eventName,
}: {
  passes:    PassPublic[]
  eventSlug: string
  eventName: string
}) {
  if (passes.length === 0) {
    return (
      <BlockedScreen reason="PASS_NOT_FOUND" eventSlug={eventSlug} />
    )
  }

  return (
    <div style={CANVAS_STYLE} className={`relative flex min-h-screen flex-col ${CANVAS}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(100%_100%_at_50%_0%,rgb(var(--primary-rgb)_/_0.06)_0%,transparent_70%)]"
      />
      <CheckoutTopBar eventSlug={eventSlug} secure={false} />

      <div className={`${PAGE} relative flex-1 pb-10 pt-5 sm:pb-14 sm:pt-7`}>
        <CheckoutBreadcrumb eventSlug={eventSlug} eventName={eventName} />
        <div className="mx-auto mt-6 max-w-2xl sm:mt-8">
          <div className="mb-7 text-center">
            <p className="text-fs-xs font-bold uppercase tracking-[0.14em] text-primary">Event Registration</p>
            <h1 className="mt-2 text-fs-xl font-bold leading-tight tracking-tight text-foreground sm:text-fs-2xl">
              {eventName}
            </h1>
            <p className="mt-2 text-fs-base text-muted-foreground">
              Choose the pass you want, then fill in your details.
            </p>
          </div>

          <div className={PANEL}>
            <div className={`${PANEL_HEAD} flex items-center justify-between gap-3 rounded-t-xl`}>
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Ticket className="size-3.5" />
                </span>
                <h2 className="font-display text-fs-lg font-normal text-hero-ink leading-snug">Choose your pass</h2>
              </div>
              <span className="shrink-0 text-fs-2xs font-semibold text-muted-foreground">
                {passes.length} {passes.length === 1 ? 'option' : 'options'}
              </span>
            </div>

            <div className={`${PANEL_BODY} flex flex-col gap-2.5`}>
              {passes.map(pass => {
                const ageLabel = ageRangeLabel({ minAge: pass.minAge ?? null, maxAge: pass.maxAge ?? null })
                return (
                  <Link
                    key={pass.id}
                    href={buildRegisterHref(eventSlug, pass.id)}
                    className={
                      'group relative flex items-center gap-3.5 overflow-hidden rounded-xl border border-border bg-card p-4 ' +
                      'transition-[border-color,background-color,box-shadow,transform] duration-200 ' +
                      'hover:border-primary/45 hover:bg-[rgb(var(--primary-rgb)_/_0.03)] ' +
                      'hover:shadow-[0_2px_16px_-6px_rgb(var(--primary-rgb)_/_0.35)] motion-safe:hover:-translate-y-px ' +
                      FOCUS_RING
                    }
                  >
                    {/* Brand edge — grows in on hover / keyboard focus. */}
                    <span
                      aria-hidden
                      className={
                        'absolute inset-y-0 left-0 w-[3px] origin-top scale-y-0 rounded-r-full bg-[image:var(--primary-gradient)] ' +
                        'transition-transform duration-300 group-hover:scale-y-100 group-focus-visible:scale-y-100 motion-reduce:transition-none'
                      }
                    />

                    <span className="ml-0.5 min-w-0 flex-1">
                      <span className="block truncate text-fs-md font-bold leading-snug text-foreground">{pass.name}</span>
                      {pass.description && (
                        <span className="mt-0.5 block truncate text-fs-xs text-muted-foreground">{pass.description}</span>
                      )}
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {/* RD-RT3.2.3: eligibility at the FIRST place a pass is chosen, so an
                            age problem is visible before any form is filled in. */}
                        {ageLabel && (
                          <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-fs-2xs font-medium text-muted-foreground">
                            Age {ageLabel}
                          </span>
                        )}
                        {!pass.unlimited && pass.quantity !== null && (
                          <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-fs-2xs font-medium text-muted-foreground">
                            {pass.quantity} seats
                          </span>
                        )}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-3">
                      {/* RD-RT3.2.2: the picker printed a bare price, hiding an active
                          early-bird discount at the very first place it is shown. */}
                      <PassPrice price={pass.price} regularPrice={pass.regularPrice} isFree={pass.isFree} />
                      <ArrowRight
                        className="size-4 shrink-0 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transition-none"
                        aria-hidden
                      />
                    </span>
                  </Link>
                )
              })}
            </div>
          </div>

          <p className="mt-5 flex items-center justify-center gap-1.5 text-fs-2xs font-medium text-muted-foreground">
            <ShieldCheck className="size-3 shrink-0 text-emerald-600" aria-hidden />
            Secure checkout · instant e-ticket
          </p>
        </div>
      </div>
      <CheckoutFooter />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params:      Promise<{ slug: string }>
  searchParams: Promise<{ passId?: string }>
}) {
  const { slug }   = await params
  const { passId } = await searchParams

  // findPublicEvent, not a bare document read: registration used to render for a draft or
  // taken-down event because it only checked that the document existed. The layout above
  // has already 404'd those; this keeps the rule true if that layout ever moves.
  const event = await findPublicEvent(slug)
  if (!event) notFound()

  const rawDetails  = event.eventDetails as Record<string, unknown>
  const rawInfo     = rawDetails?.info as Record<string, unknown> | null
  const eventName   = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'
  const rawPricing  = event.pricing as Record<string, unknown> | null
  const passes      = extractPasses(rawPricing, eventTimezone(event))

  // No passId → show pass picker
  if (!passId) {
    return (
      <PassSelectionScreen
        passes={passes}
        eventSlug={slug}
        eventName={eventName}
      />
    )
  }

  // Run gate check server-side
  const gate = await checkRegistrationGate(slug, passId)

  // When capacity is full but waitlist is enabled, render the join-waitlist form
  if (!gate.allowed && gate.reason === 'WAITLIST_AVAILABLE') {
    const wlPass = passes.find(p => p.id === passId)
    return (
      <WaitlistJoinClient
        eventSlug={slug}
        eventName={eventName}
        passId={passId}
        passName={wlPass?.name ?? 'Pass'}
      />
    )
  }

  if (!gate.allowed) {
    return <BlockedScreen reason={gate.reason} eventSlug={slug} />
  }

  // Resolve pass for this registration
  const pass = passes.find(p => p.id === passId)
  if (!pass) {
    return <BlockedScreen reason="PASS_NOT_FOUND" eventSlug={slug} />
  }

  // ── Booking Milestone Alert (informational) ─────────────────────────────────
  // Uses the count the GATE already loaded — `checkRegistrationGate` reads the registration
  // counter to enforce capacity, so `availability.passCount` is the same number, free of any
  // additional Firestore read. Resolved AFTER the gate decision so it can never influence it.
  //
  // Anything unexpected resolves to null inside the resolver, so a milestone can never block
  // this page: the attendee still selects, fills, pays and submits exactly as before.
  const milestoneAlert = resolveMilestoneAlert(
    pass.milestoneAlerts,
    gate.availability?.passCount,
  )

  // ── Event-TOTAL milestone (informational) ───────────────────────────────────
  // `checkRegistrationGate` already read the registration counter to enforce capacity, and
  // `availability.eventTotalCount` is the event-wide confirmed total it derived — so this
  // costs no additional Firestore read. Never a sum of per-pass counts.
  //
  // Resolved AFTER the gate allowed the attendee, exactly like the per-pass alert, and it
  // gates nothing itself. Unlike the per-pass notice this one is INDEPENDENT of the selected
  // pass: the event total does not change when the attendee switches pass in-form, so it
  // stays correct across a switch and needs no re-resolution.
  const eventMilestoneAlert = resolveMilestoneAlert(
    rawPricing?.eventMilestoneAlerts as MilestoneAlert[] | undefined,
    gate.availability?.eventTotalCount,
  )

  // Build form config from the denormalized registrationForm
  const form = event.registrationForm
  let sections: FormSection[] = []
  let conditionalRules: ConditionalRule[] = []

  if (form?.sections?.length) {
    // H-7: hand the FULL section set to the client (all passes' fields); RegisterClient
    // filters per the selected pass + field visibility so the pass can be switched in-form.
    sections         = form.sections
    conditionalRules = (form.conditionalRules ?? []) as ConditionalRule[]
  }

  // Fallback: if no form config, provide minimal name+email fields
  if (sections.length === 0) {
    sections = [{
      id:          'basic',
      title:       'Your Details',
      description: '',
      order:       0,
      fields: [
        {
          id: 'name', label: 'Full Name', type: 'text', required: true,
          visible: true, placeholder: 'Enter your full name', helperText: '',
          options: [], validation: {}, section: 'basic',
          conditionalLogic: null, passVisibility: 'all',
        },
        {
          id: 'email', label: 'Email Address', type: 'email', required: true,
          visible: true, placeholder: 'Enter your email', helperText: '',
          options: [], validation: {}, section: 'basic',
          conditionalLogic: null, passVisibility: 'all',
        },
      ],
    }]
  }

  // Build event summary for the client component header
  const rawSchedule = rawDetails?.schedule as Record<string, unknown> | null
  const startDate   = typeof rawSchedule?.startDate === 'string' ? rawSchedule.startDate : null
  const startTime   = typeof rawSchedule?.startTime === 'string' ? rawSchedule.startTime : null

  const rawMedia  = rawDetails?.media as Record<string, unknown> | null
  // The event builder stores the poster at media.coverBanner.value — the same field the
  // public event page reads (app/events/[slug]/page.tsx). This route only read the legacy
  // media.bannerUrl, so for current events the poster never reached the invite screen or
  // the summary ticket. Read the canonical field first; keep the legacy one as fallback.
  const rawCover  = rawMedia?.coverBanner as Record<string, unknown> | null | undefined
  const bannerUrl = (typeof rawCover?.value === 'string' && rawCover.value.trim())
    || (typeof rawMedia?.bannerUrl === 'string' ? rawMedia.bannerUrl : '')

  const rawVenue    = rawDetails?.venue as Record<string, unknown> | null
  const venueType   = typeof rawVenue?.type === 'string' ? rawVenue.type : 'physical'
  const rawPhysical = rawVenue?.physical as Record<string, unknown> | null
  const rawOnline   = rawVenue?.online   as Record<string, unknown> | null
  const venueName   = venueType === 'online'
    ? (typeof rawOnline?.platform === 'string' ? rawOnline.platform : 'Online')
    : (typeof rawPhysical?.name   === 'string' ? rawPhysical.name   : '')
  const venueCity   = venueType !== 'online'
    ? (typeof rawPhysical?.city   === 'string' ? rawPhysical.city   : '')
    : ''

  // RD-RT3.0: policy URLs for the review step, off the document already fetched above.
  const rawSupport      = rawDetails?.support as Record<string, unknown> | null
  const termsUrl        = typeof rawSupport?.termsUrl === 'string' ? rawSupport.termsUrl : ''
  const refundPolicyUrl = typeof rawSupport?.refundPolicyUrl === 'string' ? rawSupport.refundPolicyUrl : ''

  const regRules = (form as RegistrationFormDraft | null)?.registrationRules

  // Canonical source for approval mode: accessControl.confirmationMode (set in Step 3).
  // Falls back to registrationRules.approvalMode for events published before Step 3
  // was wired to the published document, and as a last resort defaults to 'auto'.
  const ac = event.accessControl as { type?: string; confirmationMode?: string } | null | undefined
  const acConfirmationMode = ac?.confirmationMode
  const approvalMode = (acConfirmationMode === 'manual' || acConfirmationMode === 'auto'
    ? acConfirmationMode
    : regRules?.approvalMode ?? 'auto') as 'auto' | 'manual'

  const requiresInviteCode = ac?.type === 'invite_code'

  // RD-REGISTRATION-UX — public routes have no ToastProvider in any ancestor layout,
  // so the duplicate-registration toast is mounted here, exactly as the success page does.
  return (
    <ToastProvider>
      <RegisterClient
        eventSlug={slug}
        eventName={eventName}
        startDate={startDate}
        startTime={startTime}
        bannerUrl={bannerUrl}
        venueName={venueName}
        venueCity={venueCity}
        venueType={venueType}
        passes={passes.map(p => ({
          id:           p.id,
          name:         p.name,
          price:        p.price,
          regularPrice: p.regularPrice,
          isFree:       p.isFree,
          salesEndDate: p.salesEndDate,
          minAge:       p.minAge,
          maxAge:       p.maxAge,
        }))}
        initialPassId={pass.id}
        milestoneAlert={milestoneAlert}
        eventMilestoneAlert={eventMilestoneAlert}
        sections={sections}
        conditionalRules={conditionalRules}
        approvalMode={approvalMode}
        requireLogin={regRules?.requireLogin ?? false}
        requiresInviteCode={requiresInviteCode}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        // RD-COMMS-WA-CONSENT — offer the WhatsApp-updates opt-in only where WhatsApp is on.
        whatsappUpdatesAvailable={rawPricing?.whatsappEnabled === true}
        // RD-FEE-RESTORE-03 — does THIS event add platform fees to the attendee's charge?
        //
        // Resolved here, on the server, through the SAME function checkout prices with
        // (`explicitFeeModel`) and behind the SAME flag — so the summary's wording and the
        // amount the attendee is actually charged can never come from different rules. A
        // legacy event has no explicit record and resolves to false, exactly as it is charged.
        attendeePaysFees={
          (await resolvePlatformPricing()).features.pricingEngineEnabled
          && explicitFeeModel(rawPricing) === 'customer_pays'
        }
      />
    </ToastProvider>
  )
}
