// /events/[slug]/register
//
// Server component — all sensitive data loaded server-side.
// Never trusts passId or any other query parameter for pricing.
// Gate check runs here; blocked states are rendered without round-tripping to client.

import { notFound }            from 'next/navigation'
import Link                    from 'next/link'
import { getEventBySlug }      from '@/lib/firebase/firestore/events'
import { resolveEffectivePriceRupees } from '@/lib/pricing/earlyBird'
import { checkRegistrationGate, GATE_REASON_LABELS } from '@/lib/registrations/gate'
import { buildRegisterHref }   from '@/lib/events/registerHref'
import type { Metadata }       from 'next'
import { buildMetadata }       from '@/lib/marketing/seo'
import { RegisterClient }      from './RegisterClient'
import { PassPrice }          from './PassPrice'
import { ageRangeLabel }      from '@/lib/registrations/ageEligibility'
import { WaitlistJoinClient }  from './WaitlistJoinClient'
import type {
  FormSection,
  ConditionalRule,
  RegistrationFormDraft,
} from '@/components/wizard/registrationFormConfig'

// RD-LAUNCH-07 — registration links are shared constantly (WhatsApp, Slack, DMs) and
// previously produced a preview with no title, description or image at all. Built from
// the event the page already loads, so no extra read is introduced.
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params
  const event = await getEventBySlug(slug)
  const name  = typeof (event?.eventDetails as { info?: { name?: string } } | null)?.info?.name === 'string'
    ? (event!.eventDetails as { info: { name: string } }).info.name
    : 'Event'
  return buildMetadata({
    title:       `Register — ${name} | RegisterDesk`,
    description: `Complete your registration for ${name}.`,
    path:        `/events/${slug}/register`,
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
}

// ─── Pass extraction ──────────────────────────────────────────────────────────

function extractPasses(pricing: Record<string, unknown> | null): PassPublic[] {
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
        ...(() => {
          const rd = p.raceDetails as Record<string, unknown> | null | undefined
          return {
            minAge: typeof rd?.minAge === 'number' ? rd.minAge : null,
            maxAge: typeof rd?.maxAge === 'number' ? rd.maxAge : null,
          }
        })(),
      }
    })
}

// ─── Blocked state UI ─────────────────────────────────────────────────────────

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
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50">
        <svg className="size-7 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      </div>
      <h1 className="text-fs-lg font-bold text-foreground">Registration Unavailable</h1>
      <p className="mt-2 max-w-sm text-fs-base text-muted-foreground">{label}</p>
      <Link
        href={`/events/${eventSlug}`}
        className="mt-6 rounded-xl bg-primary px-6 py-2.5 text-fs-sm font-semibold text-primary-foreground hover:opacity-90"
      >
        Back to Event
      </Link>
    </div>
  )
}

// ─── Pass selection UI (no passId in query) ───────────────────────────────────

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
    <div className="mx-auto max-w-lg px-4 py-12">
      <div className="mb-8 text-center">
        <p className="text-fs-xs font-semibold uppercase tracking-wider text-primary">Register for</p>
        <h1 className="mt-1 text-fs-xl font-bold text-foreground">{eventName}</h1>
        <p className="mt-1 text-fs-base text-muted-foreground">Select a pass to continue</p>
      </div>

      <div className="flex flex-col gap-3">
        {passes.map(pass => (
          <Link
            key={pass.id}
            href={buildRegisterHref(eventSlug, pass.id)}
            className="group flex items-center justify-between rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
          >
            <div className="min-w-0">
              <p className="text-fs-base font-semibold text-foreground">{pass.name}</p>
              {pass.description && (
                <p className="mt-0.5 truncate text-fs-xs text-muted-foreground">{pass.description}</p>
              )}
              {!pass.unlimited && pass.quantity !== null && (
                <p className="mt-1 text-fs-2xs text-muted-foreground">{pass.quantity} seats</p>
              )}
              {/* RD-RT3.2.3: eligibility at the FIRST place a pass is chosen, so an
                  age problem is visible before any form is filled in. */}
              {ageRangeLabel({ minAge: pass.minAge ?? null, maxAge: pass.maxAge ?? null }) && (
                <p className="mt-1 text-fs-2xs font-medium text-muted-foreground">
                  Age {ageRangeLabel({ minAge: pass.minAge ?? null, maxAge: pass.maxAge ?? null })}
                </p>
              )}
            </div>
            <div className="ml-4 shrink-0 text-right">
              {/* RD-RT3.2.2: the picker printed a bare price, hiding an active
                  early-bird discount at the very first place it is shown. */}
              <PassPrice price={pass.price} regularPrice={pass.regularPrice} isFree={pass.isFree} />
              <p className="mt-0.5 text-fs-2xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
                Select →
              </p>
            </div>
          </Link>
        ))}
      </div>
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

  const event = await getEventBySlug(slug)
  if (!event) notFound()

  const rawDetails  = event.eventDetails as Record<string, unknown>
  const rawInfo     = rawDetails?.info as Record<string, unknown> | null
  const eventName   = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'
  const rawPricing  = event.pricing as Record<string, unknown> | null
  const passes      = extractPasses(rawPricing)

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
  const bannerUrl = typeof rawMedia?.bannerUrl === 'string' ? rawMedia.bannerUrl : ''

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

  return (
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
      sections={sections}
      conditionalRules={conditionalRules}
      approvalMode={approvalMode}
      requireLogin={regRules?.requireLogin ?? false}
      requiresInviteCode={requiresInviteCode}
      termsUrl={termsUrl}
      refundPolicyUrl={refundPolicyUrl}
    />
  )
}
