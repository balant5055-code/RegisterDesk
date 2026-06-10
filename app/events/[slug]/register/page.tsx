// /events/[slug]/register
//
// Server component — all sensitive data loaded server-side.
// Never trusts passId or any other query parameter for pricing.
// Gate check runs here; blocked states are rendered without round-tripping to client.

import { notFound }            from 'next/navigation'
import Link                    from 'next/link'
import { getEventBySlug }      from '@/lib/firebase/firestore/events'
import { checkRegistrationGate, GATE_REASON_LABELS } from '@/lib/registrations/gate'
import { RegisterClient }      from './RegisterClient'
import type {
  FormSection,
  ConditionalRule,
  RegistrationFormDraft,
} from '@/components/wizard/registrationFormConfig'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PassPublic {
  id:           string
  name:         string
  price:        number
  isFree:       boolean
  unlimited:    boolean
  quantity:     number | null
  status:       string
  description?: string
}

// ─── Pass extraction ──────────────────────────────────────────────────────────

function extractPasses(pricing: Record<string, unknown> | null): PassPublic[] {
  if (!pricing) return []
  const raw = Array.isArray(pricing.passes) ? pricing.passes as Record<string, unknown>[] : []
  return raw
    .filter(p => p.status === 'active')
    .map(p => ({
      id:          String(p.id ?? ''),
      name:        String(p.name ?? 'Pass'),
      price:       typeof p.price === 'number' ? p.price : 0,
      isFree:      p.price === 0 || p.isFree === true,
      unlimited:   p.unlimited === true,
      quantity:    typeof p.quantity === 'number' ? p.quantity : null,
      status:      String(p.status ?? 'active'),
      description: typeof p.description === 'string' ? p.description : undefined,
    }))
}

function filterFieldsForPass(form: RegistrationFormDraft, passId: string): FormSection[] {
  return form.sections.map(section => ({
    ...section,
    fields: section.fields.filter(field => {
      if (!field.visible) return false
      if (field.passVisibility === 'all') return true
      return Array.isArray(field.passVisibility) && field.passVisibility.includes(passId)
    }),
  })).filter(s => s.fields.length > 0)
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
      <h1 className="text-[20px] font-bold text-foreground">Registration Unavailable</h1>
      <p className="mt-2 max-w-sm text-[14px] text-muted-foreground">{label}</p>
      <Link
        href={`/events/${eventSlug}`}
        className="mt-6 rounded-xl bg-primary px-6 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
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
        <p className="text-[12px] font-semibold uppercase tracking-wider text-primary">Register for</p>
        <h1 className="mt-1 text-[22px] font-bold text-foreground">{eventName}</h1>
        <p className="mt-1 text-[14px] text-muted-foreground">Select a pass to continue</p>
      </div>

      <div className="flex flex-col gap-3">
        {passes.map(pass => (
          <Link
            key={pass.id}
            href={`/events/${eventSlug}/register?passId=${pass.id}`}
            className="group flex items-center justify-between rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
          >
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">{pass.name}</p>
              {pass.description && (
                <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{pass.description}</p>
              )}
              {!pass.unlimited && pass.quantity !== null && (
                <p className="mt-1 text-[11.5px] text-muted-foreground">{pass.quantity} seats</p>
              )}
            </div>
            <div className="ml-4 shrink-0 text-right">
              <p className="text-[15px] font-bold text-foreground">
                {pass.isFree || pass.price === 0
                  ? 'Free'
                  : `₹${pass.price.toLocaleString('en-IN')}`}
              </p>
              <p className="mt-0.5 text-[11px] text-primary opacity-0 transition-opacity group-hover:opacity-100">
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
    sections         = filterFieldsForPass(form, passId)
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

  const regRules = (form as RegistrationFormDraft | null)?.registrationRules

  return (
    <RegisterClient
      eventSlug={slug}
      eventName={eventName}
      startDate={startDate}
      pass={{
        id:    pass.id,
        name:  pass.name,
        price: pass.price,
        isFree: pass.isFree,
      }}
      sections={sections}
      conditionalRules={conditionalRules}
      approvalMode={regRules?.approvalMode ?? 'auto'}
      requireLogin={regRules?.requireLogin ?? false}
    />
  )
}
