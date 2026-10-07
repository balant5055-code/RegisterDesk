import type { Metadata } from 'next'
import Link from 'next/link'
import { Heart, Clock, ArrowRight } from 'lucide-react'
// The public chrome comes from the shared shell, like every other public page. This file
// used to mount MarketingNavbar and MarketingFooter itself — a second copy of a composition
// that already had one home — so /causes drifted whenever that shell changed and had no
// <main> landmark at all. Only the mounts were removed; the hero and the grid are untouched.
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { buildMetadata } from '@/lib/marketing/seo'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { Container }     from '@/components/ui/Container'
import { listCampaigns } from '@/lib/firebase/firestore/campaigns'
import type { CampaignListItem } from '@/lib/firebase/firestore/campaigns'
import { CausesClient }  from './CausesClient'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

// ─── Config ───────────────────────────────────────────────────────────────────

export const revalidate = 60

// ─── Metadata ─────────────────────────────────────────────────────────────────

// Built through the shared helper rather than by hand. The hand-rolled version had a
// title, description, canonical, OG and Twitter block — everything except `images`, so
// this page and /results were the only two public pages sharing to social with NO preview
// image. buildMetadata supplies the site OG image (public/og-image.png), the canonical and
// the robots directive from one place; the social-specific description this page always
// used is layered back on top.
const CAUSES_SOCIAL_DESCRIPTION =
  'Find and donate to active fundraising campaigns from verified organizers.'

const causesBase = buildMetadata({
  title:       'Discover Causes – RegisterDesk',
  description: 'Support fundraising campaigns, medical emergencies, NGO initiatives, disaster relief, and more. Every donation makes a difference.',
  path:        '/causes',
})

export const metadata: Metadata = {
  ...causesBase,
  openGraph: { ...causesBase.openGraph, description: CAUSES_SOCIAL_DESCRIPTION },
  twitter:   { ...causesBase.twitter,   description: CAUSES_SOCIAL_DESCRIPTION },
}

// ─── Index-error detection ────────────────────────────────────────────────────
// Firestore returns FAILED_PRECONDITION (gRPC code 9) while a composite index
// is still building. Detect it by code or by keywords in the message so the
// page degrades gracefully instead of throwing a 500.

function isIndexError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e   = err as Record<string, unknown>
  const code = e.code
  const msg  = String(e.message ?? '').toLowerCase()
  return (
    code === 9 ||
    code === 'failed-precondition' ||
    msg.includes('index') ||
    msg.includes('failed_precondition')
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function CausesPage() {
  let campaigns: CampaignListItem[] = []
  let indexBuilding = false

  try {
    campaigns = await listCampaigns()
  } catch (err: unknown) {
    if (isIndexError(err)) {
      indexBuilding = true
      console.error('[causes] Firestore index unavailable — showing placeholder:', err)
    } else {
      throw err
    }
  }

  // Aggregate stats for the hero (only meaningful when campaigns are loaded)
  const totalRaisedPaise = campaigns.reduce((s, c) => s + c.totalRaisedPaise, 0)
  const totalDonors      = campaigns.reduce((s, c) => s + c.donorCount, 0)

  return (
    <MarketingPageLayout>
      {/* ── Hero ─────────────────────────────────────────────────────────────────
             Editorial, like every other public page since the 2026-09-23 luxury pass: a
             bronze-ruled small-caps label, the display face set light, one sentence, and the
             aggregate stats as a ruled ledger rather than loose pills. */}
      <div className="border-b border-border/60 bg-surface-3/40">
        <Container className="py-12 sm:py-16">
          <div className="flex max-w-3xl flex-col items-start">
            <p className="flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
              <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
              Fundraising Campaigns
            </p>
            <h1 className={`mt-4 ${PAGE_TITLE}`}>
              Discover Causes
            </h1>
            <p className="mt-4 max-w-xl text-fs-md leading-relaxed text-hero-ink-soft">
              Support verified fundraising campaigns — from medical emergencies and disaster relief to NGO initiatives and community projects.
            </p>

            {/* Aggregate stats — hidden when index is building or no data */}
            {!indexBuilding && campaigns.length > 0 && (
              <div className="mt-8 flex flex-wrap divide-x divide-border/70 border-y border-border/70">
                <StatPill
                  value={campaigns.length.toString()}
                  label={campaigns.length === 1 ? 'active cause' : 'active causes'}
                />
                {totalDonors > 0 && (
                  <StatPill
                    value={totalDonors.toLocaleString('en-IN')}
                    label="donors"
                  />
                )}
                {totalRaisedPaise > 0 && (
                  <StatPill
                    value={formatRupees(totalRaisedPaise)}
                    label="raised"
                  />
                )}
              </div>
            )}
          </div>
        </Container>
      </div>

      {/* ── Campaign grid ─────────────────────────────────────────────────────── */}
      <Container className={SECTION_SPACING.default}>
        {indexBuilding ? (
          <QuietState
            icon={Clock}
            title="Campaign directory is updating"
            description="We're preparing the campaign listing. Please check back in a few minutes."
          />
        ) : campaigns.length === 0 ? (
          <QuietState
            icon={Heart}
            title="No active campaigns"
            description="There are no fundraising campaigns live right now. Check back soon — new causes are added regularly."
            action={{ label: 'Browse upcoming events', href: '/events' }}
          />
        ) : (
          <CausesClient campaigns={campaigns} />
        )}
      </Container>
    </MarketingPageLayout>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** One cell of the hero ledger: the figure in the display face, the label in small caps. */
function StatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col px-5 py-3 first:pl-0">
      <span className="font-display text-fs-2xl font-light tabular-nums text-hero-ink leading-none">{value}</span>
      <span className="mt-1.5 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">{label}</span>
    </div>
  )
}

/**
 * The empty and "updating" states, in the page's editorial voice: a bronze-outlined mark,
 * a serif line, one sentence, and (when there is somewhere useful to go) a quiet way on.
 * `/events` is a real route — the discovery front door — so the page is never a dead end.
 */
function QuietState({ icon: Icon, title, description, action }: {
  icon: typeof Heart
  title: string
  description: string
  action?: { label: string; href: string }
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-10 text-center sm:py-16">
      <span aria-hidden className="inline-flex size-14 items-center justify-center rounded-full border border-hero-accent-rule/50 text-hero-accent-rule">
        <Icon className="size-6" strokeWidth={1.5} />
      </span>
      <span aria-hidden className="mt-6 h-px w-8 bg-hero-accent-rule" />
      <h2 className="mt-6 font-display text-fs-2xl font-light text-hero-ink">{title}</h2>
      <p className="mt-3 text-fs-base leading-relaxed text-hero-ink-soft">{description}</p>
      {action && (
        <Link
          href={action.href}
          className="group mt-6 inline-flex items-center gap-2 text-fs-xs font-semibold uppercase tracking-[0.16em] text-action underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
        >
          {action.label}
          <ArrowRight aria-hidden className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </Link>
      )}
    </div>
  )
}

function formatRupees(paise: number): string {
  const rupees = Math.floor(paise / 100)
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(1)}Cr`
  if (rupees >= 100_000)    return `₹${(rupees / 100_000).toFixed(1)}L`
  if (rupees >= 1_000)      return `₹${(rupees / 1_000).toFixed(1)}K`
  return `₹${rupees.toLocaleString('en-IN')}`
}
