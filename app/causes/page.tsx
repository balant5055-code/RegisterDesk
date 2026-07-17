import type { Metadata } from 'next'
import { Heart, Clock } from 'lucide-react'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/footer/MarketingFooter'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { Container }     from '@/components/ui/Container'
import { EmptyState }    from '@/components/ui'
import { listCampaigns } from '@/lib/firebase/firestore/campaigns'
import type { CampaignListItem } from '@/lib/firebase/firestore/campaigns'
import { CausesClient }  from './CausesClient'

// ─── Config ───────────────────────────────────────────────────────────────────

export const revalidate = 60

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

// ─── Metadata ─────────────────────────────────────────────────────────────────

export const metadata: Metadata = {
  title:       'Discover Causes – RegisterDesk',
  description: 'Support fundraising campaigns, medical emergencies, NGO initiatives, disaster relief, and more. Every donation makes a difference.',
  openGraph: {
    title:       'Discover Causes – RegisterDesk',
    description: 'Find and donate to active fundraising campaigns from verified organizers.',
    url:         `${BASE_URL}/causes`,
    type:        'website',
  },
  twitter: {
    card:        'summary_large_image',
    title:       'Discover Causes – RegisterDesk',
    description: 'Find and donate to active fundraising campaigns from verified organizers.',
  },
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
    <div className="min-h-screen bg-background">
      <MarketingNavbar />

      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <div className="border-b border-border bg-gradient-to-b from-primary/5 to-background">
        <Container className="py-10 sm:py-14">
          <div className="flex flex-col items-start gap-2">
            <Eyebrow>Fundraising Campaigns</Eyebrow>
            <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
              Discover Causes
            </h1>
            <p className="mt-1 max-w-xl text-base text-muted-foreground sm:text-lg">
              Support verified fundraising campaigns — from medical emergencies and disaster relief to NGO initiatives and community projects.
            </p>

            {/* Aggregate stats — hidden when index is building or no data */}
            {!indexBuilding && campaigns.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center gap-5">
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
          <EmptyState
            icon={Clock}
            title="Campaign directory is updating"
            description="We're preparing the campaign listing. Please check back in a few minutes."
            size="lg"
          />
        ) : campaigns.length === 0 ? (
          <EmptyState
            icon={Heart}
            title="No active campaigns"
            description="There are no fundraising campaigns live right now. Check back soon — new causes are added regularly."
            size="lg"
          />
        ) : (
          <CausesClient campaigns={campaigns} />
        )}
      </Container>

      <MarketingFooter />
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xl font-bold text-foreground">{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
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
