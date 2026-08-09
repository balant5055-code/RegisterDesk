'use client'

// RD-EVENT-26 · Enterprise Review Summary.
//
// ═══ PRESENTATION ONLY ═══════════════════════════════════════════════════════
// Reads the draft that Step 7 already receives and renders it. It computes no readiness,
// no validity and no publishability — the Publish card reads `report`, which comes from the
// shared engine.
//
// Navigation reuses `indexOfStep()` from the step registry, so a section's Edit button
// resolves the same index the wizard navigates by. There is no switch on section name and
// no hardcoded step number: inserting 'Fundraising' shifts the indices and this follows.

import { Pencil } from 'lucide-react'
import { indexOfStep, type WizardFlow } from '@/lib/events/builder/stepRegistry'
import { formatINR } from '@/lib/events/builder/format'
import type { ReadinessReport } from '@/lib/events/builder/types'

/** How an absent value reads. ONE component, so "not set" never drifts across the panel. */
function Value({ children, missing }: { children?: React.ReactNode; missing?: string }) {
  const empty =
    children === null || children === undefined || children === '' ||
    (typeof children === 'string' && children.trim().length === 0)
  if (empty) {
    return <span className="text-[13px] italic text-muted-foreground/70">{missing ?? 'Not provided'}</span>
  }
  return <span className="text-[13px] font-medium text-foreground">{children}</span>
}

function Row({ label, children, missing }: { label: string; children?: React.ReactNode; missing?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right"><Value missing={missing}>{children}</Value></dd>
    </div>
  )
}

interface CardProps {
  title: string
  /** Stable step id from the registry — never an index. */
  stepId?: string
  flow: WizardFlow
  onGoToStep?: (step: number, fieldHint?: string) => void
  children: React.ReactNode
}

function Card({ title, stepId, flow, onGoToStep, children }: CardProps) {
  const index = stepId ? indexOfStep(flow, stepId) : -1
  const canEdit = index >= 0 && !!onGoToStep
  const headingId = `summary-${title.toLowerCase().replace(/\s+/g, '-')}`

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-border/60 pb-2">
        <h3 id={headingId} className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {canEdit && (
          <button
            type="button"
            onClick={() => onGoToStep!(index)}
            className="inline-flex items-center gap-1 rounded-md text-[12.5px] font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <Pencil className="size-3" aria-hidden />
            Edit
            {/* Every card has an "Edit" — without this they are indistinguishable aloud. */}
            <span className="sr-only"> {title}</span>
          </button>
        )}
      </div>
      <dl className="divide-y divide-border/40">{children}</dl>
    </section>
  )
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export interface ReviewSummaryProps {
  data: Record<string, unknown> | null
  report: ReadinessReport
  flow: WizardFlow
  onGoToStep?: (step: number, fieldHint?: string) => void
}

export function ReviewSummary({ data, report, flow, onGoToStep }: ReviewSummaryProps) {
  const details   = rec(data?.eventDetails)
  const info      = rec(details?.info)
  const schedule  = rec(details?.schedule)
  const venue     = rec(details?.venue)
  const physical  = rec(venue?.physical)
  const organizer = rec(details?.organizer)
  const pricing   = rec(data?.pricing)
  const access    = rec(data?.accessControl)
  const form      = rec(data?.registrationForm)

  const passes = Array.isArray(pricing?.passes) ? (pricing!.passes as Record<string, unknown>[]) : []
  const prices = passes.map(p => Number(p.price ?? 0)).filter(n => Number.isFinite(n))
  const priceRange = prices.length
    ? (Math.min(...prices) === Math.max(...prices)
        ? formatINR(Math.min(...prices))
        : `${formatINR(Math.min(...prices))} – ${formatINR(Math.max(...prices))}`)
    : ''
  // Capacity: unlimited passes make the total unbounded, which is information, not a blank.
  const anyUnlimited = passes.some(p => p.unlimited === true || p.quantity === null)
  const capacity = passes.length === 0 ? ''
    : anyUnlimited ? 'Unlimited'
    : passes.reduce((n, p) => n + (Number(p.quantity) || 0), 0).toLocaleString('en-IN')

  const card = (title: string, stepId: string | undefined, children: React.ReactNode) => (
    <Card title={title} stepId={stepId} flow={flow} onGoToStep={onGoToStep}>{children}</Card>
  )

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
      {card('Event', 'eventType', <>
        <Row label="Name">{str(info?.name)}</Row>
        <Row label="Category">{str(data?.eventType as string)}</Row>
        <Row label="Format">{str(data?.eventSubtype as string)}</Row>
        <Row label="Visibility" missing="Not selected">{str(data?.visibility as string)}</Row>
        <Row label="Status">{str(data?.status as string) || 'draft'}</Row>
      </>)}

      {card('Schedule', 'details', <>
        <Row label="Starts" missing="Not scheduled">{str(schedule?.startDate)}</Row>
        <Row label="Ends" missing="Not scheduled">{str(schedule?.endDate)}</Row>
        <Row label="Registration opens">{str(pricing?.registrationOpenDate)}</Row>
        <Row label="Registration closes">{str(pricing?.registrationEndDate)}</Row>
        <Row label="Timezone">{str(schedule?.timezone)}</Row>
      </>)}

      {card('Registration', 'form', <>
        <Row label="Type" missing="Not selected">{str(pricing?.eventType)}</Row>
        <Row label="Form">{str(form?.template)}</Row>
        <Row label="Capacity" missing="No passes">{capacity}</Row>
        <Row label="Access" missing="Not selected">{str(access?.type)}</Row>
        <Row label="Approval">{str(access?.confirmationMode)}</Row>
      </>)}

      {card('Pricing', 'pricing', <>
        <Row label="Model" missing="Not selected">{str(pricing?.eventType)}</Row>
        <Row label="Passes" missing="None created">{passes.length ? String(passes.length) : ''}</Row>
        <Row label="Price range" missing="No passes">{priceRange}</Row>
        <Row label="Currency">INR</Row>
      </>)}

      {card('Location', 'details', <>
        <Row label="Type" missing="Not configured">{str(venue?.type)}</Row>
        <Row label="Venue">{str(physical?.name)}</Row>
        <Row label="Address">{str(physical?.address)}</Row>
        <Row label="City">{str(physical?.city)}</Row>
        <Row label="State">{str(physical?.state)}</Row>
      </>)}

      {card('Organiser', 'details', <>
        <Row label="Organisation">{str(organizer?.name)}</Row>
        <Row label="Email">{str(organizer?.email)}</Row>
        <Row label="Phone">{str(organizer?.phone)}</Row>
        <Row label="Website">{str(organizer?.website)}</Row>
        <Row label="License">{str(data?.licenseTier as string)}</Row>
      </>)}

      {/* Publish reads the SHARED report — never a second readiness calculation. */}
      {card('Publish', undefined, <>
        <Row label="Status">{report.canPublish ? 'Ready to publish' : 'Blocked'}</Row>
        <Row label="Readiness">{`${report.score} / 100`}</Row>
        <Row label="Critical">{String(report.findings.critical.length)}</Row>
        <Row label="Warnings">{String(report.findings.warning.length)}</Row>
        <Row label="Suggestions">{String(report.findings.suggestion.length)}</Row>
      </>)}
    </div>
  )
}
