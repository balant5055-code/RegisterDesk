'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Calendar, MapPin, Globe, Clock, ExternalLink, Link2,
  Mail, Phone, Ticket, ArrowRight, Building2,
  Users, Tag, XCircle, CheckCircle, Lock,
  Package, CheckCircle2, Shirt, AlarmClock,
  Droplets, ShieldAlert, Flag, FileText, Layers, Target,
  ClipboardList, Laptop, UserCheck,
  Navigation, ChevronDown, ChevronUp,
  Share2, Bookmark, ShieldCheck, RefreshCcw, Headphones,
  BadgeCheck, ChevronRight, Heart, IndianRupee, Mic,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { Container }      from '@/components/ui/Container'
import { buttonVariants } from '@/components/ui/button'
import type {
  AgendaSession, Speaker, Sponsor, SponsorTier,
  PhysicalVenueConfig, OnlineVenueConfig, OrganizerInfo,
  MediaAsset, VenueMaps,
  SportsRunningDetails, WorkshopDetails, FundraisingDetails,
  ExhibitionDetails, CommunityDetails, CulturalDetails,
  ExperienceItem, TimelineItem, GalleryItem, FaqItem,
} from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import type { PassAvailability } from '@/lib/registrations/types'
import type { PassPublic } from '@/components/event-templates/types'
import { SectionWrapper }     from '@/components/event-templates/shared/ui/SectionWrapper'
import { AvailabilityBadge }  from '@/components/event-templates/shared/registration/AvailabilityBadge'
import { AgendaSection }      from '@/components/event-templates/shared/schedule/AgendaSection'
import { SpeakersSection }    from '@/components/event-templates/shared/people/SpeakersSection'
import { SponsorGrid }        from '@/components/event-templates/shared/sponsors/SponsorGrid'
import { OrganizerSection }   from '@/components/event-templates/shared/people/OrganizerSection'
import { HighlightsSection }        from '@/components/event-templates/shared/media/HighlightsSection'
import { FactsStrip }               from '@/components/event-templates/shared/ui/FactsStrip'
import { TicketSection }            from '@/components/event-templates/shared/registration/TicketSection'
import { StickyRegistrationCard }   from '@/components/event-templates/shared/registration/StickyRegistrationCard'
import { AboutSection }      from '@/components/event-templates/shared/ui/AboutSection'
import { VenueSection }      from '@/components/event-templates/shared/venue/VenueSection'
import { FAQSection }        from '@/components/event-templates/shared/faq/FAQSection'
import { StickyMobileCTA }         from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { AddToCalendarButton }     from '@/components/event-templates/shared/ui/AddToCalendarButton'

export interface EventDetailProps {
  slug:              string
  lifecycleStatus:   string
  cancelReason?:     string
  eventType?:        string
  eventSubtype?:     string
  registrationOpen: boolean
  regClosedMessage: string
  title:            string
  tagline:          string
  description:      string
  bannerUrl:        string
  logoUrl:          string
  gallery:          MediaAsset[]
  promoVideoUrl:    string
  startDate:        string
  startTime:        string
  endDate:          string
  endTime:          string
  doorsOpenTime:    string
  agenda:           AgendaSession[]
  venueType:        'physical' | 'online' | 'hybrid'
  physical?:        PhysicalVenueConfig
  online?:          OnlineVenueConfig
  venueName:        string
  mapsLink:         string
  venueMaps:        VenueMaps | null
  organizer?:       OrganizerInfo
  showOrg:          boolean
  showSocial:       boolean
  showVenueMap:     boolean
  isFreeEvent:      boolean
  passes:           PassPublic[]
  availability:     Record<string, PassAvailability>
  speakers:         Speaker[]
  sponsors:         Sponsor[]
  showSpeakers:      boolean
  showSponsors:      boolean
  showAgenda:        boolean
  showGallery:       boolean
  showAttendeeCount: boolean
  typeDetails:       Record<string, unknown> | null
  experience?:       ExperienceItem[]
  timeline?:         TimelineItem[]
  galleryMedia?:     GalleryItem[]
  faq?:              FaqItem[]
  language:         string
  dressCode:        string
  faqUrl:           string
  supportEmail:     string
  supportPhone:     string
  termsUrl:         string
  refundPolicyUrl:  string
  privacyPolicyUrl: string
  // Linked donation campaign — present for event_plus_donation events only
  linkedCampaign?: {
    slug:               string
    title:              string
    story:              string
    targetAmountRupees: number | null
    showGoalAmount:     boolean
    endDate:            string
    totalRaisedPaise:   number
    donorCount:         number
  } | null
  // Registered exhibitors for the public directory — exhibition events only
  exhibitorDirectory?: { companyName: string; website: string | null }[]
  // Applications CTAs — shown when organiser enables them
  speakerApplicationsOpen?: boolean
  sponsorApplicationsOpen?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function formatDateShort(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function formatTime(timeStr: string): string {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12  = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(amount)
}

function minPassPrice(passes: PassPublic[]): number {
  const active = passes.filter(p => p.status !== 'inactive')
  return active.length > 0 ? Math.min(...active.map(p => p.price ?? 0)) : 0
}

// SectionWrap is an alias kept for the type-specific legacy sections below.
// All new extractions use SectionWrapper from shared/ui.
const SectionWrap = SectionWrapper

// AvailBadge is an alias kept for the TicketSection and RegistrationCard below.
const AvailBadge = AvailabilityBadge

// FactsStrip → imported from shared/ui/FactsStrip
// RegistrationCard → StickyRegistrationCard imported from shared/registration/StickyRegistrationCard
// TicketSection → imported from shared/registration/TicketSection

// AboutSection → imported from shared/ui/AboutSection
// HighlightsSection → imported from shared/media/HighlightsSection

// VenueSection → imported from shared/venue/VenueSection
// ScheduleSection → AgendaSection imported from shared/schedule/AgendaSection
// SpeakersSection → imported from shared/people/SpeakersSection
// SponsorsSection → SponsorGrid imported from shared/sponsors/SponsorGrid
// OrganizerSection → imported from shared/people/OrganizerSection

// FAQSection → imported from shared/faq/FAQSection

// ─── Type-specific sections ───────────────────────────────────────────────────

function WorkshopSection({ td }: { td: WorkshopDetails }) {
  const outcomes = (td.learningOutcomes ?? []).filter(Boolean)
  const hasContent =
    td.prerequisites?.trim() || outcomes.length > 0 ||
    td.materialsIncluded?.trim() || td.softwareRequired?.trim() ||
    (td.batchSize && td.batchSize > 0)
  if (!hasContent) return null

  return (
    <SectionWrap title="Workshop Details">
      <div className="grid gap-5 sm:grid-cols-2">
        {td.prerequisites?.trim() && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <ClipboardList className="size-3.5 text-primary" aria-hidden />
              <p className="text-xs font-bold text-foreground">Prerequisites</p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.prerequisites}</p>
          </div>
        )}
        {td.materialsIncluded?.trim() && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <Package className="size-3.5 text-primary" aria-hidden />
              <p className="text-xs font-bold text-foreground">Materials Included</p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.materialsIncluded}</p>
          </div>
        )}
        {td.softwareRequired?.trim() && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <Laptop className="size-3.5 text-primary" aria-hidden />
              <p className="text-xs font-bold text-foreground">Software Required</p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.softwareRequired}</p>
          </div>
        )}
        {td.batchSize != null && td.batchSize > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <UserCheck className="size-3.5 text-primary" aria-hidden />
              <p className="text-xs font-bold text-foreground">Batch Size</p>
            </div>
            <p className="text-xl font-extrabold text-foreground">
              {td.batchSize}
              <span className="ml-1 text-xs font-normal text-muted-foreground">participants</span>
            </p>
          </div>
        )}
      </div>
      {outcomes.length > 0 && (
        <div className={cn(
          'grid gap-2 sm:grid-cols-2',
          (td.prerequisites?.trim() || td.materialsIncluded?.trim() || td.softwareRequired?.trim())
            && 'mt-5 border-t border-border/40 pt-5',
        )}>
          <div className="col-span-full mb-1 flex items-center gap-2">
            <Target className="size-3.5 text-primary" aria-hidden />
            <p className="text-xs font-bold text-foreground">What You&apos;ll Learn</p>
          </div>
          {outcomes.map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              <p className="text-xs leading-relaxed text-muted-foreground">{item}</p>
            </div>
          ))}
        </div>
      )}
    </SectionWrap>
  )
}

function SportsSection({ td }: { td: SportsRunningDetails }) {
  type InfoItem = { icon: React.ReactNode; label: string; value: string; sub?: string }
  const infoItems: InfoItem[] = [
    td.reportingTime      && { icon: <AlarmClock  className="size-3.5" />, label: 'Reporting Time',   value: td.reportingTime },
    td.kitCollectionDate  && { icon: <Package     className="size-3.5" />, label: 'Kit Collection',   value: td.kitCollectionDate, sub: td.kitCollectionInfo || undefined },
    td.bagDepositInfo     && { icon: <Package     className="size-3.5" />, label: 'Bag Deposit',      value: td.bagDepositInfo },
    td.hydrationPoints    && { icon: <Droplets    className="size-3.5" />, label: 'Hydration Points', value: td.hydrationPoints },
    td.medicalSupportInfo && { icon: <ShieldAlert className="size-3.5" />, label: 'Medical Support',  value: td.medicalSupportInfo },
    td.startLineInfo      && { icon: <Flag        className="size-3.5" />, label: 'Start Line',       value: td.startLineInfo },
  ].filter(Boolean) as InfoItem[]

  const hasContent = td.routeMapUrl?.trim() || infoItems.length > 0 || td.rulesUrl?.trim()
  if (!hasContent) return null

  return (
    <SectionWrap title="Race Information">
      {td.routeMapUrl?.trim() && (
        <div className="mb-5 overflow-hidden rounded-xl bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={td.routeMapUrl} alt="Race route map" className="w-full object-contain" loading="lazy" />
        </div>
      )}
      {infoItems.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {infoItems.map(({ icon, label, value, sub }, i) => (
            <div key={i}>
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-primary">{icon}</span>
                <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </p>
              </div>
              <p className="text-sm font-semibold text-foreground">{value}</p>
              {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
            </div>
          ))}
        </div>
      )}
      {td.rulesUrl?.trim() && (
        <div className="mt-4">
          <a
            href={td.rulesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
          >
            <FileText className="size-3.5" aria-hidden />
            View Race Rules
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      )}
    </SectionWrap>
  )
}

function FundraisingSection({ td }: { td: FundraisingDetails }) {
  const hasContent =
    td.beneficiaryInfo?.trim() || td.fundUsage?.trim() ||
    td.ngoPartner?.trim() || td.taxExemptionInfo?.trim() ||
    (td.donationGoal && td.donationGoal > 0)
  if (!hasContent) return null

  return (
    <SectionWrap title="About the Cause">
      <div className="grid gap-5 sm:grid-cols-2">
        {td.beneficiaryInfo?.trim() && (
          <div className="col-span-full">
            <p className="mb-1 text-xs font-bold text-foreground">Who Benefits</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.beneficiaryInfo}</p>
          </div>
        )}
        {td.fundUsage?.trim() && (
          <div>
            <p className="mb-1 text-xs font-bold text-foreground">How Funds Are Used</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.fundUsage}</p>
          </div>
        )}
        {td.ngoPartner?.trim() && (
          <div>
            <p className="mb-1 text-xs font-bold text-foreground">NGO Partner</p>
            <p className="text-sm font-semibold text-foreground">{td.ngoPartner}</p>
          </div>
        )}
        {td.donationGoal != null && td.donationGoal > 0 && (
          <div>
            <p className="mb-1 text-xs font-bold text-foreground">Fundraising Goal</p>
            <p className="text-2xl font-extrabold text-foreground">{formatINR(td.donationGoal)}</p>
          </div>
        )}
        {td.taxExemptionInfo?.trim() && (
          <div className="col-span-full flex items-start gap-2.5 rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-3.5">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
            <p className="text-xs text-emerald-700">{td.taxExemptionInfo}</p>
          </div>
        )}
      </div>
    </SectionWrap>
  )
}

function ExhibitionSection({ td }: { td: ExhibitionDetails }) {
  const hasContent =
    td.visitorInstructions?.trim() || td.parkingInfo?.trim() ||
    td.floorPlanUrl?.trim() || td.boothInfoUrl?.trim()
  if (!hasContent) return null

  return (
    <SectionWrap title="Visitor Information">
      <div className="space-y-4">
        {td.visitorInstructions?.trim() && (
          <div>
            <p className="mb-1 text-xs font-bold text-foreground">Instructions</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.visitorInstructions}</p>
          </div>
        )}
        {td.parkingInfo?.trim() && (
          <div>
            <p className="mb-1 text-xs font-bold text-foreground">Parking</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.parkingInfo}</p>
          </div>
        )}
        {(td.floorPlanUrl?.trim() || td.boothInfoUrl?.trim()) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {td.floorPlanUrl?.trim() && (
              <a href={td.floorPlanUrl} target="_blank" rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
                <Layers className="size-3.5" aria-hidden />Floor Plan
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
            {td.boothInfoUrl?.trim() && (
              <a href={td.boothInfoUrl} target="_blank" rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
                <Tag className="size-3.5" aria-hidden />Booth Info
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        )}
      </div>
    </SectionWrap>
  )
}

function CommunitySection({ td }: { td: CommunityDetails }) {
  const hasContent = td.causeInfo?.trim() || td.volunteerInstructions?.trim() || td.impactGoal?.trim()
  if (!hasContent) return null
  return (
    <SectionWrap title="Our Mission">
      <div className="space-y-4">
        {td.causeInfo?.trim() && (
          <div><p className="mb-1 text-xs font-bold text-foreground">The Cause</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.causeInfo}</p></div>
        )}
        {td.impactGoal?.trim() && (
          <div><p className="mb-1 text-xs font-bold text-foreground">Impact Goal</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.impactGoal}</p></div>
        )}
        {td.volunteerInstructions?.trim() && (
          <div><p className="mb-1 text-xs font-bold text-foreground">Volunteering</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.volunteerInstructions}</p></div>
        )}
      </div>
    </SectionWrap>
  )
}

function CulturalSection({ td }: { td: CulturalDetails }) {
  const hasContent = td.programSchedule?.trim() || td.entryRules?.trim() || td.ageRestriction?.trim()
  if (!hasContent) return null
  return (
    <SectionWrap title="Event Details">
      <div className="grid gap-5 sm:grid-cols-2">
        {td.programSchedule?.trim() && (
          <div className="col-span-full">
            <p className="mb-1 text-xs font-bold text-foreground">Program Schedule</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.programSchedule}</p>
          </div>
        )}
        {td.entryRules?.trim() && (
          <div><p className="mb-1 text-xs font-bold text-foreground">Entry Rules</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{td.entryRules}</p></div>
        )}
        {td.ageRestriction?.trim() && (
          <div><p className="mb-1 text-xs font-bold text-foreground">Age Restriction</p>
            <p className="text-sm font-semibold text-foreground">{td.ageRestriction}</p></div>
        )}
      </div>
    </SectionWrap>
  )
}

// ─── Linked donation campaign section ────────────────────────────────────────

function LinkedCampaignSection({
  campaign,
  eventSlug,
}: {
  campaign: NonNullable<EventDetailProps['linkedCampaign']>
  eventSlug: string
}) {
  const raisedRupees = Math.floor(campaign.totalRaisedPaise / 100)
  const targetRupees = campaign.targetAmountRupees ?? 0
  const progress     = targetRupees > 0 ? Math.min((raisedRupees / targetRupees) * 100, 100) : 0
  const fmtINR = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n)

  return (
    <SectionWrapper id="donate" title="Support this cause">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-pink-100">
          <Heart className="size-5 text-pink-500" />
        </div>
        <div>
          <h2 className="text-[20px] font-bold text-foreground">Fundraising Campaign</h2>
          <p className="mt-0.5 text-[var(--fs-sm)] text-muted-foreground">
            Your donation directly supports this event&apos;s cause.
          </p>
        </div>
      </div>

      {/* Metrics */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-3.5">
          <p className="text-[var(--fs-2xs)] font-medium uppercase tracking-wide text-muted-foreground">Raised</p>
          <p className="mt-1 flex items-center gap-0.5 text-[20px] font-bold text-foreground">
            <IndianRupee className="size-4 shrink-0" />
            {fmtINR(raisedRupees)}
          </p>
        </div>
        {campaign.showGoalAmount && campaign.targetAmountRupees && (
          <div className="rounded-xl border border-border bg-card p-3.5">
            <p className="text-[var(--fs-2xs)] font-medium uppercase tracking-wide text-muted-foreground">Goal</p>
            <p className="mt-1 flex items-center gap-0.5 text-[20px] font-bold text-foreground">
              <IndianRupee className="size-4 shrink-0" />
              {fmtINR(campaign.targetAmountRupees)}
            </p>
          </div>
        )}
        <div className="rounded-xl border border-border bg-card p-3.5">
          <p className="text-[var(--fs-2xs)] font-medium uppercase tracking-wide text-muted-foreground">Donors</p>
          <p className="mt-1 text-[20px] font-bold text-foreground">{fmtINR(campaign.donorCount)}</p>
        </div>
      </div>

      {/* Progress bar */}
      {campaign.showGoalAmount && campaign.targetAmountRupees && (
        <div className="mt-4">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1.5 text-[var(--fs-xs)] text-muted-foreground">
            {progress.toFixed(0)}% of ₹{fmtINR(campaign.targetAmountRupees)} goal
          </p>
        </div>
      )}

      {/* Story excerpt */}
      {campaign.story && (
        <p className="mt-4 line-clamp-3 text-[var(--fs-base)] leading-relaxed text-muted-foreground">
          {campaign.story}
        </p>
      )}

      {/* CTA */}
      <div className="mt-5">
        <Link
          href={`/donate/${campaign.slug}`}
          className={cn(
            buttonVariants({ variant: 'gradient' }),
            'inline-flex w-full justify-center gap-2 sm:w-auto',
          )}
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          <Heart className="size-4" />
          Donate to this cause
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </SectionWrapper>
  )
}

// StickyMobileCTA → imported from shared/registration/StickyMobileCTA

// ─── Main component ───────────────────────────────────────────────────────────

export function EventDetailClient(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    eventType, eventSubtype,
    registrationOpen, regClosedMessage,
    title, tagline, description,
    bannerUrl, logoUrl, gallery, promoVideoUrl,
    startDate, startTime, endDate, endTime, doorsOpenTime, agenda,
    venueType, physical, online, venueName, mapsLink, venueMaps,
    organizer, showOrg, showSocial,
    isFreeEvent, passes, availability,
    speakers, sponsors,
    showSpeakers, showSponsors, showAgenda, showGallery,
    typeDetails,
    faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
    linkedCampaign,
    speakerApplicationsOpen, sponsorApplicationsOpen,
  } = props

  const heroRef = useRef<HTMLDivElement>(null)
  const [showStickyCta, setShowStickyCta] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const el = heroRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => setShowStickyCta(!entry.isIntersecting),
      { threshold: 0.1 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleShare = () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    if (navigator.share) {
      navigator.share({ title, url }).catch(() => null)
    } else {
      navigator.clipboard.writeText(url).catch(() => null)
    }
  }

  const td            = typeDetails ?? {}
  const isSports      = eventType === 'sports'
  const isWorkshop    = eventType === 'workshop'
  const isFundraising = eventType === 'fundraising'
  const isCommunity   = eventType === 'community'
  const isExhibition  = eventType === 'exhibition'
  const isCultural    = eventType === 'cultural'
  const showHighlights = promoVideoUrl || (showGallery && gallery.length > 0)

  // Date / time display strings
  const dateStr = !startDate ? '' : startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} – ${endDate ? formatDate(endDate) : ''}`
  const timeStr = startTime
    ? `${formatTime(startTime)}${endTime ? ` – ${formatTime(endTime)}` : ''}`
    : ''

  // Derive highlight chips from pass benefits (unique, up to 6)
  const allBenefits: string[] = []
  passes.filter(p => p.status !== 'inactive').forEach(p => {
    (p.benefits ?? []).forEach(b => {
      if (b.trim() && !allBenefits.includes(b.trim())) allBenefits.push(b.trim())
    })
  })
  const highlightChips = allBenefits.slice(0, 6).map(b => ({
    icon: <CheckCircle2 className="size-3.5" aria-hidden />,
    label: b,
  }))

  // Derive event highlight perks (for sports: race-specific perks from td)
  const sportsTd = td as unknown as SportsRunningDetails
  const eventPerks: { icon: React.ReactNode; label: string; sub?: string }[] = isSports
    ? [
        sportsTd.medicalSupportInfo && {
          icon: <ShieldAlert className="size-4" />, label: 'Medical Support',
        },
        sportsTd.hydrationPoints && {
          icon: <Droplets className="size-4" />, label: 'Hydration Points',
        },
      ].filter(Boolean) as typeof eventPerks
    : []

  return (
    <div className="bg-background">
      <MarketingNavbar />

      {/* ── Lifecycle banners ─────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="relative z-20 border-b border-red-200 bg-red-50 px-4 py-2.5">
          <Container>
            <div className="flex items-center gap-2.5">
              <XCircle className="size-4 shrink-0 text-red-500" aria-hidden />
              <p className="text-xs font-bold text-red-700">
                This event has been cancelled.{cancelReason && ` ${cancelReason}`}
              </p>
            </div>
          </Container>
        </div>
      )}
      {ls === 'completed' && (
        <div className="relative z-20 border-b border-sky-200 bg-sky-50 px-4 py-2.5">
          <Container>
            <div className="flex items-center gap-2.5">
              <CheckCircle className="size-4 shrink-0 text-sky-500" aria-hidden />
              <p className="text-xs font-semibold text-sky-700">
                This event has ended. Thank you to all who attended!
              </p>
            </div>
          </Container>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="relative z-20 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <Container>
            <div className="flex items-center gap-2.5">
              <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
              <p className="text-xs font-semibold text-amber-700">
                Registrations are currently closed for this event.
              </p>
            </div>
          </Container>
        </div>
      )}

      {/* ── Page layout ───────────────────────────────────────────── */}
      <div className="relative">

        {/* Full-width hero background (positioned behind the two-column grid) */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-0 h-[380px] overflow-hidden lg:h-[420px]"
        >
          {bannerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bannerUrl}
              alt=""
              className="h-full w-full object-cover"
              fetchPriority="high"
            />
          ) : (
            <div
              className="h-full w-full"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            />
          )}
          {/* Gradient overlays: dark left → transparent right for card legibility */}
          <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/70 to-black/25" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
        </div>

        {/* Two-column grid — left content + right sticky card */}
        <Container className="relative pb-16 lg:pb-12">
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-8 lg:items-start">

            {/* ── LEFT COLUMN ───────────────────────────────────────── */}
            <div>

              {/* Hero content — MarketingNavbar self-spaces, so only breathing room here */}
              <section
                ref={heroRef}
                className="pt-8 pb-6"
                aria-label="Event overview"
              >
                {/* Breadcrumb */}
                <nav className="mb-3 flex items-center gap-1 text-[10.5px] text-white/50" aria-label="Breadcrumb">
                  <Link href="/" className="transition-colors hover:text-white">Home</Link>
                  <ChevronRight className="size-3 shrink-0 opacity-50" aria-hidden />
                  <Link href="/events" className="transition-colors hover:text-white">Events</Link>
                  <ChevronRight className="size-3 shrink-0 opacity-50" aria-hidden />
                  <span className="max-w-[200px] truncate text-white/80">{title}</span>
                </nav>

                {/* Category badge */}
                {eventType && (
                  <div className="mb-2">
                    <span className="rounded-full bg-white/15 px-3 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white/80 backdrop-blur-sm">
                      {eventType}{eventSubtype ? ` · ${eventSubtype}` : ''}
                    </span>
                  </div>
                )}

                {/* Logo + title row */}
                {logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt={`${title} logo`}
                    className="mb-2 size-9 rounded-lg border border-white/20 bg-white/10 object-contain backdrop-blur-sm"
                  />
                )}

                {/* Title */}
                <h1 className="max-w-xl text-[26px] font-bold leading-[1.1] tracking-tight text-white drop-shadow sm:text-[30px] lg:text-[34px]">
                  {title}
                </h1>

                {/* Tagline */}
                {tagline && (
                  <p className="mt-1.5 text-sm font-medium text-white/80">{tagline}</p>
                )}

                {/* Short description */}
                {description && (
                  <p className="mt-1 max-w-lg text-xs leading-relaxed text-white/55 line-clamp-2">
                    {description}
                  </p>
                )}

                {/* Inline meta row */}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {dateStr && (
                    <div className="flex items-center gap-1.5 text-xs text-white/75">
                      <Calendar className="size-3.5 shrink-0 text-primary/80" aria-hidden />
                      <span>{dateStr}{timeStr && ` · ${timeStr}`}</span>
                    </div>
                  )}
                  {venueName && (
                    <div className="flex items-center gap-1.5 text-xs text-white/75">
                      {venueType === 'online'
                        ? <Globe  className="size-3.5 shrink-0 text-primary/80" aria-hidden />
                        : <MapPin className="size-3.5 shrink-0 text-primary/80" aria-hidden />}
                      <span>
                        {venueName}
                        {physical?.city && `, ${physical.city}`}
                      </span>
                    </div>
                  )}
                  {doorsOpenTime && (
                    <div className="flex items-center gap-1.5 text-xs text-white/75">
                      <AlarmClock className="size-3.5 shrink-0 text-primary/80" aria-hidden />
                      <span>Doors Open {formatTime(doorsOpenTime)}</span>
                    </div>
                  )}
                </div>

                {/* CTA row */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {registrationOpen && passes.filter(p => p.status !== 'inactive').length > 0 && (
                    <Link
                      href="#tickets"
                      className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}
                    >
                      Register Now
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  )}
                  <button
                    onClick={handleShare}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
                  >
                    <Share2 className="size-3.5" aria-hidden />
                    Share
                  </button>
                  {startDate && (
                    <AddToCalendarButton
                      title={title}
                      startDate={startDate}
                      endDate={endDate || startDate}
                      startTime={startTime}
                      endTime={endTime}
                      location={venueName + (physical?.city ? `, ${physical.city}` : '')}
                      description={description}
                      slug={slug}
                      variant="dark"
                    />
                  )}
                  {speakerApplicationsOpen && (
                    <Link
                      href={`/events/${slug}/speak`}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
                    >
                      <Mic className="size-3.5" aria-hidden />
                      Apply to Speak
                    </Link>
                  )}
                  {sponsorApplicationsOpen && (
                    <Link
                      href={`/events/${slug}/sponsor`}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
                    >
                      <Building2 className="size-3.5" aria-hidden />
                      Become a Sponsor
                    </Link>
                  )}
                  <button
                    onClick={() => setSaved(s => !s)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3.5 text-xs font-medium text-white backdrop-blur-sm transition-colors',
                      saved
                        ? 'border-primary/50 bg-primary/20'
                        : 'border-white/25 bg-white/10 hover:bg-white/20',
                    )}
                  >
                    <Bookmark className={cn('size-3.5', saved && 'fill-current')} aria-hidden />
                    {saved ? 'Saved' : 'Save'}
                  </button>
                </div>
              </section>

              {/* Facts strip — 24px below hero, 32px above content */}
              <div className="mb-8">
                <FactsStrip
                  startDate={startDate}    startTime={startTime}
                  endDate={endDate}        endTime={endTime}
                  doorsOpenTime={doorsOpenTime}
                  venueName={venueName}    venueType={venueType}
                  physical={physical}
                  mapsLink={mapsLink}
                />
              </div>

              {/* ── Content sections ──────────────────────────────── */}
              <div className="divide-y divide-border/40 bg-background">

                {/* About */}
                {description && (
                  <AboutSection
                    description={description}
                    highlights={highlightChips.length > 0 ? highlightChips : undefined}
                  />
                )}

                {/* Ticket categories — full section in left column */}
                {/* [DEBUG] Layer 2 — passes reaching EventDetailClient */}
                {console.log('[EVENT PASSES] Layer 2 — EventDetailClient passes count:', passes.length, passes.map(p => ({ name: p.name, visibility: p.visibility, status: p.status }))) as unknown as null}
                <TicketSection
                  passes={passes}
                  isFreeEvent={isFreeEvent}
                  slug={slug}
                  availability={availability}
                  registrationOpen={registrationOpen}
                  closedMessage={regClosedMessage}
                />

                {/* Linked donation campaign — event_plus_donation only */}
                {linkedCampaign && (
                  <LinkedCampaignSection campaign={linkedCampaign} eventSlug={slug} />
                )}

                {/* Highlights */}
                {(showHighlights || eventPerks.length > 0) && (
                  <HighlightsSection
                    promoVideoUrl={promoVideoUrl}
                    gallery={showGallery ? gallery : []}
                    perks={eventPerks.length > 0 ? eventPerks : undefined}
                  />
                )}

                {/* Type-specific sections */}
                {isSports      && <SportsSection      td={td as unknown as SportsRunningDetails} />}
                {isWorkshop    && <WorkshopSection     td={td as unknown as WorkshopDetails} />}
                {isFundraising && <FundraisingSection  td={td as unknown as FundraisingDetails} />}
                {isCommunity   && <CommunitySection    td={td as unknown as CommunityDetails} />}
                {isExhibition  && <ExhibitionSection   td={td as unknown as ExhibitionDetails} />}
                {isCultural    && <CulturalSection     td={td as unknown as CulturalDetails} />}

                {/* Venue */}
                <VenueSection
                  venueType={venueType}
                  physical={physical}
                  online={online}
                  mapsLink={mapsLink}
                  venueMaps={venueMaps}
                />

                {/* Schedule */}
                {showAgenda && agenda.length > 0 && (
                  <AgendaSection agenda={agenda} />
                )}

                {/* Speakers */}
                {showSpeakers && speakers.length > 0 && (
                  <SpeakersSection speakers={speakers} />
                )}

                {/* Sponsors */}
                {showSponsors && sponsors.length > 0 && (
                  <SponsorGrid sponsors={sponsors} />
                )}

                {/* Organizer */}
                {showOrg && organizer?.name && (
                  <OrganizerSection organizer={organizer} showSocial={showSocial} />
                )}

                {/* FAQ / Support */}
                <FAQSection
                  faqUrl={faqUrl}
                  supportEmail={supportEmail}
                  supportPhone={supportPhone}
                  termsUrl={termsUrl}
                  refundPolicyUrl={refundPolicyUrl}
                  privacyPolicyUrl={privacyPolicyUrl}
                />

              </div>
            </div>

            {/* ── RIGHT COLUMN: sticky registration card ─────────── */}
            <div className="hidden lg:block">
              {/* pt-8 aligns card top with left column content; sticky top-24 keeps it clear of the fixed navbar on scroll */}
              <div className="sticky top-24 pt-8">
                <StickyRegistrationCard
                  passes={passes}
                  isFreeEvent={isFreeEvent}
                  slug={slug}
                  availability={availability}
                  registrationOpen={registrationOpen}
                  closedMessage={regClosedMessage}
                  registrationEndDate=""
                  saved={saved}
                  onSave={() => setSaved(s => !s)}
                />
              </div>
            </div>

          </div>
        </Container>
      </div>

      {/* ── Sticky mobile CTA ─────────────────────────────────────── */}
      <StickyMobileCTA
        visible={showStickyCta}
        title={title}
        isFreeEvent={isFreeEvent}
        passes={passes}
        registrationOpen={registrationOpen}
      />
    </div>
  )
}
