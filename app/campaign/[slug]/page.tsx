import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import {
  Heart, Shield, Users, Calendar, Target,
  CheckCircle, ExternalLink, ArrowLeft,
} from 'lucide-react'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { Container }      from '@/components/ui/Container'
import { buttonVariants } from '@/components/ui/button'
import { getCampaignBySlug, getCampaignCounter } from '@/lib/firebase/firestore/campaigns'
import { isValidImageUrl, safeImageUrl } from '@/lib/utils/imageUrl'
import { isContentTakenDown } from '@/lib/admin/moderation'
import ReportButton from '@/components/report/ReportButton'
import { ROUTES } from '@/config/navigation'
import {
  DONATION_SUBTYPE_LABELS,
  BENEFICIARY_TYPE_LABELS,
  type DonationCampaignSubtype,
  type BeneficiaryType,
} from '@/lib/campaigns/campaignDetailsConfig'
import { CampaignDetailClient, type ClientDonationSettings } from './CampaignDetailClient'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'

// ─── Config ───────────────────────────────────────────────────────────────────

export const revalidate = 60

// ─── Types ────────────────────────────────────────────────────────────────────

type PageProps = { params: Promise<{ slug: string }> }

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  // Runtime-editable platform identity (this route is already dynamic/ISR).
  const { platformName, baseUrl } = await getBrandingConfig()
  const campaign = await getCampaignBySlug(slug)
  if (!campaign) return { title: `Campaign Not Found – ${platformName}` }

  const cd    = campaign.campaignDetails
  const title = cd.basics.title || 'Fundraising Campaign'
  const desc  = cd.basics.tagline || cd.basics.story.slice(0, 160)
  // Only reference an approved image in social metadata (never a Google thumbnail).
  const image = safeImageUrl(cd.media.coverImageUrl)

  return {
    title:       `${title} – ${platformName}`,
    description: desc,
    openGraph: {
      title,
      description: desc,
      url:         `${baseUrl}/campaign/${slug}`,
      type:        'website',
      ...(image ? { images: [{ url: image, width: 1200, height: 630, alt: title }] } : {}),
    },
    twitter: {
      card:  'summary_large_image',
      title,
      description: desc,
      ...(image ? { images: [image] } : {}),
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRupees(paise: number): string {
  const rupees = Math.floor(paise / 100)
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(1)}Cr`
  if (rupees >= 100_000)    return `₹${(rupees / 100_000).toFixed(1)}L`
  if (rupees >= 1_000)      return `₹${(rupees / 1_000).toFixed(1)}K`
  return `₹${rupees.toLocaleString('en-IN')}`
}

function daysRemaining(endDate: string): number {
  const end  = new Date(endDate + 'T23:59:59')
  const diff = end.getTime() - Date.now()
  return Math.max(0, Math.ceil(diff / (1_000 * 60 * 60 * 24)))
}

function progressPercent(raisedPaise: number, goalRupees: number | null): number {
  if (!goalRupees || goalRupees <= 0) return 0
  return Math.min(100, Math.round((raisedPaise / (goalRupees * 100)) * 100))
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function CampaignPage({ params }: PageProps) {
  const { slug } = await params
  const [campaign, counter] = await Promise.all([
    getCampaignBySlug(slug),
    getCampaignCounter(slug),
  ])

  if (!campaign || campaign.status === 'cancelled') notFound()
  // Admin moderation — a taken-down campaign is not publicly viewable.
  if (isContentTakenDown(campaign.moderationStatus)) notFound()

  const cd = campaign.campaignDetails
  const ds = campaign.donationSettings

  const totalRaisedPaise = counter?.totalRaisedPaise ?? campaign.totalRaisedPaise ?? 0
  const donorCount       = counter?.donorCount       ?? campaign.donorCount       ?? 0
  const goalRupees       = cd.goal.targetAmountRupees
  const days             = daysRemaining(cd.goal.endDate)
  const progress         = progressPercent(totalRaisedPaise, goalRupees)
  const is80G            = cd.taxConfig.enabled

  const subtypeLabel =
    DONATION_SUBTYPE_LABELS[campaign.eventSubtype as DonationCampaignSubtype] ?? ''
  const beneficiaryTypeLabel =
    BENEFICIARY_TYPE_LABELS[cd.beneficiary.type as BeneficiaryType] ?? ''

  // Build a plain-object settings shape (no Firestore types) for the Client Component
  const clientSettings: ClientDonationSettings = ds
    ? {
        suggestedAmountsRupees: ds.amounts.suggestedAmountsRupees,
        allowCustomAmount:      ds.amounts.allowCustomAmount,
        minimumAmountRupees:    ds.amounts.minimumAmountRupees,
        maximumAmountRupees:    ds.amounts.maximumAmountRupees,
        allowAnonymous:         ds.donorExperience.allowAnonymous,
        allowDedications:       ds.donorExperience.allowDedications,
        allowMessages:          ds.donorExperience.allowMessages,
      }
    : {
        suggestedAmountsRupees: [100, 500, 1000, 5000],
        allowCustomAmount:      true,
        minimumAmountRupees:    10,
        maximumAmountRupees:    null,
        allowAnonymous:         true,
        allowDedications:       true,
        allowMessages:          true,
      }

  return (
    <div className="min-h-screen bg-background">
      <MarketingNavbar />

      {/* ── Hero image ───────────────────────────────────────────────────────── */}
      {isValidImageUrl(cd.media.coverImageUrl) ? (
        <div className="relative h-[240px] w-full sm:h-[320px] lg:h-[380px]">
          <Image
            src={cd.media.coverImageUrl}
            alt={cd.basics.title}
            fill
            className="object-cover"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
        </div>
      ) : (
        <div className="h-[120px] w-full bg-gradient-to-br from-orange-50 via-rose-50 to-pink-50 sm:h-[160px]" />
      )}

      {/* ── Body ─────────────────────────────────────────────────────────────── */}
      <Container className="py-6 sm:py-8 lg:py-10">
        {/* Back link */}
        <Link
          href={ROUTES.HOME}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Link>

        <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-10 xl:gap-14">

          {/* ── Left column ───────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-8">

            {/* Title + organizer line */}
            <div>
              {subtypeLabel && (
                <span className="mb-3 inline-block rounded-full bg-orange-100 px-3 py-0.5 text-xs font-medium text-orange-700">
                  {subtypeLabel}
                </span>
              )}
              <h1 className="text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl lg:text-4xl">
                {cd.basics.title}
              </h1>
              {cd.basics.tagline && (
                <p className="mt-2 text-base text-muted-foreground sm:text-lg">{cd.basics.tagline}</p>
              )}
              <p className="mt-3 text-sm text-muted-foreground">
                Fundraiser by{' '}
                <span className="font-medium text-foreground">{cd.organizer.name}</span>
                {cd.beneficiary.name && (
                  <>
                    {' '}for{' '}
                    <span className="font-medium text-foreground">{cd.beneficiary.name}</span>
                  </>
                )}
              </p>
            </div>

            {/* Progress card — mobile only (above the fold) */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-sm lg:hidden">
              <ProgressBlock
                totalRaisedPaise={totalRaisedPaise}
                goalRupees={goalRupees}
                donorCount={donorCount}
                days={days}
                progress={progress}
                showGoal={cd.goal.showGoalAmount}
              />
            </div>

            {/* Mobile donation widget */}
            <div className="lg:hidden">
              <CampaignDetailClient
                settings={clientSettings}
                campaignSlug={slug}
                campaignTitle={cd.basics.title}
              />
            </div>

            {/* Trust badges */}
            <div className="flex flex-wrap gap-3">
              {is80G && (
                <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
                  <Shield className="size-4" aria-hidden />
                  80G Tax Exemption
                </div>
              )}
              <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
                <CheckCircle className="size-4" aria-hidden />
                Verified Campaign
              </div>
              {cd.taxConfig.organizationPan && (
                <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground">
                  PAN: {cd.taxConfig.organizationPan.toUpperCase()}
                </div>
              )}
            </div>

            {/* Campaign Story */}
            {cd.basics.story && (
              <Section title="About this Campaign">
                <div className="leading-relaxed text-sm text-muted-foreground whitespace-pre-wrap">
                  {cd.basics.story}
                </div>
              </Section>
            )}

            {/* Beneficiary & Impact */}
            {(cd.beneficiary.name || cd.beneficiary.description) && (
              <Section title="Who is this for?">
                <div className="rounded-xl bg-muted/50 p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600">
                      <Heart className="size-5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      {cd.beneficiary.name && (
                        <p className="font-semibold text-foreground">{cd.beneficiary.name}</p>
                      )}
                      <p className="text-sm text-muted-foreground">{beneficiaryTypeLabel}</p>
                      {cd.beneficiary.ngoName && (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          via{' '}
                          <span className="font-medium">{cd.beneficiary.ngoName}</span>
                          {cd.beneficiary.ngoRegistrationNo && (
                            <span className="ml-1 text-xs text-muted-foreground/70">
                              (Reg: {cd.beneficiary.ngoRegistrationNo})
                            </span>
                          )}
                        </p>
                      )}
                      {cd.beneficiary.description && (
                        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                          {cd.beneficiary.description}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </Section>
            )}

            {/* 80G Documents */}
            {is80G && cd.taxConfig.certificateUrl && (
              <Section title="Tax Exemption Documents">
                <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
                      <Shield className="size-5" aria-hidden />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">80G Certificate</p>
                      {cd.taxConfig.certificateExpiry && (
                        <p className="text-xs text-muted-foreground">
                          Valid till{' '}
                          {new Date(cd.taxConfig.certificateExpiry).toLocaleDateString('en-IN', {
                            day: 'numeric', month: 'long', year: 'numeric',
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                  <a
                    href={cd.taxConfig.certificateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    View <ExternalLink className="ml-1.5 size-3.5" aria-hidden />
                  </a>
                </div>
              </Section>
            )}

            {/* Organizer */}
            <Section title="Fundraiser Organizer">
              <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
                <div className="flex items-start gap-4">
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted font-bold text-lg text-muted-foreground">
                    {cd.organizer.name.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{cd.organizer.name}</p>
                    <p className="text-sm text-muted-foreground">{cd.organizer.email}</p>
                    {cd.organizer.phone && (
                      <p className="text-sm text-muted-foreground">{cd.organizer.phone}</p>
                    )}
                    {cd.organizer.website && (
                      <a
                        href={cd.organizer.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        {cd.organizer.website.replace(/^https?:\/\//, '')}
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </Section>
          </div>

          {/* ── Right sticky sidebar (desktop only) ───────────────────────────── */}
          <div className="hidden lg:block">
            <div className="sticky top-24 flex flex-col gap-5">
              {/* Progress + stats */}
              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                <ProgressBlock
                  totalRaisedPaise={totalRaisedPaise}
                  goalRupees={goalRupees}
                  donorCount={donorCount}
                  days={days}
                  progress={progress}
                  showGoal={cd.goal.showGoalAmount}
                />
              </div>

              {/* Donation widget */}
              <CampaignDetailClient
                settings={clientSettings}
                campaignSlug={slug}
                campaignTitle={cd.basics.title}
              />
            </div>
          </div>
        </div>
        <div className="py-8 text-center">
          <ReportButton targetType="campaign" targetId={slug} label="Report this campaign" />
        </div>
      </Container>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

interface ProgressBlockProps {
  totalRaisedPaise: number
  goalRupees:       number | null
  donorCount:       number
  days:             number
  progress:         number
  showGoal:         boolean
}

function ProgressBlock({
  totalRaisedPaise, goalRupees, donorCount, days, progress, showGoal,
}: ProgressBlockProps) {
  return (
    <div>
      <p className="text-2xl font-bold text-foreground">
        {formatRupees(totalRaisedPaise)}
        {showGoal && goalRupees && (
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
            raised of ₹{goalRupees.toLocaleString('en-IN')} goal
          </span>
        )}
      </p>

      {showGoal && goalRupees && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-orange-500 transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatItem
          icon={<Users className="size-4" aria-hidden />}
          value={donorCount.toLocaleString('en-IN')}
          label="donors"
        />
        <StatItem
          icon={<Calendar className="size-4" aria-hidden />}
          value={String(days)}
          label={days === 1 ? 'day left' : 'days left'}
        />
        {showGoal && goalRupees && (
          <StatItem
            icon={<Target className="size-4" aria-hidden />}
            value={`${progress}%`}
            label="funded"
          />
        )}
      </div>
    </div>
  )
}

function StatItem({
  icon, value, label,
}: {
  icon:  React.ReactNode
  value: string
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <div>
        <p className="text-base font-semibold leading-tight text-foreground">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}
