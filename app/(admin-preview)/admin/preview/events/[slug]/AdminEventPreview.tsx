'use client'

// The Super Admin pre-approval preview: the REAL public template (TemplateRouter) fed the
// props GET /api/admin/events/[slug]/preview builds with the public page's own mapping.
//
// Side-effect free by construction:
//   • every link and form submission inside the rendered page is intercepted (capture phase)
//     — registration, applications, nominations and campaign links go nowhere from here;
//   • and independently, every such endpoint refuses a non-public event server-side (the
//     registration gate, the nomination route, the speaker/sponsor apply routes, and the
//     linked-campaign gate on donation orders), so the interception is courtesy, not security.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/components/auth/AuthProvider'
import { TemplateRouter } from '@/components/event-templates/TemplateRouter'
import { ROUTES } from '@/config/navigation'
import type { AdminEventPreviewResponse } from '@/app/api/admin/events/[slug]/preview/route'

type State =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AdminEventPreviewResponse }

const STATUS_LABEL: Record<string, string> = {
  pending_review:    'Pending review',
  changes_requested: 'Changes requested',
  draft:             'Draft / rejected',
  unpublished:       'Unpublished',
  published:         'Published',
}

export function AdminEventPreview({ slug }: { slug: string }) {
  const { user, getToken } = useAuth()
  const [fetched, setState] = useState<State>({ kind: 'loading' })
  const [blocked, setBlocked] = useState(false)
  // Signed-out is derived from auth, not stored — the effect below only runs the fetch.
  const state: State = user === null ? { kind: 'signed_out' } : fetched

  useEffect(() => {
    if (!user) return
    let alive = true
    void (async () => {
      try {
        const token = await getToken()
        const res = await fetch(`/api/admin/events/${encodeURIComponent(slug)}/preview`, {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (!alive) return
        if (res.status === 403) { setState({ kind: 'error', message: 'Super Admin access is required to preview events.' }); return }
        if (res.status === 404) { setState({ kind: 'error', message: 'Event not found.' }); return }
        if (!res.ok) { setState({ kind: 'error', message: `Preview failed (${res.status}).` }); return }
        setState({ kind: 'ready', data: await res.json() as AdminEventPreviewResponse })
      } catch {
        if (alive) setState({ kind: 'error', message: 'Preview failed to load.' })
      }
    })()
    return () => { alive = false }
  }, [user, getToken, slug])

  // Capture-phase: runs before any template handler, so nothing inside navigates or submits.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[href]')
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) return        // in-page anchors (FAQ, sections) keep working
    e.preventDefault(); e.stopPropagation(); setBlocked(true)
  }, [])
  const onSubmitCapture = useCallback((e: React.FormEvent) => {
    e.preventDefault(); e.stopPropagation(); setBlocked(true)
  }, [])

  if (state.kind !== 'ready') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
        <div className="max-w-md space-y-3">
          <p className="text-[15px] font-semibold text-foreground">
            {state.kind === 'loading' ? 'Loading preview…'
              : state.kind === 'signed_out' ? 'Sign in as a Super Admin to preview this event.'
              : state.message}
          </p>
          {state.kind === 'signed_out' && <Link href={ROUTES.ADMIN_LOGIN} className="text-[13px] font-semibold text-primary underline">Admin sign in</Link>}
          {state.kind === 'error' && <Link href={ROUTES.ADMIN_EVENT_APPROVALS} className="text-[13px] font-semibold text-primary underline">Back to approvals</Link>}
        </div>
      </div>
    )
  }

  const { data } = state
  return (
    <div data-admin-preview="true">
      {/* Admin preview bar — outside the intercepted region, so its own links work. FIXED and on
          the topmost layer: the templates' own site header is fixed too, and a sticky bar was
          measured hidden underneath it — the one thing that must never be missed here. */}
      <div role="status" className="fixed inset-x-0 top-0 z-[2147483647] flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b-2 border-amber-400 bg-amber-100 px-4 py-2 text-[12.5px] text-amber-950 shadow-md">
        <span>
          <strong>Admin preview — not public.</strong>{' '}
          Stored status: {STATUS_LABEL[data.lifecycleStatus] ?? data.lifecycleStatus}. Shown as it will appear once approved.
          Links, registration and donations are disabled here.
        </span>
        <span className="flex flex-wrap gap-3">
          <a href="#review-appendix" className={data.review.warnings.length ? 'font-bold text-red-700 underline' : 'font-semibold underline'}>
            {data.review.warnings.length ? `⚠ ${data.review.warnings.length} warning${data.review.warnings.length === 1 ? '' : 's'} — review details` : 'Review details ↓'}
          </a>
          <Link href={`/admin/events/${encodeURIComponent(data.slug)}`} className="font-semibold underline">Event 360</Link>
          <Link href={ROUTES.ADMIN_EVENT_APPROVALS} className="font-semibold underline">Back to approvals</Link>
        </span>
      </div>
      {blocked && (
        <div role="alert" className="fixed bottom-4 left-1/2 z-[2147483647] -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-[12.5px] text-background shadow-lg">
          Disabled in admin preview.{' '}
          <button type="button" className="underline" onClick={() => setBlocked(false)}>Dismiss</button>
        </div>
      )}

      <div onClickCapture={onClickCapture} onSubmitCapture={onSubmitCapture}>
        <TemplateRouter {...data.props} />
      </div>

      <ReviewAppendix review={data.review} />
    </div>
  )
}

// ─── Review appendix ──────────────────────────────────────────────────────────
// Internal configuration the public page does not show. Every row distinguishes what server code
// ENFORCES from what is only configured or displayed — a stored setting is not a guarantee.

type Review = AdminEventPreviewResponse['review']
type PreviewPass = Review['passes'][number]
type Fees = NonNullable<PreviewPass['fees']>

const inr = (paise: number | null | undefined) =>
  typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}` : '—'
const yesNo = (b: boolean) => (b ? 'Yes' : 'No')

const ENFORCEMENT_LABEL: Record<string, { text: string; cls: string }> = {
  enforced:          { text: 'Enforced',              cls: 'bg-emerald-100 text-emerald-800' },
  configured_only:   { text: 'Not enforced',          cls: 'bg-amber-200 text-amber-900' },
  platform_disabled: { text: 'Feature off platform-wide', cls: 'bg-slate-200 text-slate-800' },
}

function Badge({ kind }: { kind: string }) {
  const b = ENFORCEMENT_LABEL[kind] ?? ENFORCEMENT_LABEL.configured_only
  return <span className={`ml-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${b.cls}`}>{b.text}</span>
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3">
      <h3 className="mb-2 text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function FeeLine({ label, f }: { label: string; f: Fees | null }) {
  if (!f) return null
  return (
    <div className="text-[12px] text-muted-foreground">
      {label}: attendee pays <strong className="text-foreground">{inr(f.attendeePaysPaise)}</strong>
      {' · '}platform fee (incl. GST) {inr(f.platformFeePaise)} · gateway (est.) {inr(f.gatewayFeeEstimatePaise)}
      {' · '}organizer net (est.) <strong className="text-foreground">{inr(f.organizerNetPaise)}</strong>
    </div>
  )
}

function PassCard({ p }: { p: PreviewPass }) {
  const stateTags = [
    p.status === 'inactive' ? 'INACTIVE' : null,
    !p.publiclyListed && p.status !== 'inactive' ? `HIDDEN (${p.visibility})` : null,
    p.type === 'complimentary' || p.type === 'invite_only' ? p.type.toUpperCase() : null,
    p.saleState === 'ended' ? 'SALES ENDED' : p.saleState === 'scheduled' ? 'SALES NOT STARTED' : null,
  ].filter(Boolean) as string[]
  return (
    <li className="rounded-md border border-border p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{p.name}{p.code ? <span className="ml-1 text-muted-foreground">[{p.code}]</span> : null}</span>
        <span className="font-semibold">{p.isFree ? 'Free' : inr(p.pricePaise)} <span className="text-[11px] font-normal text-muted-foreground">{p.currency}</span></span>
      </div>
      {stateTags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{stateTags.map(t => <span key={t} className="rounded bg-red-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-red-800">{t}</span>)}</div>}
      {p.description && <p className="mt-1 text-[12px] text-muted-foreground">{p.description}</p>}
      <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
        <div>Type: {p.type}</div>
        <div>Status / visibility: {p.status} · {p.visibility}</div>
        <div>Quantity: {p.unlimited ? 'Unlimited' : (p.quantity ?? '—')}<Badge kind="enforced" /></div>
        <div>Sales window: {p.salesStartDate ?? 'open'} → {p.salesEndDate ?? 'no end'} ({p.saleState})<Badge kind="enforced" /></div>
        <div>Per order: min {p.minPurchase ?? '—'} · max {p.maxPurchase ?? '—'}<Badge kind="configured_only" /></div>
        <div>Early bird: {p.earlyBird.enabled ? `${inr(p.earlyBird.pricePaise)} until ${p.earlyBird.endDate ?? '—'}` : 'Off'}{p.earlyBird.enabled ? <Badge kind="enforced" /> : null}</div>
        <div>Hide when sold out: {yesNo(p.hideWhenSoldOut)} · Show remaining: {yesNo(p.showRemainingSeats)} · Featured: {yesNo(p.featured)}</div>
        {p.raceDetails && (
          <div>Race: {p.raceDetails.category ?? '—'} · age {p.raceDetails.minAge ?? '—'}–{p.raceDetails.maxAge ?? '—'}<Badge kind="enforced" />{p.raceDetails.teamSize ? ` · team of ${p.raceDetails.teamSize}` : ''}</div>
        )}
        <div className="sm:col-span-2">
          Transferable {yesNo(p.flags.transferable)} · Refundable {yesNo(p.flags.refundable)} · Waitlist {yesNo(p.flags.waitlist)} · Group booking {yesNo(p.flags.groupBooking)}
          <Badge kind="configured_only" />
          <span className="ml-1 text-muted-foreground">(may be shown to attendees as promises; no server rule acts on them)</span>
        </div>
        {p.benefits.length > 0 && <div className="sm:col-span-2">Benefits: {p.benefits.join(', ')}</div>}
      </dl>
      <FeeLine label="At regular price" f={p.fees} />
      <FeeLine label="At early-bird price" f={p.earlyBirdFees} />
    </li>
  )
}

function ReviewAppendix({ review }: { review: Review }) {
  const { pricing, access } = review
  return (
    <section id="review-appendix" aria-label="Internal configuration not shown on the public page" className="scroll-mt-16 border-t-4 border-amber-400 bg-amber-50 px-4 py-6 text-[13px] text-foreground">
      <div className="mx-auto max-w-5xl space-y-3">
        <h2 className="text-[15px] font-bold">Internal configuration — admin review only, not on the public page</h2>
        <p className="text-[12px] text-muted-foreground">Everything above this line is the public page exactly as it will appear once approved. Everything below is stored configuration for review.</p>

        <Block title={`Warnings (${review.warnings.length})`}>
          {review.warnings.length === 0
            ? <p className="text-[12px] text-muted-foreground">The existing publish checks pass on the content approval would publish.</p>
            : <ul className="space-y-1">{review.warnings.map(w => <li key={w.id} className="text-[12px]"><strong className="text-red-700">{w.title}</strong> — {w.message}</li>)}</ul>}
          <p className="mt-1 text-[11px] text-muted-foreground">Warnings do not block approval.</p>
        </Block>

        <Block title="Payments & fees">
          <dl className="grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
            <div>Event pricing: <strong>{pricing.model}</strong> ({pricing.currency})</div>
            <div>Registration window: {pricing.registrationOpenDate ?? 'open now'} → {pricing.registrationEndDate ?? 'no end'}<Badge kind="enforced" /></div>
            <div className="sm:col-span-2">Fee collection applied: <strong>{pricing.feeCollection.applied}</strong>
              {pricing.feeCollection.storedValue ? <span className="text-muted-foreground"> · stored value “{pricing.feeCollection.storedValue}” is not used for charging</span> : null}</div>
            <div className="sm:col-span-2 text-muted-foreground">
              {pricing.feeCollection.feesAvailable
                ? `Per-ticket amounts below are estimates at this event's current ${pricing.feeCollection.termsSource === 'event' ? 'event-specific' : 'global'} fee terms; the terms in force lock at each checkout.`
                : 'Fee terms could not be resolved right now — per-ticket amounts are unavailable.'}
            </div>
          </dl>
        </Block>

        <Block title={`Tickets / passes (${review.passes.length}, including hidden and inactive)`}>
          {review.passes.length === 0 ? <p className="text-[12px] text-muted-foreground">No tickets configured.</p> : (
            <ul className="space-y-2">{review.passes.map((p, i) => <PassCard key={i} p={p} />)}</ul>
          )}
        </Block>

        <Block title="Access & registration rules">
          <dl className="grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
            <div>Visibility: {review.visibility ?? 'public'}</div>
            <div>Access: <strong>{access.mode.replace('_', ' ')}</strong><Badge kind="enforced" />
              {access.mode === 'invite_code' ? ` · code ${access.inviteCodeConfigured ? 'set' : 'MISSING'}` : ''}
              {access.mode === 'approved_contacts' ? ` · ${access.approvedContactCount} contacts (${access.approvedContactsWithEmail} with a verifiable email; registrants must verify that email)` : ''}
            </div>
            {review.registrationRules.map(r => <div key={r.label}>{r.label}: {r.value}<Badge kind={r.enforcement} /></div>)}
          </dl>
        </Block>

        <Block title={`Registration form fields (${review.registrationFields.length})`}>
          {review.registrationFields.length === 0 ? <p className="text-[12px] text-muted-foreground">No custom fields configured.</p> : (
            <ul className="space-y-0.5 text-[12px]">
              {review.registrationFields.map((f, i) => (
                <li key={i}>
                  {f.section ? <span className="text-muted-foreground">{f.section} · </span> : null}
                  <span className="font-medium">{f.label}</span>{' '}
                  <span className="text-muted-foreground">({f.type}{f.required ? ', required' : ', optional'}{f.perTicket ? ', some tickets only' : ''}{f.conditional ? ', conditional' : ''}{f.options.length ? `: ${f.options.join(', ')}` : ''})</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title="Search & sharing (SEO)">
          <dl className="space-y-0.5 text-[12px]">
            <div>URL: /events/{review.seo.urlSlug ?? '—'}</div>
            <div>Meta title: {review.seo.metaTitle ?? <span className="text-muted-foreground">(event name)</span>}</div>
            <div>Meta description: {review.seo.metaDescription ?? <span className="text-muted-foreground">(short description)</span>}</div>
            <div>Keywords: {review.seo.keywords.length ? review.seo.keywords.join(', ') : '—'}</div>
          </dl>
        </Block>

        {review.campaign && (
          <Block title="Linked fundraising campaign">
            <dl className="grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
              <div>Title: {review.campaign.title}</div>
              <div>Goal: {review.campaign.goalRupees !== null ? `₹${review.campaign.goalRupees.toLocaleString('en-IN')}` : '—'} · ends {review.campaign.endDate ?? '—'}</div>
              <div>Donation amounts: min ₹{review.campaign.minimumRupees ?? '—'} · max {review.campaign.maximumRupees !== null ? `₹${review.campaign.maximumRupees}` : 'none'}</div>
              <div>Beneficiary: {review.campaign.beneficiaryName ?? '—'} ({review.campaign.beneficiaryType ?? '—'})</div>
              <div>80G tax deduction: {yesNo(review.campaign.taxDeduction80G)} · Over-funding allowed: {yesNo(review.campaign.allowOverFunding)}</div>
              <div className="text-muted-foreground">Accepts donations only once this event is approved and public.</div>
            </dl>
          </Block>
        )}
      </div>
    </section>
  )
}
