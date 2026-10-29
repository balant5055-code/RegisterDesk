'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useDraft } from '@/lib/hooks/useDraft'
import { useUnsavedChangesWarning } from '@/lib/hooks/useUnsavedChangesWarning'
import { SaveStatusIndicator } from '@/components/wizard/SaveStatusIndicator'
import { DraftRecoveryPrompt } from '@/components/wizard/DraftRecoveryPrompt'
import { useCampaignDraft } from '@/lib/hooks/useCampaignDraft'
import { formatINR } from '@/lib/events/builder/format'
import { computeFeePreview } from '@/lib/events/builder/feePreview'
import {
  type WizardStep, type StepViewProps, type VisibilityId,
  type FeeModel, SUPPORTED_FEE_MODEL, DEFAULT_FEE_MODEL_WHEN_ENABLED,
  type FeeRates, type StepSummary, type ReadinessReport,
} from '@/lib/events/builder/types'
import { readFeeCollection, buildFeeCollection } from '@/lib/fees/explicitFeeModel'
import { useAuth } from '@/components/auth/AuthProvider'
import { draftKeyFor, indexOfStep, resumeStepFor, isSubmittedDraftStatus, type WizardFlow } from '@/lib/events/builder/stepRegistry'
import { readReviewDeadline, currentDueAt } from '@/lib/events/reviewDeadline'
import { isReviewClosed } from '@/lib/events/lifecycleStateMachine'
import { ReviewDeadlineCountdown } from '@/components/events/ReviewDeadlineCountdown'
import { readIntent, clearIntent, returnLabelFor } from '@/lib/wallet/purchaseIntent'
import { validateStep } from '@/lib/events/builder/stepValidation'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import { Stepper } from '@/components/event-builder/Stepper'
import { Step1View, type Step1State } from '@/components/event-builder/steps/Step1View'
import { Step2View } from '@/components/event-builder/steps/Step2View'
import { Step3View } from '@/components/event-builder/steps/Step3View'
import { Step4View } from '@/components/event-builder/steps/Step4View'
import { Step5View } from '@/components/event-builder/steps/Step5View'
import { Step6View } from '@/components/event-builder/steps/Step6View'
import {
  type CampaignType,
  makeBlankCampaignDetailsDraft,
  getCampaignPublishBlockers,
} from '@/lib/campaigns/campaignDetailsConfig'
import {
  makeBlankDonationSettingsDraft,
  isDonationSettingsValid,
} from '@/lib/campaigns/donationSettingsConfig'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Award,
  Check,
  CheckCircle2,
  Calendar,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  Globe,
  IndianRupee,
  Lock,
  Mail,
  MessageSquare,
  MapPin,
  MoreHorizontal,
  Phone,
  RefreshCw,
  Settings2,
  Shield,
  Tag,
  Ticket,
  TrendingUp,
  Upload,
  UserCheck,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { type EventPassFull } from '@/components/wizard/AddPassEditor'
import type { FormField, FormSection, RegistrationRules } from '@/components/wizard/registrationFormConfig'
import { calcStepHealth, normalizeEventDetailsDraft, type EventDetailsDraft, type Speaker, type Sponsor, type AgendaSession, ONLINE_PLATFORM_LABELS, SPONSOR_TIER_LABELS, SESSION_TYPE_LABELS } from '@/components/wizard/eventDetailsConfig'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { auth } from '@/lib/firebase/auth'
import { validatePublish, toPublishBlocker } from '@/lib/events/publishRequirements'
import { buildEventHref } from '@/lib/events/registerHref'
import { PublishSectionHealthGrid } from '@/components/wizard/PublishSectionHealth'
import { PublishFindingsPanel } from '@/components/wizard/PublishFindings'
import { ReviewSummary } from '@/components/wizard/ReviewSummary'
import type { PublishApiResponse, PublishGovernanceInfo } from '@/types/events'
import { CURRENT_LICENSE_VERSION, isValidTierForVersion, defaultLicenseTierForVersion, type AnyEventLicenseTier } from '@/lib/licensing/eventLicense'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { capacityIntentToPersist, isPersistedCapacity } from '@/lib/events/builder/capacityIntent'
import { LicenseServicesStep, type LicenseServicesStepProps, type PaygServiceFlags, type FinalPayContext } from '@/components/wizard/LicenseServicesStep'
import { PublishPlanSection } from '@/components/wizard/PublishPlanSection'
import { buildPlanSummary } from '@/components/wizard/publishPlanSummary'
import { isChannelImplemented } from '@/lib/communications/health/channels'
import { PUBLISH_AGREEMENT_DOCUMENTS, type PublishAgreementInput } from '@/lib/legal/organizerAgreement'
import { EMPTY_SELECTION, parseServiceSelection, type ServiceSelection } from '@/lib/licensing/serviceAllowances'
import { useFeesConfig } from '@/lib/fees/feesConfigClient'
import type { PublicFeesConfig } from '@/lib/fees/publicFeesShared'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { planTypeTransition } from '@/lib/events/builder/typeTransition'
import { publishValueIssues } from '@/lib/events/eventValueRules'
import { useEventContext } from '@/components/dashboard/EventContextProvider'

// GA-7C S2/P4: lazy-load the heavy per-step builders so the initial /dashboard/events/new
// bundle doesn't ship them all up front. Steps are already conditionally mounted, so each
// builder's code is fetched only when its step is first reached — functionality unchanged.
// (AddPassEditor stays static: it co-exports the makeBlankPass value factory this module
// calls at the top level.)
const builderLoading = () => (
  <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">Loading…</div>
)
const LinkedCampaignStep = dynamic(
  () => import('@/components/wizard/LinkedCampaignStep').then(m => m.LinkedCampaignStep), { loading: builderLoading },
)
// TemplatePreviewPanel (Step-1-only dynamic import) → components/event-builder/steps/Step1View.tsx (RD-PRODUCT-01G Phase 5B).
const DonationCampaignDetailsBuilder = dynamic(
  () => import('@/components/campaign/DonationCampaignDetailsBuilder').then(m => m.DonationCampaignDetailsBuilder), { loading: builderLoading },
)
const DonationSettingsBuilder = dynamic(
  () => import('@/components/campaign/DonationSettingsBuilder').then(m => m.DonationSettingsBuilder), { loading: builderLoading },
)

// --- Constants ----------------------------------------------------------------
// EASE + WIZARD_STEPS → lib/events/builder/constants.ts (RD-PRODUCT-01G Phase 5).


// WizardStep type extracted to lib/events/builder/types.ts (RD-PRODUCT-01G Phase 4).

// event_plus_donation — inserts 'Fundraising' after Details, then 'License' before Review
const FUNDRAISING_EVENT_WIZARD_STEPS: WizardStep[] = [
  { name: 'Event Type' },
  { name: 'Visibility' },
  { name: 'Access Control' },
  { name: 'Passes & Pricing' },
  { name: 'Form' },
  { name: 'Details' },
  { name: 'Fundraising' },
  // RD-EVENT-COMMERCE-05B — Review, then License & Services (payment + submission) last.
  { name: 'Review' },
  { name: 'License & Services' },
]

// Donation-only campaign has its own 4-step wizard that replaces steps 1–6
const CAMPAIGN_WIZARD_STEPS: WizardStep[] = [
  { name: 'Visibility' },
  { name: 'Campaign Details' },
  { name: 'Donation Settings' },
  { name: 'Review' },
]

// DONATION_CAMPAIGN_SUBTYPES (Step-1-only) → components/event-builder/steps/Step1View.tsx (RD-PRODUCT-01G Phase 5B).

// --- Step 1 constants + components + view → components/event-builder/steps/Step1View.tsx
//     (EVENT_TYPES, SUBTYPES_BY_EVENT_TYPE, EventTypeCard, SubtypeSelector,
//      CampaignTypeSelector, DonationSubtypeSelector, Step1State, Step1View — Phase 5B.)
//     Step1HelperPanel + BENEFITS were removed as dead code (defined, never rendered).


// --- Step 2 constants + components + view → components/event-builder/steps/Step2View.tsx
//     (VISIBILITY_OPTIONS, VisibilityCard, Step2HelperPanel, Step2State, Step2View — RD-PRODUCT-01G
//      Phase 6). RadioIndicator (shared with Step 3) → components/event-builder/RadioIndicator.tsx.
//     VisibilityId type → lib/events/builder/types.ts; PUBLIC/PRIVATE_REASONS → builder/constants.ts.

// --- Step 3 constants + components + view → components/event-builder/steps/Step3View.tsx
//     (ACCESS_CONTROL_OPTIONS, CONFIRMATION_OPTIONS, AccessControlCard, Step3SummaryPanel,
//      Step3OpenToAllPanel, Step3InviteCodePanel, Step3ApprovedContactListPanel,
//      RegistrationConfirmationSection, invite-code helpers, Step3State, Step3View — Phase 7).
//      Uses shared RadioIndicator + lib/events/builder/contacts (both imported, not duplicated).

// --- Step 4: Passes & Pricing ------------------------------------------------
//
// Step4View + its Step-4-only chain (generatePassId, RegTypeCard, EventTypeSelectorSection,
// PassesSection, RegistrationPeriodSection, AdvancedSettingsSection, Step4SummaryPanel) →
// components/event-builder/steps/Step4View.tsx (RD-PRODUCT-01G Phase 8). The shared autosave
// hook (useAutosaveEmit) → lib/events/builder/useAutosaveEmit.ts. Dead OPTIONAL_SERVICES was
// removed. The fee-preview helpers + fee/services sections BELOW are consumed by Step 7 (not
// Step 4), so they remain here until Step 7 is extracted.

// RD-PAYMENT-02 Phase 3: the fee-preview calculation moved to the ONE canonical adapter,
// lib/events/builder/feePreview.ts (computeFeePreview), which routes through the canonical
// engine (calculateFee) + resolveEffectiveFeeModel. The old page-local calcFees duplicated
// the engine and diverged on the GST base (platform+gateway vs the engine's platform-only).

// Maps the runtime public fee config to the wizard's display rates, honouring the
// gateway/GST master switches (disabled → 0). Platform fee is the representative
// resolved rate; the authoritative per-tier charge is computed server-side.
function feeRatesFrom(cfg: PublicFeesConfig): FeeRates {
  return {
    platformPercent: cfg.platformFeePercent,
    gatewayPercent:  cfg.gatewayFeeEnabled ? cfg.gatewayFeePercent : 0,
    gstPercent:      cfg.gstEnabled ? cfg.gstPercent : 0,
  }
}

const FEE_MODEL_LABELS: Record<FeeModel, string> = {
  attendee_pays:     'Attendee Pays Fees',
  organizer_absorbs: 'Organizer Absorbs Fees',
}

// --- Step 4 sub-components ----------------------------------------------------

// Card used by EventTypeSelectorSection — self-contained popover for examples


// ─── RD-FEE-RESTORE-01 · Fee Collection Method ────────────────────────────────
//
// Restored (it existed until RD-PHASE4-S3 · Q1 removed it), gated on the live pricing-engine
// flag. Three things differ from the version that was removed, each fixing a real defect:
//
//   • it prices through `computeFeePreview` — the canonical engine adapter. The old version
//     used a page-local `calcFees` that taxed platform+gateway for GST while the engine taxes
//     the platform fee only, so the organizer was shown a number checkout never charged.
//   • `samplePrice` is REQUIRED. The old default of 500 is what let a free event render a
//     fee comparison for an invented ₹500 ticket (tests/unit/feeCollectionFreeEvent.test.ts).
//   • it renders only when the engine is on AND the event is paid. The caller owns both
//     conditions; this component never decides its own visibility.
//
// This control chooses what to RECORD. What is CHARGED is decided server-side from
// `pricing.feeCollection` (lib/fees/explicitFeeModel.ts) with the same flag re-checked there,
// so the UI is a convenience and never the authority.
function FeeCollectionSection({
  feeModel,
  onChange,
  samplePrice,
  locked = false,
}: {
  feeModel:    FeeModel
  onChange:    (m: FeeModel) => void
  samplePrice: number
  /** RD-LICENSE-LOCK-01 — read-only while a submitted event's purchase surface is locked. */
  locked?:     boolean
}) {
  const rates  = feeRatesFrom(useFeesConfig())
  const apFees = computeFeePreview(samplePrice, 'attendee_pays', rates)
  const oaFees = computeFeePreview(samplePrice, 'organizer_absorbs', rates)

  const OPTIONS = [
    {
      id: 'attendee_pays' as FeeModel,
      label: 'Attendee Pays Fees',
      desc: 'Fees are added on top of your ticket price. You receive the full ticket value.',
      fees: apFees,
      note: 'You receive the full amount',
      noteCls: 'text-emerald-700',
    },
    {
      id: 'organizer_absorbs' as FeeModel,
      label: 'Organizer Absorbs Fees',
      desc: 'Attendees pay only the ticket price. Platform fees are deducted from your payout.',
      fees: oaFees,
      note: 'Fees deducted from your payout',
      noteCls: 'text-amber-700',
    },
  ] as const

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[13px] font-semibold text-foreground">Fee Collection Method</p>
      <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
        Choose who pays RegisterDesk platform charges — shown for a {formatINR(samplePrice)} ticket.
        You can change this later; it applies to new registrations only.
      </p>

      <div
        role="radiogroup"
        aria-label="Fee Collection Method"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {OPTIONS.map(opt => {
          const selected = feeModel === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={locked}
              onClick={() => { if (!locked) onChange(opt.id) }}
              className={cn(
                'rounded-xl border p-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                selected ? 'border-primary bg-primary/[0.06]' : 'border-border hover:border-border-strong',
                locked && 'cursor-not-allowed opacity-60 hover:border-border',
              )}
            >
              <span className="block text-[13px] font-semibold text-foreground">{opt.label}</span>
              <span className="mt-1 block text-[12px] text-muted-foreground">{opt.desc}</span>
              <span className="mt-2 block text-[12px] text-foreground">
                Attendee pays <strong>{formatINR(opt.fees.attendeePays)}</strong> · you receive{' '}
                <strong>{formatINR(opt.fees.organizerGets)}</strong>
              </span>
              <span className={cn('mt-1 block text-[11.5px] font-medium', opt.noteCls)}>{opt.note}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// The informational Cashfree Easy Split notice that sits under the selector above.
function EasySplitNotice() {
  return (
    <div>
      {/* ═══ CASHFREE EASY SPLIT · INFORMATIONAL ONLY ════════════════════════
          Placed here because this is where the organizer already reads how the
          money they collect reaches them — the same neighbourhood as the fee
          collection method above.

          STATIC COPY, no control of any kind. Not even a disabled one: a disabled
          toggle is an invitation for a later change to remove `disabled`, and this
          feature is not built. It reads no state, writes no draft field, and has
          no counterpart in the event payload, so there is nothing to enable even
          if the markup were bypassed. */}
      <div className="mt-4 rounded-xl border border-dashed border-border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] font-semibold text-foreground">Cashfree Easy Split</p>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Coming Soon
          </span>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          Automatically split registration payments between RegisterDesk and eligible event
          organizers through Cashfree.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Subject to Cashfree activation, account eligibility and completion of the
          integration. Your payouts continue through the existing settlement process.
        </p>
      </div>
    </div>
  )
}

// --- Step 4: Summary Panel ----------------------------------------------------


// --- Step 4: RegisterDesk Services & Pricing section -------------------------


// --- Step 4 view --------------------------------------------------------------


// Step 5 view (Registration Form) → components/event-builder/steps/Step5View.tsx (RD-PRODUCT-01G
// Phase 9). The RegistrationFormBuilder dynamic import moved with it (Step-5-only); the field
// builder UI itself already lived in the shared components/wizard/RegistrationFormBuilder.

// Step 6 view (Event Details & Communication) → components/event-builder/steps/Step6View.tsx
// (RD-PRODUCT-01G Phase 10). The EventDetailsBuilder dynamic import moved with it (Step-6-only);
// the details + communication UI itself already lived in the shared components/wizard/
// EventDetailsBuilder (PURE RELOCATION — comms/email/WhatsApp/SMS logic untouched).

// --- Step 7 — Event Page Preview Modal ---------------------------------------

function EventPagePreviewModal({
  open,
  onClose,
  eventTypeId,
  eventSubtype,
  visibility,
  detailsData,
  pricingData,
  formData,
  acData,
  isFreeEvent,
  passes,
  minPassPrice,
}: {
  open:          boolean
  onClose:       () => void
  eventTypeId:   string | null
  eventSubtype:  string | null
  visibility:    string | null
  detailsData:   EventDetailsDraft | null
  pricingData:   Record<string, unknown> | null
  formData:      Record<string, unknown> | null
  acData:        Record<string, unknown> | null
  isFreeEvent:   boolean
  passes:        EventPassFull[]
  minPassPrice:  number
}) {
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop')

  if (!open) return null

  const safe         = detailsData
  const eventName    = safe?.info?.name?.trim()    || 'Untitled Event'
  const tagline      = safe?.info?.tagline?.trim() || ''
  const shortDesc    = safe?.info?.shortDesc?.trim() || ''
  const fullDesc     = safe?.info?.fullDesc?.trim()  || ''
  const logoUrl      = safe?.media?.logo?.value || ''
  const bannerUrl    = safe?.media?.coverBanner?.value || ''
  const galleryImages = safe?.media?.galleryImages?.filter(g => g.value?.trim()) ?? []

  const startDate    = safe?.schedule?.startDate || ''
  const startTime    = safe?.schedule?.startTime || ''
  const endDate      = safe?.schedule?.endDate   || ''
  const endTime      = safe?.schedule?.endTime   || ''
  const timezone     = safe?.schedule?.timezone  || ''
  const regOpen      = (pricingData?.registrationOpenDate as string | undefined) || ''
  const regClose     = (pricingData?.registrationEndDate  as string | undefined) || ''
  const agenda: AgendaSession[] = safe?.schedule?.agenda ?? []

  const venueType    = safe?.venue?.type
  const physical     = safe?.venue?.physical
  const online       = safe?.venue?.online
  const venueName    =
    venueType === 'online'
      ? (online?.platform ? (ONLINE_PLATFORM_LABELS[online.platform] ?? online.platform) : 'Online')
      : venueType === 'hybrid'
      ? (physical?.name || 'Hybrid Venue')
      : (physical?.name || '')
  const venueCity    = physical?.city  || ''
  const venueState   = physical?.state || ''
  const venueAddr    = [physical?.addressLine1, physical?.city, physical?.state, physical?.country].filter(Boolean).join(', ')

  const org          = safe?.organizer
  const orgName      = org?.name    || ''
  const orgEmail     = org?.email   || ''
  const orgPhone     = org?.phone   || ''
  const orgWebsite   = org?.website || ''
  const orgLogo      = org?.logoUrl || ''

  const publicPage   = safe?.publicPage
  const showSpeakers  = publicPage?.showSpeakers  !== false
  const showSponsors  = publicPage?.showSponsors  !== false
  const showAgenda    = publicPage?.showAgenda    !== false
  const showVenueMap  = publicPage?.showVenueMap  !== false
  const showGallery   = publicPage?.showGallery   !== false
  const showOrgInfo   = publicPage?.showOrganizerInfo !== false
  const showSocialLinks = publicPage?.showSocialLinks !== false

  // Extract type-specific speakers, sponsors
  const td = safe?.typeDetails as Record<string, unknown> | null | undefined
  const speakers: Speaker[] = Array.isArray(td?.speakers)
    ? (td!.speakers as Speaker[])
    : Array.isArray(td?.trainers) ? (td!.trainers as Speaker[])
    : Array.isArray(td?.artists)  ? (td!.artists  as Speaker[])
    : []
  const sponsors: Sponsor[]  = Array.isArray(td?.sponsors) ? (td!.sponsors as Sponsor[]) : []
  const namedSpeakers = speakers.filter(s => s.name?.trim())
  const namedSponsors = sponsors.filter(s => s.name?.trim())
  const agendaItems   = agenda.filter(a => a.title?.trim())

  // Group agenda by date
  const agendaByDate = agendaItems.reduce<Record<string, AgendaSession[]>>((acc, s) => {
    const d = s.date || 'TBD'
    ;(acc[d] = acc[d] ?? []).push(s)
    return acc
  }, {})

  // Group sponsors by tier
  const sponsorsByTier = namedSponsors.reduce<Record<string, Sponsor[]>>((acc, s) => {
    const t = s.tier || 'partner'
    ;(acc[t] = acc[t] ?? []).push(s)
    return acc
  }, {})

  const registrationRules = formData?.registrationRules as RegistrationRules | undefined
  const approvalMode = registrationRules?.approvalMode ?? (acData?.confirmationMode as string | undefined) ?? 'auto'
  const waitlistOn   = registrationRules?.waitlistEnabled ?? false

  const dateStr = startDate
    ? [startDate, startTime && startTime, endDate && endDate !== startDate && `– ${endDate}`, endTime && endTime].filter(Boolean).join(' ')
    : ''

  const viewportWidths = { desktop: 'max-w-[1280px]', tablet: 'max-w-[768px]', mobile: 'max-w-[390px]' }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-muted/20"
      role="dialog"
      aria-modal="true"
      aria-label="Event page preview"
    >
      {/* Preview toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex size-6 items-center justify-center rounded-full bg-primary/10">
            <Eye className="size-3.5 text-primary" aria-hidden />
          </div>
          <p className="text-[13px] font-semibold text-foreground">Event Page Preview</p>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[12px] font-semibold text-amber-700">Preview only</span>
        </div>
        {/* Viewport switcher */}
        <div className="hidden items-center gap-1 sm:flex">
          {(['desktop', 'tablet', 'mobile'] as const).map(vp => (
            <button
              key={vp}
              type="button"
              onClick={() => setViewport(vp)}
              className={cn(
                'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                viewport === vp ? 'bg-primary/10 text-primary' : 'hover:bg-muted/40',
              )}
              aria-label={`${vp} view`}
            >
              {vp === 'desktop' ? <Globe className="size-3.5" aria-hidden /> : vp === 'tablet' ? <ArrowUpDown className="size-3.5" aria-hidden /> : <MoreHorizontal className="size-3.5" aria-hidden />}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted/40"
          aria-label="Close preview"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {/* Scrollable preview area */}
      <div className="flex-1 overflow-y-auto bg-muted/10">
        <div className={cn('mx-auto w-full transition-all duration-300 bg-background shadow-sm', viewportWidths[viewport])}>

          {/* -- HERO --------------------------------------------------------- */}
          <div className="relative">
            {/* Banner */}
            <div className="relative h-[220px] w-full overflow-hidden bg-gradient-to-br from-primary/20 via-primary/10 to-transparent sm:h-[340px]">
              {bannerUrl
                ? <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
                : <div className="flex h-full flex-col items-center justify-center gap-2 opacity-40"><Upload className="size-10 text-muted-foreground" /><p className="text-[12px] text-muted-foreground">No banner uploaded</p></div>
              }
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
              {/* Event type & visibility badges */}
              <div className="absolute left-4 top-4 flex items-center gap-2">
                {eventTypeId && (
                  <span className="rounded-full bg-white/15 px-2.5 py-1 text-[12px] font-medium capitalize text-white backdrop-blur-sm">
                    {eventTypeId}{eventSubtype ? ` · ${eventSubtype}` : ''}
                  </span>
                )}
              </div>
              {visibility && (
                <span className="absolute right-4 top-4 flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[12px] font-medium text-white backdrop-blur-sm">
                  {visibility === 'public' ? <Globe className="size-3" aria-hidden /> : <Lock className="size-3" aria-hidden />}
                  {visibility === 'public' ? 'Public' : 'Private'}
                </span>
              )}
            </div>

            {/* Hero info overlay at bottom of banner */}
            <div className="absolute bottom-0 left-0 right-0 px-5 pb-5">
              <div className="flex items-end gap-4">
                {/* Logo */}
                {logoUrl && (
                  <div className="shrink-0 overflow-hidden rounded-xl border-2 border-white/30 bg-white shadow-lg size-16 sm:size-20">
                    <img src={logoUrl} alt="Event logo" className="h-full w-full object-cover" />
                  </div>
                )}
                <div className="min-w-0">
                  <h1 className="text-[1.5rem] font-extrabold leading-tight tracking-tight text-white drop-shadow-sm sm:text-[2rem]">
                    {eventName}
                  </h1>
                  {tagline && <p className="mt-1 text-[13px] text-white/80">{tagline}</p>}
                </div>
              </div>
            </div>
          </div>

          {/* -- META BAR ----------------------------------------------------- */}
          <div className="border-b border-border bg-card px-5 py-3">
            <div className="flex flex-wrap items-center gap-3">
              {dateStr
                ? <span className="flex items-center gap-1.5 text-[14px] text-foreground"><Calendar className="size-3.5 shrink-0 text-primary" aria-hidden />{dateStr}{timezone && ` (${timezone})`}</span>
                : <span className="flex items-center gap-1.5 text-[13px] italic text-muted-foreground/50"><Calendar className="size-3.5 shrink-0" aria-hidden />Date not set</span>
              }
              <span className="text-border">·</span>
              {venueName
                ? <span className="flex items-center gap-1.5 text-[14px] text-foreground"><MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />{[venueName, venueCity, venueState].filter(Boolean).join(', ')}</span>
                : <span className="flex items-center gap-1.5 text-[13px] italic text-muted-foreground/50"><MapPin className="size-3.5 shrink-0" aria-hidden />Venue not set</span>
              }
            </div>
          </div>

          {/* -- MAIN LAYOUT --------------------------------------------------- */}
          <div className="grid gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">

            {/* -- LEFT COLUMN ------------------------------------------------ */}
            <div className="flex min-w-0 flex-col gap-8">

              {/* Event Overview */}
              {(shortDesc || fullDesc) && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">About this event</h2>
                  {shortDesc && <p className="mb-2 text-[13.5px] font-medium leading-relaxed text-foreground">{shortDesc}</p>}
                  {fullDesc  && <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{fullDesc}</p>}
                </section>
              )}
              {!shortDesc && !fullDesc && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">About this event</h2>
                  <div className="rounded-lg border border-dashed border-border p-5 text-center">
                    <p className="text-[12px] italic text-muted-foreground/50">No description added yet — go to Step 6 to add one.</p>
                  </div>
                </section>
              )}

              {/* Agenda / Schedule */}
              {showAgenda && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">Schedule & Agenda</h2>
                  {agendaItems.length > 0 ? (
                    <div className="flex flex-col gap-4">
                      {Object.entries(agendaByDate).map(([date, sessions]) => (
                        <div key={date}>
                          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{date !== 'TBD' ? date : 'Date TBD'}</p>
                          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                            {sessions.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? '')).map(session => (
                              <div key={session.id} className={cn('flex items-start gap-3 px-4 py-3.5', session.isBreak && 'bg-muted/20')}>
                                <div className="w-[70px] shrink-0 text-right">
                                  <p className="text-[12px] font-semibold text-primary">{session.startTime || '--:--'}</p>
                                  {session.endTime && <p className="text-[12px] text-muted-foreground">{session.endTime}</p>}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <p className="text-[13px] font-semibold text-foreground">{session.title}</p>
                                    {session.type && !session.isBreak && (
                                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[12px] font-medium text-primary">
                                        {SESSION_TYPE_LABELS[session.type as keyof typeof SESSION_TYPE_LABELS] ?? session.type}
                                      </span>
                                    )}
                                    {session.isBreak && <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[12px] font-medium text-muted-foreground">Break</span>}
                                  </div>
                                  {session.description && <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{session.description}</p>}
                                  {session.location && <p className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground"><MapPin className="size-3" aria-hidden />{session.location}</p>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-5 text-center">
                      <Clock className="mx-auto mb-1.5 size-6 text-muted-foreground/30" aria-hidden />
                      <p className="text-[12px] italic text-muted-foreground/50">No agenda sessions added yet</p>
                    </div>
                  )}
                </section>
              )}

              {/* Speakers */}
              {showSpeakers && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">Speakers</h2>
                  {namedSpeakers.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {namedSpeakers.map(spk => (
                        <div key={spk.id} className="flex gap-3 rounded-xl border border-border bg-card p-4">
                          {spk.photoUrl
                            ? <img src={spk.photoUrl} alt={spk.name} className="size-14 shrink-0 rounded-full object-cover" />
                            : <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[20px] font-bold text-primary">{spk.name.charAt(0).toUpperCase()}</div>
                          }
                          <div className="min-w-0 flex-1">
                            <p className="text-[13.5px] font-semibold text-foreground">{spk.name}</p>
                            {spk.title   && <p className="text-[12px] text-muted-foreground">{spk.title}</p>}
                            {spk.company && <p className="text-[13px] font-medium text-primary/80">{spk.company}</p>}
                            {spk.bio     && <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{spk.bio}</p>}
                            {(spk.social?.linkedin || spk.social?.twitter) && (
                              <div className="mt-2 flex gap-2">
                                {spk.social.linkedin && <span className="text-[12px] font-medium text-primary">LinkedIn</span>}
                                {spk.social.twitter  && <span className="text-[12px] font-medium text-primary">Twitter</span>}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-5 text-center">
                      <Users className="mx-auto mb-1.5 size-6 text-muted-foreground/30" aria-hidden />
                      <p className="text-[12px] italic text-muted-foreground/50">No speakers added yet</p>
                    </div>
                  )}
                </section>
              )}

              {/* Sponsors */}
              {showSponsors && namedSponsors.length > 0 && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">Sponsors</h2>
                  <div className="flex flex-col gap-4">
                    {(Object.entries(sponsorsByTier) as [string, Sponsor[]][]).map(([tier, list]) => (
                      <div key={tier}>
                        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{SPONSOR_TIER_LABELS[tier as keyof typeof SPONSOR_TIER_LABELS] ?? tier}</p>
                        <div className="flex flex-wrap gap-3">
                          {list.map(spo => (
                            <div key={spo.id} className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5">
                              {spo.logoUrl
                                ? <img src={spo.logoUrl} alt={spo.name} className="h-8 max-w-[80px] object-contain" />
                                : <div className="flex size-8 items-center justify-center rounded-lg bg-muted/50 text-[12px] font-bold text-muted-foreground">{spo.name.charAt(0)}</div>
                              }
                              <div>
                                <p className="text-[14px] font-semibold text-foreground">{spo.name}</p>
                                {spo.website && <p className="text-[12px] text-muted-foreground">{spo.website}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Gallery */}
              {showGallery && galleryImages.length > 0 && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">Gallery</h2>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {galleryImages.slice(0, 6).map((img, i) => (
                      <div key={i} className="aspect-square overflow-hidden rounded-xl bg-muted/30">
                        <img src={img.value} alt={`Gallery ${i + 1}`} className="h-full w-full object-cover" />
                      </div>
                    ))}
                    {galleryImages.length > 6 && (
                      <div className="aspect-square flex items-center justify-center rounded-xl bg-muted/30">
                        <p className="text-[13px] font-semibold text-muted-foreground">+{galleryImages.length - 6} more</p>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Venue Information */}
              <section>
                <h2 className="mb-3 text-[15px] font-bold text-foreground">Venue</h2>
                {venueType ? (
                  <div className="rounded-xl border border-border bg-card p-4">
                    {venueType === 'online' || venueType === 'hybrid' ? (
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-100">
                          <Globe className="size-5 text-blue-600" aria-hidden />
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">{online?.platform ? (ONLINE_PLATFORM_LABELS[online.platform] ?? online.platform) : 'Online Event'}</p>
                          {online?.meetingId && <p className="text-[12px] text-muted-foreground">Meeting ID: {online.meetingId}</p>}
                          {online?.revealAfterRegistration && <p className="mt-1 text-[13px] text-amber-600">Meeting link will be shared after registration</p>}
                          {online?.joinInstructions && <p className="mt-1.5 text-[12px] text-muted-foreground">{online.joinInstructions}</p>}
                        </div>
                      </div>
                    ) : null}
                    {(venueType === 'physical' || venueType === 'hybrid') && physical?.name && (
                      <div className={cn('flex items-start gap-3', (venueType === 'hybrid' && online?.platform) && 'mt-4 pt-4 border-t border-border')}>
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100">
                          <MapPin className="size-5 text-emerald-600" aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground">{physical.name}</p>
                          {venueAddr && <p className="text-[13px] text-muted-foreground">{venueAddr}</p>}
                          {physical.pincode && <p className="text-[12px] text-muted-foreground">Pincode: {physical.pincode}</p>}
                          {physical.instructions && <p className="mt-1.5 text-[12px] text-muted-foreground">{physical.instructions}</p>}
                          {showVenueMap && physical.mapsLink && (
                            <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/20 px-3 py-2 text-[13px] text-primary">
                            <div className="mt-3 flex items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-muted/20 px-3 py-2 text-[13px] text-primary"><MapPin className="size-3.5 shrink-0" aria-hidden /> View on Google Maps</div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-5 text-center">
                    <MapPin className="mx-auto mb-1.5 size-6 text-muted-foreground/30" aria-hidden />
                    <p className="text-[12px] italic text-muted-foreground/50">Venue not configured yet</p>
                  </div>
                )}
              </section>

              {/* Organizer Information */}
              {showOrgInfo && (
                <section>
                  <h2 className="mb-3 text-[15px] font-bold text-foreground">Organised by</h2>
                  {orgName ? (
                    <div className="flex items-start gap-4 rounded-xl border border-border bg-card p-4">
                      {orgLogo
                        ? <img src={orgLogo} alt={orgName} className="size-14 shrink-0 rounded-xl object-contain" />
                        : <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-[20px] font-bold text-primary">{orgName.charAt(0).toUpperCase()}</div>
                      }
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-bold text-foreground">{orgName}</p>
                        {orgEmail   && <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground"><Mail  className="size-3.5 shrink-0" aria-hidden />{orgEmail}</p>}
                        {orgPhone   && <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><Phone className="size-3.5 shrink-0" aria-hidden />{orgPhone}</p>}
                        {orgWebsite && <p className="flex items-center gap-1.5 text-[13px] text-primary"><Globe className="size-3.5 shrink-0" aria-hidden />{orgWebsite}</p>}
                        {showSocialLinks && org?.social && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {org.social.facebook  && <span className="text-[13px] font-medium text-primary">Facebook</span>}
                            {org.social.instagram && <span className="text-[13px] font-medium text-primary">Instagram</span>}
                            {org.social.linkedin  && <span className="text-[13px] font-medium text-primary">LinkedIn</span>}
                            {org.social.twitter   && <span className="text-[13px] font-medium text-primary">Twitter</span>}
                            {org.social.youtube   && <span className="text-[13px] font-medium text-primary">YouTube</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-5 text-center">
                      <p className="text-[12px] italic text-muted-foreground/50">Organizer info not set yet</p>
                    </div>
                  )}
                </section>
              )}

            </div>

            {/* -- RIGHT SIDEBAR ----------------------------------------------- */}
            <div className="flex flex-col gap-4 lg:self-start lg:sticky lg:top-4">

              {/* Registration Summary Card */}
              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <div className="border-b border-border bg-primary/[0.03] px-4 py-3">
                  <p className="text-[14px] font-bold text-foreground">Register Now</p>
                  {passes.length > 0 && !isFreeEvent && (
                    <p className="text-[12px] text-muted-foreground">Starting from {formatINR(minPassPrice)}</p>
                  )}
                </div>
                <div className="p-4">
                  {/* Available passes */}
                  {passes.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {passes.map(p => (
                        <div key={p.id} className="flex items-start justify-between rounded-lg border border-border px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-foreground">{p.name}</p>
                            {p.description && <p className="text-[12px] text-muted-foreground">{p.description}</p>}
                            {!p.unlimited && p.quantity != null && (
                              <p className="text-[12px] text-muted-foreground">{p.quantity} seats available</p>
                            )}
                          </div>
                          <span className="ml-2 shrink-0 text-[13px] font-bold text-primary">
                            {isFreeEvent ? 'FREE' : p.price === 0 ? 'Free' : formatINR(p.price ?? 0)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : isFreeEvent ? (
                    <div className="rounded-lg border border-emerald-200/60 bg-emerald-50/40 px-3 py-2.5 text-center">
                      <p className="text-[13px] font-semibold text-emerald-600">Free Entry</p>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-3 text-center">
                      <p className="text-[13px] italic text-muted-foreground/50">No passes configured yet</p>
                    </div>
                  )}

                  {/* Approval / waitlist indicators */}
                  {approvalMode === 'manual' && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/40 px-2.5 py-1.5">
                      <Clock className="size-3.5 shrink-0 text-amber-600" aria-hidden />
                      <p className="text-[13px] text-amber-700">Requires approval</p>
                    </div>
                  )}
                  {waitlistOn && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200/60 bg-blue-50/40 px-2.5 py-1.5">
                      <Users className="size-3.5 shrink-0 text-blue-600" aria-hidden />
                      <p className="text-[13px] text-blue-700">Waitlist enabled</p>
                    </div>
                  )}

                  <button
                    type="button"
                    disabled
                    className="mt-3 w-full cursor-default rounded-lg bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground opacity-60"
                  >
                    Register
                  </button>
                  <p className="mt-2 text-center text-[12px] text-muted-foreground/50">Preview only — not active</p>
                </div>

                {/* Registration open/close */}
                {(regOpen || regClose) && (
                  <div className="border-t border-border px-4 py-3 space-y-1">
                    {regOpen  && <div className="flex justify-between text-[13px]"><span className="text-muted-foreground">Opens</span><span className="font-medium text-foreground">{regOpen}</span></div>}
                    {regClose && <div className="flex justify-between text-[13px]"><span className="text-muted-foreground">Closes</span><span className="font-medium text-foreground">{regClose}</span></div>}
                  </div>
                )}
              </div>

            </div>
          </div>

          {/* -- BOTTOM CTA ---------------------------------------------------- */}
          <div className="border-t border-border bg-primary/[0.03] px-5 py-6 text-center">
            <p className="text-[15px] font-bold text-foreground">{passes.length > 0 ? `Join ${eventName}` : eventName}</p>
            {passes.length > 0 && !isFreeEvent && (
              <p className="mt-1 text-[13px] text-muted-foreground">Starting from {formatINR(minPassPrice)}</p>
            )}
            <button
              type="button"
              disabled
              className="mt-3 cursor-default rounded-xl bg-primary px-8 py-3 text-[14px] font-bold text-primary-foreground opacity-60"
            >
              Register Now
            </button>
            <p className="mt-2 text-[12px] text-muted-foreground/50">Preview only — registration not active</p>
          </div>

        </div>
      </div>
    </div>
  )
}

// --- Step 7 — Registration Form Preview Modal ---------------------------------

function FormPreviewModal({
  open,
  onClose,
  formData,
  pricingData,
  acData,
  isFreeEvent,
  passes,
}: {
  open:        boolean
  onClose:     () => void
  formData:    Record<string, unknown> | null
  pricingData: Record<string, unknown> | null
  acData:      Record<string, unknown> | null
  isFreeEvent: boolean
  passes:      EventPassFull[]
}) {
  if (!open) return null

  const sections   = (formData?.sections as FormSection[] | undefined) ?? []
  const fields     = (formData?.fields   as FormField[]   | undefined) ?? []
  const rules      = formData?.registrationRules as RegistrationRules | undefined

  const allFields  = sections.length > 0
    ? sections.flatMap(s => s.fields ?? []).filter(f => f.visible !== false)
    : fields.filter(f => f.visible !== false)
  const sectionList: Array<{ title: string; fields: FormField[] }> =
    sections.length > 0
      ? sections.map(s => ({ title: s.title, fields: (s.fields ?? []).filter(f => f.visible !== false) }))
      : allFields.length > 0 ? [{ title: 'Registration Details', fields: allFields }] : []

  const approvalMode   = (rules?.approvalMode   ?? (acData?.confirmationMode as string | undefined) ?? 'auto') as string
  const waitlistOn     = rules?.waitlistEnabled ?? false
  const isManualApproval = approvalMode === 'manual'

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Registration form preview"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex size-6 items-center justify-center rounded-full bg-violet-100">
            <FileSpreadsheet className="size-3.5 text-violet-600" aria-hidden />
          </div>
          <p className="text-[13px] font-semibold text-foreground">Registration Form Preview</p>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[12px] font-semibold text-amber-700">Read-only</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted/40"
          aria-label="Close preview"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl px-4 py-8">

          {/* Approval / waitlist banners */}
          {isManualApproval && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200/60 bg-amber-50/60 px-3.5 py-3">
              <Clock className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <div>
                <p className="text-[14px] font-semibold text-amber-700">Manual Approval Required</p>
                <p className="text-[13px] text-amber-600">
                  {rules?.pendingMessage?.trim() || 'Your registration will be reviewed by the organiser before confirmation.'}
                </p>
              </div>
            </div>
          )}
          {waitlistOn && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-blue-200/60 bg-blue-50/60 px-3.5 py-3">
              <Users className="mt-0.5 size-4 shrink-0 text-blue-600" aria-hidden />
              <div>
                <p className="text-[14px] font-semibold text-blue-700">Waitlist Enabled</p>
                <p className="text-[13px] text-blue-600">
                  If this event is full you will be added to the waitlist automatically.
                </p>
              </div>
            </div>
          )}

          {/* Pass selection */}
          {passes.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-2 text-[13px] font-bold text-foreground">Select Pass</h2>
              <div className="flex flex-col gap-2">
                {passes.map((p, i) => (
                  <label key={p.id} className="flex cursor-default items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
                    <div className={cn(
                      'flex size-[18px] items-center justify-center rounded-full border-2 transition-all',
                      i === 0 ? 'border-primary bg-primary' : 'border-border bg-background',
                    )}>
                      {i === 0 && <div className="size-2 rounded-full bg-white" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-foreground">{p.name}</p>
                      {p.description && <p className="text-[13px] text-muted-foreground">{p.description}</p>}
                    </div>
                    <span className="shrink-0 text-[13px] font-bold text-primary">
                      {isFreeEvent ? 'FREE' : p.price === 0 ? 'Free' : formatINR(p.price ?? 0)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {isFreeEvent && passes.length === 0 && (
            <div className="mb-6 rounded-xl border border-emerald-200/60 bg-emerald-50/40 px-4 py-3 text-center">
              <p className="text-[13px] font-semibold text-emerald-600">Free Event — No Ticket Required</p>
            </div>
          )}

          {/* Form sections */}
          {sectionList.length > 0 ? (
            <div className="flex flex-col gap-6">
              {sectionList.map((sec, si) => (
                <div key={si}>
                  {sec.title && (
                    <h2 className="mb-3 text-[13px] font-bold text-foreground">{sec.title}</h2>
                  )}
                  <div className="flex flex-col gap-3">
                    {sec.fields.map(field => (
                      <div key={field.id}>
                        <label className="mb-1 flex items-center gap-1 text-[14px] font-medium text-foreground">
                          {field.label}
                          {field.required && <span className="text-[12px] text-red-500" aria-hidden>*</span>}
                        </label>
                        {field.helperText && (
                          <p className="mb-1 text-[12px] text-muted-foreground">{field.helperText}</p>
                        )}
                        {(field.type === 'text' || field.type === 'email' || field.type === 'mobile' || field.type === 'number') && (
                          <div className="h-9 w-full cursor-default rounded-lg border border-border bg-muted/20 px-3 text-[12px] leading-9 text-muted-foreground/40">
                            {field.placeholder || `Enter ${field.label.toLowerCase()}…`}
                          </div>
                        )}
                        {field.type === 'textarea' && (
                          <div className="h-16 w-full cursor-default rounded-lg border border-border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground/40">
                            {field.placeholder || `Enter ${field.label.toLowerCase()}…`}
                          </div>
                        )}
                        {field.type === 'dropdown' && (
                          <div className="flex h-9 w-full cursor-default items-center rounded-lg border border-border bg-muted/20 px-3 text-[12px] text-muted-foreground/40">
                            Select an option
                          </div>
                        )}
                        {field.type === 'checkbox' && (
                          <div className="flex items-center gap-2">
                            <div className="size-4 rounded border border-border bg-muted/20" />
                            <span className="text-[12px] text-muted-foreground/40">{field.placeholder || field.label}</span>
                          </div>
                        )}
                        {field.type === 'radio' && field.options.length > 0 && (
                          <div className="flex flex-col gap-1.5">
                            {field.options.slice(0, 3).map(opt => (
                              <div key={opt} className="flex items-center gap-2">
                                <div className="size-4 rounded-full border border-border bg-muted/20" />
                                <span className="text-[12px] text-muted-foreground">{opt}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {field.type === 'date' && (
                          <div className="flex h-9 w-full cursor-default items-center rounded-lg border border-border bg-muted/20 px-3 text-[12px] text-muted-foreground/40">
                            MM / DD / YYYY
                          </div>
                        )}
                        {field.type === 'file' && (
                          <div className="flex h-9 w-full cursor-default items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 text-[12px] text-muted-foreground/40">
                            Choose file…
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <FileSpreadsheet className="mx-auto mb-2 size-8 text-muted-foreground/20" aria-hidden />
              <p className="text-[13px] font-medium text-muted-foreground/50">No form fields configured yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground/40">Go back to Step 5 to build your form</p>
            </div>
          )}

          {sectionList.length > 0 && (
            <button
              type="button"
              disabled
              className="mt-6 w-full cursor-default rounded-lg bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground opacity-70"
            >
              {isManualApproval ? 'Submit for Approval' : 'Complete Registration'}
            </button>
          )}
          <p className="mt-3 text-center text-[12px] text-muted-foreground/50">
            Read-only preview — form is not active
          </p>
        </div>
      </div>
    </div>
  )
}

// --- Step 7 — Terms & Conditions Modal ---------------------------------------

function TermsModal({
  open,
  onClose,
  onAccept,
}: {
  open:     boolean
  onClose:  () => void
  onAccept: (timestamp: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hasScrolled, setHasScrolled] = useState(false)

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      setHasScrolled(true)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Terms and Conditions"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-2xl"
        style={{ maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Shield className="size-5 text-primary" aria-hidden />
            <p className="text-[15px] font-bold text-foreground">RegisterDesk Terms &amp; Conditions</p>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/40" aria-label="Close">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Scrollable content */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-5 py-4 text-[13px] leading-relaxed text-muted-foreground"
        >
          <p className="mb-3 font-semibold text-foreground">Organizer Agreement — RegisterDesk Platform</p>
          <p className="mb-3">These Terms &amp; Conditions ("Agreement") govern your use of the RegisterDesk platform as an event organizer. By publishing an event, you agree to comply with all terms stated below.</p>

          <p className="mb-2 font-semibold text-foreground">1. Event Content</p>
          <p className="mb-3">You are solely responsible for the accuracy, legality, and completeness of all event information, including descriptions, dates, venue details, and pricing. RegisterDesk is not liable for any inaccuracies in organizer-submitted content.</p>

          <p className="mb-2 font-semibold text-foreground">2. Attendee Data</p>
          <p className="mb-3">You acknowledge that you will collect attendee personal data through the registration form. You agree to use this data solely for event management purposes and to comply with applicable data protection laws including India's DPDP Act 2023.</p>

          <p className="mb-2 font-semibold text-foreground">3. Event Compliance</p>
          <p className="mb-3">You confirm that your event complies with all applicable local, state, and national laws and regulations. You agree not to use the platform for events that are illegal, discriminatory, harmful, or violate community standards.</p>

          <p className="mb-2 font-semibold text-foreground">4. Cancellations &amp; Refunds</p>
          <p className="mb-3">You are responsible for communicating your refund and cancellation policy to attendees. RegisterDesk provides infrastructure for refund processing but final decisions on refunds are at your discretion unless mandated by law.</p>

          <p className="mb-2 font-semibold text-foreground">5. Platform Use</p>
          <p className="mb-3">You agree not to misuse the platform, attempt to circumvent fees, use automated systems to scrape data, or conduct activities that harm the platform or other users. Violation may result in suspension of your account without notice.</p>

          <p className="mb-2 font-semibold text-foreground">6. Intellectual Property</p>
          <p className="mb-3">You retain ownership of your event content. By uploading content to RegisterDesk, you grant RegisterDesk a non-exclusive license to display your content on the platform for the purpose of promoting and delivering your event.</p>

          <p className="mb-2 font-semibold text-foreground">7. Limitation of Liability</p>
          <p className="mb-3">RegisterDesk shall not be liable for any indirect, incidental, or consequential damages arising from your use of the platform. Our total liability in any matter is limited to fees paid in the preceding 30 days.</p>

          <p className="mb-2 font-semibold text-foreground">8. Governing Law</p>
          <p className="mb-3">This Agreement is governed by the laws of India. Any disputes shall be subject to the exclusive jurisdiction of courts in Bengaluru, Karnataka.</p>

          <p className="mb-2 font-semibold text-foreground">9. Amendments</p>
          <p className="mb-3">RegisterDesk reserves the right to amend these terms at any time. Continued use of the platform after amendments constitutes acceptance of the updated terms.</p>

          <p className="mt-4 text-[13px] text-muted-foreground/60">Last updated: June 2026 · RegisterDesk Pvt Ltd, Bengaluru, India</p>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border bg-muted/[0.03] px-5 py-4">
          {!hasScrolled && (
            <p className="mb-2 text-center text-[13px] text-amber-600">Please scroll to the bottom to accept</p>
          )}
          <div className="flex gap-2.5">
            <button type="button" onClick={onClose} className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 text-[13px]')}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!hasScrolled}
              onClick={() => onAccept(new Date().toISOString())}
              className={cn(
                buttonVariants({ variant: 'primary' }),
                'flex-1 gap-2 text-[13px]',
                !hasScrolled && 'cursor-not-allowed opacity-40',
              )}
            >
              <Check className="size-4" aria-hidden />
              I Accept
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// --- Step 7 — Commercial Agreement Modal -------------------------------------

function CommercialAgreementModal({
  open,
  onClose,
  onAccept,
  isFreeEvent,
  passes,
  feeModel,
}: {
  open:        boolean
  onClose:     () => void
  onAccept:    (timestamp: string) => void
  isFreeEvent: boolean
  passes:      EventPassFull[]
  feeModel:    FeeModel
}) {
  const feesCfg = useFeesConfig()
  const basePrice = !isFreeEvent && passes.length > 0
    ? Math.min(...passes.map(p => p.price ?? 0))
    : 500
  const fees = computeFeePreview(basePrice, feeModel, feeRatesFrom(feesCfg))

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="RegisterDesk Commercial Summary"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-card shadow-2xl"
        style={{ maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-xl bg-primary/10">
              <IndianRupee className="size-4 text-primary" aria-hidden />
            </div>
            <div>
              <p className="text-[14px] font-bold text-foreground">RegisterDesk Pricing</p>
              <p className="text-[12px] text-muted-foreground">What you pay and what you receive</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/40" aria-label="Close">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* Event type badge */}
          <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-border bg-muted/[0.04] px-4 py-3">
            <p className="text-[14px] font-semibold text-foreground">
              {isFreeEvent ? 'Free Event' : 'Paid Event'}
            </p>
            {isFreeEvent ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[12px] font-bold text-emerald-700">
                No fees — always free
              </span>
            ) : (
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[12px] font-bold text-primary">
                {FEE_MODEL_LABELS[feeModel]}
              </span>
            )}
          </div>

          {/* RD-FEE-02 — RegisterDesk's platform fee and the payment gateway's charge are SEPARATE
              charges: the gateway fee is the payment provider's, never RegisterDesk's. Both rates
              come from the live fee configuration (useFeesConfig → resolveFeeConfig), the same
              resolver checkout and settlement use. */}
          <div className="mb-5 rounded-xl border border-border bg-card p-4">
            <p className="mb-3 text-[12px] font-semibold text-foreground">RegisterDesk platform fee</p>
            <div className="flex flex-col gap-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Paid ticket sales</span>
                <span className="font-semibold text-foreground">
                  {feesCfg.platformFeePercent > 0
                    ? `${feesCfg.platformFeePercent}%${feesCfg.gstEnabled ? ' + GST' : ''}`
                    : 'No RegisterDesk platform fee'}
                </span>
              </div>
              {feesCfg.platformFeePercent > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GST on the platform fee</span>
                  <span className="font-semibold text-foreground">{feesCfg.gstEnabled ? `${feesCfg.gstPercent}%` : 'Not applicable'}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-2">
                <span className="text-muted-foreground">Free events</span>
                <span className="font-semibold text-emerald-600">Always free</span>
              </div>
            </div>
          </div>
          <div className="mb-5 rounded-xl border border-border bg-card p-4">
            <p className="mb-1 text-[12px] font-semibold text-foreground">Payment gateway charges</p>
            <p className="mb-3 text-[12px] text-muted-foreground">Charged separately by the payment provider — not by RegisterDesk.</p>
            <div className="flex justify-between text-[13px]">
              <span className="text-muted-foreground">Estimated per paid ticket</span>
              <span className="font-semibold text-foreground">{feesCfg.gatewayFeeEnabled ? `${feesCfg.gatewayFeePercent}%` : 'Not estimated'}</span>
            </div>
          </div>

          {/* Per-ticket example */}
          {!isFreeEvent && (
            <div className="mb-5 rounded-xl border border-border bg-card p-4">
              <p className="mb-3 text-[12px] font-semibold text-muted-foreground uppercase tracking-wider">
                Example — {formatINR(basePrice)} ticket
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col rounded-xl border border-violet-200/60 bg-violet-50/40 p-3.5">
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-violet-600">Attendee Pays</p>
                  <p className="mt-2 text-[1.6rem] font-extrabold text-violet-700">{formatINR(fees.attendeePays)}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">at checkout</p>
                </div>
                <div className="flex flex-col rounded-xl border border-emerald-200/60 bg-emerald-50/50 p-3.5">
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-emerald-600">You Receive</p>
                  <p className="mt-2 text-[1.6rem] font-extrabold text-emerald-700">{formatINR(fees.organizerGets)}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">per registration</p>
                </div>
              </div>
            </div>
          )}

          {/* Settlement timeline */}
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="mb-3 text-[12px] font-semibold text-foreground">Settlement Timeline</p>
            <div className="flex flex-col gap-0">
              {([
                { label: 'Event Ends',     sub: 'Registrations close'                },
                { label: 'Review',         sub: 'Within 24h of event end'            },
                { label: 'Bank Transfer',  sub: 'NEFT / RTGS to registered account'  },
                { label: 'Funds Received', sub: 'T+3 Business Days after event'      },
              ] as const).map(({ label, sub }, i, arr) => (
                <div key={label} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold',
                      i === arr.length - 1
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-muted/60 text-muted-foreground',
                    )}>
                      {i + 1}
                    </div>
                    {i < arr.length - 1 && <div className="my-0.5 h-4 w-px bg-border/60" />}
                  </div>
                  <div className={cn('min-w-0 pt-0.5', i < arr.length - 1 && 'pb-2')}>
                    <p className="text-[12px] font-semibold text-foreground">{label}</p>
                    <p className="text-[12px] text-muted-foreground">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border bg-muted/[0.03] px-5 py-4">
          <div className="flex gap-2.5">
            <button type="button" onClick={onClose} className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 text-[13px]')}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onAccept(new Date().toISOString())}
              className={cn(buttonVariants({ variant: 'primary' }), 'flex-1 gap-2 text-[13px]')}
            >
              <Check className="size-4" aria-hidden />
              I Agree to These Terms
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// --- Step 7 — Publish Confirmation Modal -------------------------------------

function PublishConfirmModal({
  open,
  onClose,
  onConfirm,
  report,
  eventName,
  eventTypeId,
  visibility,
  passes,
  isFreeEvent,
  isPublishing,
  feeModel,
  plan,
}: {
  open:         boolean
  onClose:      () => void
  onConfirm:    () => void
  report:       ReadinessReport
  eventName:    string
  eventTypeId:  string | null
  visibility:   string | null
  passes:       EventPassFull[]
  isFreeEvent:  boolean
  isPublishing: boolean
  feeModel:     FeeModel
  /**
   * RD-PUBLISH-PLAN — the License & Services plan for "Your Plan & Included Services": the step's
   * current server quote and switches. Absent on a path without that step; null fields render a
   * neutral "not available" state, never invented figures.
   */
  plan?:        (Pick<FinalPayContext, 'quote' | 'payg' | 'payablePaise' | 'covered'> & { capacityExplicit: boolean }) | null
}) {
  // RD-EVENT-33 — declared BEFORE the `!open` early return: a hook after it would be
  // conditional and violate rules-of-hooks. The modal is conditionally rendered by its
  // parent, so it unmounts on close and this resets naturally between attempts.
  const [acknowledged, setAcknowledged] = useState(false)

  if (!open) return null

  const regStatus = isFreeEvent
    ? 'Free — opens on publish'
    : passes.length > 0 ? `${passes.length} pass type${passes.length !== 1 ? 's' : ''}` : 'Not configured'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-confirm-title"
      aria-describedby="publish-confirm-desc"
      aria-label="Confirm publish"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="relative z-10 w-full max-h-[90vh] overflow-y-auto rounded-t-2xl bg-card shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-primary/10">
              <Zap className="size-4.5 text-primary" aria-hidden />
            </div>
            <div>
              {/* RD-EVENT-41 — ids referenced by the dialog's aria-labelledby/-describedby.
                  Verified missing at runtime: the dialog reported aria-labelledby: null, so a
                  screen reader announced it with no name. */}
              <p id="publish-confirm-title" className="text-[16px] font-bold text-foreground">Ready to submit?</p>
              {/* RD-REVIEW-02 — the publishing mode is admin-only, so this cannot promise "live immediately":
                  under manual approval (the default) the event waits for a RegisterDesk review. */}
              <p id="publish-confirm-desc" className="text-[13px] text-muted-foreground">Your event goes live after RegisterDesk approves it, or straight away if no review is needed.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">

          {/* Event summary */}
          <div className="overflow-hidden rounded-xl border border-border bg-muted/[0.03]">
            <div className="border-b border-border/40 px-4 py-2.5">
              <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Event Summary</p>
            </div>
            <div className="flex flex-col divide-y divide-border/40">
              {([
                { label: 'Event Name',   val: eventName || 'Untitled Event',                      cls: !eventName ? 'italic text-muted-foreground/50' : 'font-semibold text-foreground' },
                { label: 'Visibility',   val: visibility === 'public' ? 'Public' : visibility === 'private' ? 'Private' : '—', cls: 'font-medium text-foreground' },
                { label: 'Registration', val: regStatus,                                           cls: 'font-medium text-foreground' },
                { label: 'Fee Model',    val: isFreeEvent ? 'Free Event' : FEE_MODEL_LABELS[feeModel], cls: 'font-medium text-foreground' },
                { label: 'Settlement',   val: isFreeEvent ? 'N/A' : 'T+3 Business Days',           cls: 'font-medium text-foreground' },
              ] as Array<{ label: string; val: string; cls: string }>).map(({ label, val, cls }) => (
                <div key={label} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={cn('truncate text-right', cls)}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* RD-PUBLISH-PLAN — capacity and services, from the License & Services quote. */}
          {plan !== undefined && (
            <PublishPlanSection
              items={buildPlanSummary({
                quote: plan?.quote ?? null,
                flags: plan ? { whatsappEnabled: plan.payg.whatsappEnabled, certEnabled: plan.payg.certEnabled } : null,
                emailImplemented: isChannelImplemented('email'),
                smsImplemented:   isChannelImplemented('sms'),
                capacityExplicit: plan?.capacityExplicit === true,
              })}
              payablePaise={plan?.payablePaise ?? null}
              covered={plan?.covered === true}
            />
          )}

          {/* Blockers */}
          {report.blockers.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50/60 p-4">
              <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden />
              <div>
                <p className="text-[14px] font-semibold text-rose-700 mb-1.5">Publishing blocked</p>
                <ul className="flex flex-col gap-1">
                  {report.blockers.slice(0, 5).map((b, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[12px] text-rose-600">
                      <span className="size-1.5 shrink-0 rounded-full bg-rose-400" aria-hidden />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* What happens next */}
          {report.canPublish && (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="border-b border-border/40 px-4 py-2.5">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">What happens next?</p>
              </div>
              <div className="flex flex-col divide-y divide-border/40">
                {([
                  { icon: Clock,        text: 'If a review is required, RegisterDesk checks the event and notifies you of the decision' },
                  { icon: Globe,        text: 'Once live, the event page is reachable via your event link' },
                  { icon: Users,        text: 'Registrations open — attendees can sign up' },
                  { icon: Mail,         text: 'Confirmation emails activate — sent on every registration' },
                  { icon: TrendingUp,   text: 'Organizer dashboard tracking begins — real-time insights' },
                ] as Array<{ icon: LucideIcon; text: string }>).map(({ icon: Icon, text }) => (
                  <div key={text} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50">
                      <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
                    </div>
                    <p className="text-[14px] text-foreground">{text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RD-EVENT-33 — required acknowledgement, immediately before publishing.
              This does NOT replace the Terms acceptance on the Review page: that is consent
              to platform terms, this is confirmation that THIS event's configuration was
              reviewed. A native <input type="checkbox"> with a <label htmlFor> is used
              rather than the role="checkbox" button pattern used elsewhere in this file,
              because that pattern is what produced the unnamed-button defect fixed in
              RD-EVENT-23. Native semantics are free and correct. */}
          {report.canPublish && (
            <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 p-3">
              <input
                id="publish-acknowledge"
                type="checkbox"
                checked={acknowledged}
                onChange={e => setAcknowledged(e.target.checked)}
                disabled={isPublishing}
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
              />
              <label htmlFor="publish-acknowledge" className="text-[12.5px] leading-relaxed text-muted-foreground">
                I have reviewed this event and understand that publishing will make it
                available according to its visibility settings.
              </label>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3 pb-1 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isPublishing}
              className={cn(buttonVariants({ variant: 'outline' }), 'flex-1')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!report.canPublish || !acknowledged || isPublishing}
              className={cn(
                buttonVariants({ variant: 'primary' }),
                'flex-1 gap-2',
                (!report.canPublish || !acknowledged || isPublishing) && 'cursor-not-allowed opacity-50',
              )}
            >
              {isPublishing ? (
                <>
                  <RefreshCw className="size-4 animate-spin" aria-hidden />
                  Submitting…
                </>
              ) : (
                <>
                  <Zap className="size-4" aria-hidden />
                  Submit Event
                </>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// EA-4 S1 — identity-change confirmation. Shown ONLY when the publish endpoint returns a
// moderate-drift warning (409 IDENTITY_CONFIRMATION_REQUIRED). Confirming re-submits through
// the SAME publish path with confirmIdentityChange:true — it is not a separate publish flow.
function IdentityConfirmModal({
  open,
  governance,
  onConfirm,
  onCancel,
  isPublishing,
}: {
  open:         boolean
  governance:   PublishGovernanceInfo
  onConfirm:    () => void
  onCancel:     () => void
  isPublishing: boolean
}) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm event changes"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="relative z-10 w-full max-h-[90vh] overflow-y-auto rounded-t-2xl bg-card shadow-2xl sm:max-w-md sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-amber-100">
              <AlertCircle className="size-4.5 text-amber-600" aria-hidden />
            </div>
            <div>
              <p className="text-[16px] font-bold text-foreground">Confirm event changes</p>
              <p className="text-[13px] text-muted-foreground">This event was previously published.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPublishing}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            You&apos;ve changed details that affect this event&apos;s identity. Publishing will update the
            live event under its existing license. Review the changes before you continue.
          </p>

          {governance.changedFields.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border bg-muted/[0.03]">
              <div className="border-b border-border/40 px-4 py-2.5">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Changed fields</p>
              </div>
              <ul className="flex flex-col divide-y divide-border/40">
                {governance.changedFields.map(field => (
                  <li key={field} className="px-4 py-2.5 text-[13px] text-foreground">{field}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3 pb-1 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={isPublishing}
              className={cn(buttonVariants({ variant: 'outline' }), 'flex-1')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPublishing}
              className={cn(buttonVariants({ variant: 'primary' }), 'flex-1 gap-2', isPublishing && 'cursor-not-allowed opacity-50')}
            >
              {isPublishing ? (
                <>
                  <RefreshCw className="size-4 animate-spin" aria-hidden />
                  Submitting…
                </>
              ) : (
                <>
                  <Zap className="size-4" aria-hidden />
                  Confirm &amp; Publish
                </>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// --- Step 7 view — Review & Publish ------------------------------------------


// StepCheck / StepSummary / ReadinessReport types → lib/events/builder/types.ts (RD-PRODUCT-01G Phase 4).

function buildReadinessReport(
  eventTypeId:  string | null,
  eventSubtype: string | null,
  visibility:   string | null,
  acData:       Record<string, unknown> | null,
  pricingData:  Record<string, unknown> | null,
  formData:     Record<string, unknown> | null,
  detailsData:  EventDetailsDraft | null,
): ReadinessReport {
  const steps: StepSummary[] = []
  let earned = 0

  // Step 1 — Event Type (10 pts)
  const hasType = !!eventTypeId
  const hasSub  = !!eventSubtype
  const s1 = hasType ? 10 : 0
  earned += s1
  steps.push({
    index: 0, name: 'Event Type', icon: Tag, earned: s1, max: 10,
    status: hasType ? 'complete' : 'missing',
    value:  eventTypeId ? `${eventTypeId}${eventSubtype ? ` · ${eventSubtype}` : ''}` : undefined,
    checks: [
      { label: 'Event type selected',  passed: hasType, required: true,  detail: eventTypeId    ?? undefined },
      { label: 'Subtype / discipline', passed: hasSub,  required: false, detail: eventSubtype   ?? undefined },
    ],
  })

  // Step 2 — Visibility (10 pts)
  const hasVis = !!visibility
  const s2 = hasVis ? 10 : 0
  earned += s2
  steps.push({
    index: 1, name: 'Visibility', icon: Globe, earned: s2, max: 10,
    status: hasVis ? 'complete' : 'missing',
    value:  visibility === 'public' ? 'Public Event' : visibility === 'private' ? 'Private Event' : undefined,
    checks: [
      { label: 'Visibility setting chosen', passed: hasVis, required: true,
        detail: visibility === 'public' ? 'Discoverable by anyone' : visibility === 'private' ? 'Invite-only' : undefined },
    ],
  })

  // Step 3 — Access Control (10 pts)
  const hasAcType   = !!(acData?.type)
  const hasConfMode = !!(acData?.confirmationMode)
  const s3 = !hasAcType ? 0 : hasConfMode ? 10 : 6
  earned += s3
  steps.push({
    index: 2, name: 'Access Control', icon: Shield, earned: s3, max: 10,
    status: hasAcType && hasConfMode ? 'complete' : hasAcType ? 'partial' : 'missing',
    value:  hasAcType ? String(acData!.type) : undefined,
    checks: [
      { label: 'Access type configured', passed: hasAcType,   required: true, detail: hasAcType   ? String(acData!.type)              : undefined },
      { label: 'Confirmation mode set',  passed: hasConfMode, required: true, detail: hasConfMode ? String(acData!.confirmationMode)  : undefined },
    ],
  })

  // Step 4 — Passes & Pricing (15 pts)
  const isFreeEv    = pricingData?.eventType === 'free'
  const rawPasses   = (pricingData?.passes as EventPassFull[] | undefined) ?? []
  const namedPasses = rawPasses.filter(p => p.name?.trim())
  const hasPricType = !!(pricingData?.eventType)
  const hasPasses   = namedPasses.length > 0
  const s4 = !hasPricType ? 0 : hasPasses ? 15 : 5
  earned += s4
  steps.push({
    index: 3, name: 'Passes & Pricing', icon: Ticket, earned: s4, max: 15,
    status: hasPricType && hasPasses ? 'complete' : hasPricType ? 'partial' : 'missing',
    value:  hasPasses ? `${namedPasses.length} pass type${namedPasses.length !== 1 ? 's' : ''}` : undefined,
    checks: [
      { label: 'Event pricing model set', passed: hasPricType, required: true, detail: isFreeEv ? 'Free event' : 'Paid event' },
      { label: 'At least one pass created',
        passed: hasPasses, required: true,
        detail: hasPasses ? `${namedPasses.length} pass type(s)` : 'No passes created yet' },
    ],
  })

  // Step 5 — Registration Form (15 pts)
  // A form is only complete when a template was selected OR at least one section (with
  // fields) exists. An empty {} draft initialiser must NOT count as configured.
  const formSections  = (formData?.sections as unknown[] | undefined) ?? []
  const formFields    = (formData?.fields   as unknown[] | undefined) ?? []
  const hasTemplate   = typeof (formData?.template) === 'string' && (formData.template as string).length > 0
  const hasFormData   = hasTemplate || formSections.length > 0
  const s5 = hasFormData ? 15 : 0
  earned += s5
  const formSummary = hasFormData
    ? (formFields.length > 0
        ? `${formFields.length} field${formFields.length !== 1 ? 's' : ''}`
        : `Template: ${(formData!.template as string)}`)
    : undefined
  steps.push({
    index: 4, name: 'Registration Form', icon: FileSpreadsheet, earned: s5, max: 15,
    status: hasFormData ? 'complete' : 'missing',
    value:  formSummary,
    checks: [
      { label: 'Form configured', passed: hasFormData, required: true,
        detail: hasFormData ? (formSummary ?? 'Configured') : 'No template or fields configured' },
    ],
  })

  // Step 6 — Event Details (40 pts via calcStepHealth)
  // Normalize before ANY access so partial Firestore docs never crash here.
  const safeDetails = detailsData ? normalizeEventDetailsDraft(detailsData) : null
  const health  = safeDetails ? calcStepHealth(safeDetails) : { score: 0, blockers: ['Event details not configured'], warnings: [] }
  const s6      = Math.round((health.score / 100) * 40)
  earned += s6
  const hasName   = !!(safeDetails?.info.name.trim())
  const hasDates  = !!(safeDetails?.schedule.startDate)
  const hasVenue  = !!(safeDetails?.venue.type)
  const hasOrg    = !!(safeDetails?.organizer.name.trim() && safeDetails?.organizer.email.trim())
  const hasBanner = !!(safeDetails?.media.coverBanner.value.trim())
  const hasSlug   = !!(safeDetails?.seo.urlSlug.trim())
  steps.push({
    index: 5, name: 'Event Details', icon: Calendar, earned: s6, max: 40,
    status: health.score >= 80 ? 'complete' : health.score > 0 ? 'partial' : 'missing',
    value:  safeDetails?.info.name.trim() || undefined,
    checks: [
      { label: 'Event name',       passed: hasName,   required: true  },
      { label: 'Dates & times',    passed: hasDates,  required: true  },
      { label: 'Venue configured', passed: hasVenue,  required: true  },
      { label: 'Organizer info',   passed: hasOrg,    required: true  },
      { label: 'Cover banner',     passed: hasBanner, required: false },
      { label: 'URL slug',         passed: hasSlug,   required: false },
    ],
  })

  // Mandatory publish gate — the SHARED requirements (identical to the server's
  // validateEventPublish). canPublish and the Action Required list derive from
  // these, so the organizer can never reach payment with a required field the
  // server would reject still missing. `steps`/`score` remain the readiness
  // quality display only (optional checks feed the score, not the gate).
  // RD-EVENT-21 — consume the shared summary rather than re-deriving it.
  //
  // This previously called `evaluatePublishRequirements` and then hand-rolled `failed`,
  // `blockers` and `canPublish` — a SECOND implementation of the rollup that
  // `validatePublish()` already performs, and the one the server publish gate uses. Two
  // implementations of "can this event publish" is exactly the divergence risk the shared
  // engine exists to remove.
  //
  // `canPublish` is now the engine's, which counts CRITICAL findings only. Every shipped
  // requirement is critical, so this is identical to the previous `failed.length === 0`.
  const summary = validatePublish({
    pricing:          pricingData,
    eventDetails:     detailsData as unknown as Record<string, unknown> | null,
    registrationForm: formData,
  })
  // RD-CE-FIX H1 — the server's VALUE rules (dates in order, sane prices/quantities/limits/windows,
  // a form for THIS event type), from the SAME function the publish gate runs, so every value blocker
  // shows here BEFORE payment and the server can never refuse what Review passed.
  const valueReqs = publishValueIssues({
    eventDetails: detailsData, pricing: pricingData, registrationForm: formData, eventType: eventTypeId, eventSubtype,
  }).map(i => ({
    id: i.id, severity: 'critical' as const, passed: false, title: i.title, description: i.message,
    stepName: i.stepName, stepIndex: i.stepIndex,
  }))
  // RD-CE-FIX (audit M2) — "Publishing blocked" lists CRITICAL findings only; warnings and
  // suggestions keep their own lists and never read as blockers.
  const valueBlockers = valueReqs.map(toPublishBlocker)
  const blockers = [...summary.blockers, ...valueBlockers].map(b => `${b.step}: ${b.title}`)
  // Readiness-quality warnings (optional checks that feed the score) are a DIFFERENT axis
  // from `summary.warnings` (requirement severity). Kept separate and unchanged — merging
  // them would put score-quality hints into the publish-gating list.
  const warnings = steps.flatMap(s => s.checks.filter(c => !c.required && !c.passed).map(c => `${s.name}: ${c.label}`))

  return {
    score: Math.min(100, Math.round(earned)),
    steps,
    requirements: [...summary.requirements, ...valueReqs],
    blockers,
    warnings,
    canPublish: summary.canPublish && valueReqs.length === 0,
    // RD-EVENT-20 taxonomy, surfaced for the Review UI. Never re-categorised here.
    sections:   summary.sections,
    findings:   {
      critical:   [...summary.blockers, ...valueBlockers],
      warning:    summary.warnings,
      suggestion: summary.suggestions,
    },
  }
}



// RD-EVENT-COMMERCE-02 · Review & Submit. It takes NO money: the activation fee is paid on
// License & Services. Review shows the readiness report, the summary of every step, the
// fee-collection choice, the server's activation state and the publish agreement, and submits.
function Step7View({
  currentStep, completedValues, onNext, onBack, initialData, onGoToStep, wizardSteps,
  onSettle, phase = 'review', renderLicense, onServerSaved, onFeeModelChange,
}: StepViewProps & {
  /** RD-EVENT-COMMERCE-05D — called after the SERVER confirmed Save Changes (re-align the draft baseline). */
  onServerSaved?: () => void
  /**
   * RD-EVENT-COMMERCE-05B — the new-event wizard ends Review → License & Services.
   *   review  Step 7: the event's information ONLY (readiness, summary, warnings, preview). No
   *           payment, no order, no submission, no Fee Collection Method (05C) — its action is
   *           "Continue" to License & Services. (An already-PUBLISHED event — opened through
   *           "Edit event" on the same route — keeps its legitimate "Save Changes" here.)
   *   final   Step 8, NEW drafts only: License & Services (rendered by `renderLicense`) followed
   *           by the Fee Collection Method (05C), the publish agreement and the ONE final action —
   *           "Pay & Publish Event" (verified payment, then publishing) or "Publish Event".
   */
  phase?: 'review' | 'final'
  /** final only — renders License & Services, wired to report its payment context. */
  renderLicense?: (onContext: (ctx: FinalPayContext) => void) => React.ReactNode
  /**
   * Flushes and awaits every queued draft write (useDraft.settle). The server reads the
   * DRAFT when it prices and publishes, so submitting before a pending autosave lands would
   * publish something other than what the organizer just reviewed. Resolves false when the
   * writes could not be confirmed — submission is then refused, never attempted.
   */
  onSettle?: () => Promise<boolean>
  /**
   * RD-FEE-RESTORE-01/02 — persists the organizer's Fee Collection Method.
   *
   * Resolves FALSE when nothing was saved, so the caller restores the previous selection rather
   * than showing a choice the server does not have. For a PUBLISHED event this goes through
   * PATCH /edit (draft + live in one batch); for a draft it writes the draft, and publish carries
   * it across.
   */
  onFeeModelChange?: (m: FeeModel) => Promise<boolean>
}) {
  // RD-EVENT-26 — which wizard this Review belongs to, read off the step list this view was
  // already given. Derived from the registry's own titles rather than a step count or a new
  // prop, so inserting a step cannot silently pick the wrong flow.
  const reviewWizardFlow: WizardFlow =
    (wizardSteps ?? WIZARD_STEPS).some(s => s.name === 'Fundraising') ? 'fundraising' : 'standard'

  const draftId      = (initialData?.draftId          as string | null) ?? null
  const draftStatus  = (initialData?.status           as string | null) ?? null
  const eventTypeId  = (initialData?.eventType        as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype     as string | null) ?? null
  const visibility   = (initialData?.visibility       as string | null) ?? null
  const acData       = (initialData?.accessControl    as Record<string, unknown> | null) ?? null
  const pricingData  = (initialData?.pricing          as Record<string, unknown> | null) ?? null
  const formData     = (initialData?.registrationForm as Record<string, unknown> | null) ?? null
  const detailsData  = (initialData?.eventDetails     as EventDetailsDraft | null) ?? null

  const isFreeEvent        = pricingData?.eventType === 'free'
  const isAlreadyPublished = draftStatus === 'published'
  // RD-EVENT-COMMERCE-02 — 'pending_review' is SUBMITTED too (awaiting approval): it is neither a
  // draft that may be submitted again nor a published event that may Save Changes.
  const isSubmitted        = isSubmittedDraftStatus(draftStatus)
  const isPendingReview    = draftStatus === 'pending_review'
  // RD-REVIEW-02 — a Super Admin requested changes: the legacy `status` still reads 'pending_review',
  // so the lifecycle field decides. Review's own action then submits the event for review again
  // (POST …/resubmit — a new review cycle; nothing is charged). The deadline is the SERVER's.
  const isChangesRequested = (initialData?.lifecycleStatus as string | null | undefined) === 'changes_requested'
  const reviewDeadlineRaw  = isChangesRequested ? readReviewDeadline(initialData?.reviewDeadline) : null
  const reviewDeadline     = reviewDeadlineRaw && reviewDeadlineRaw.cycleId === initialData?.reviewCycleId ? reviewDeadlineRaw : null
  const requestedChanges   = isChangesRequested && typeof initialData?.changesComment === 'string' ? initialData.changesComment : ''
  const reviewInSecondWindow = reviewDeadline !== null && reviewDeadline.phase === 'action_required'
  const reviewDueAtMs      = reviewDeadline !== null ? currentDueAt(reviewDeadline) : null

  // Build shareable event URL once — used by both the publish success screen
  // and the "Changes saved" banner.
  // RD-EVENT-44 — canonical public slug from the publish response. Null until published.
  // Declared here because `eventPath` below consumes it.
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null)

  const _slug     = (detailsData ? normalizeEventDetailsDraft(detailsData) : null)?.seo as Record<string, unknown> | null | undefined
  const eventSlug = _slug?.urlSlug as string | undefined
  // RD-EVENT-44 — order matters: the published slug wins, then the organizer's SEO slug
  // (pre-publish preview), and there is deliberately NO draftId fallback. A draft id is not a
  // public slug; linking to it produced a guaranteed 404 on the success screen.
  // RD-EVENT-46 — canonical builder; `/e/${slug}` was never a route and always 404'd.
  const eventPath = publishedSlug
    ? buildEventHref(publishedSlug)
    : eventSlug ? buildEventHref(eventSlug) : null
  const eventUrl  = eventPath
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${eventPath}`
    : null

  // Registration Form summary vars
  const rfTemplate  = typeof formData?.template  === 'string' ? (formData.template as string) : ''
  const rfSections  = Array.isArray(formData?.sections) ? (formData.sections as unknown[]) : []
  const rfFields    = Array.isArray(formData?.fields)   ? (formData.fields   as unknown[]) : []
  const hasFormConfigured = rfTemplate.length > 0 || rfSections.length > 0

  const eventName    = detailsData?.info?.name?.trim() ?? ''
  const passes       = ((pricingData?.passes as EventPassFull[] | undefined) ?? []).filter(p => p.name?.trim())
  const minPassPrice = passes.length > 0 ? Math.min(...passes.map(p => p.price ?? 0)) : 0

  // Any unlimited-capacity pass makes revenue/capacity estimates meaningless
  const hasUnlimitedCapacity = !isFreeEvent && passes.some(p => p.unlimited || p.quantity == null)
  // null signals "cannot be computed" — never substitute 100 or any platform cap
  const maxRevenue: number | null = hasUnlimitedCapacity ? null : passes.reduce((s, p) => s + ((p.price ?? 0) * (p.quantity ?? 0)), 0)

  const report = buildReadinessReport(
    eventTypeId, eventSubtype, visibility, acData, pricingData, formData, detailsData,
  )

  const [termInfo,        setTermInfo]        = useState(false)
  const [feesAcceptedAt,  setFeesAcceptedAt]  = useState<string | null>(null)
  const termsFees = feesAcceptedAt !== null

  const [publishState,     setPublishState]     = useState<'idle' | 'publishing' | 'published'>('idle')
  // EA-4 S1 identity governance: when the publish endpoint returns a moderate
  // identity-change warning (409 IDENTITY_CONFIRMATION_REQUIRED), we surface the changed
  // fields here and re-submit through the SAME publish path with confirmIdentityChange:true.
  const [identityConfirm,  setIdentityConfirm]  = useState<PublishGovernanceInfo | null>(null)
  // Whether the submitted event went live ('published', auto mode) or is awaiting
  // admin approval ('pending_review', manual mode) — drives the success screen.
  const [submittedStatus,  setSubmittedStatus]  = useState<'published' | 'pending_review'>('published')
  const [saveChangesState, setSaveChangesState] = useState<'idle' | 'saving'>('idle')
  const [showEventPreview,    setShowEventPreview]    = useState(false)
  const [showPublishConfirm,  setShowPublishConfirm]  = useState(false)
  const [showCommercialModal, setShowCommercialModal] = useState(false)

  const [consentFeeModel,   setConsentFeeModel]   = useState(false)
  const [consentTimeline,   setConsentTimeline]   = useState(false)
  // Published events skip the publish-agreement gate — they already accepted on first publish.
  const allTermsAccepted = isAlreadyPublished || (isFreeEvent
    ? termInfo && consentFeeModel && consentTimeline
    : termInfo && termsFees && consentFeeModel && consentTimeline)
  // RD-EVENT-COMMERCE-05F — the SAME ticks, sent to the server (the draft purchase route and the
  // publish route both refuse without them). Only what the organizer ticked in THIS session —
  // never a stored or default value; the fee-policy item exists for paid events only.
  const publishAgreement = useMemo<PublishAgreementInput>(() => ({
    accurateInformation: termInfo,
    ...(isFreeEvent ? {} : { settlementFeePolicy: termsFees }),
    termsOfService:      consentFeeModel,
    privacyPolicy:       consentTimeline,
  }), [termInfo, isFreeEvent, termsFees, consentFeeModel, consentTimeline])

  // ── Interactive state — initialized from draft, persisted via onSaveDraft ──
  //
  // RD-FEE-RESTORE-01 — the Fee Collection Method is the organizer's choice again, gated on the
  // live pricing-engine flag.
  //
  // Initialisation, in order: the draft's RECORDED choice (`pricing.feeCollection`), else the
  // default for the current flag state. The legacy `pricing.feeModel` is deliberately NOT read —
  // it has never charged anybody, and seeding the control from it would show an organizer a
  // selection their event has never actually used (lib/fees/explicitFeeModel.ts).
  //
  // Flag OFF ⇒ SUPPORTED_FEE_MODEL and no control is rendered, exactly as before.
  const pricingEngineOn = useFeesConfig().pricingEngineEnabled === true
  const recordedFeeModel = readFeeCollection(pricingData)?.model ?? null
  const desiredFeeModel: FeeModel =
    !pricingEngineOn ? SUPPORTED_FEE_MODEL : (recordedFeeModel ?? DEFAULT_FEE_MODEL_WHEN_ENABLED)
  const [localFeeModel, setLocalFeeModel] = useState<FeeModel>(desiredFeeModel)

  // RD-FEE-RESTORE-04 · re-sync when the SOURCES arrive, not only on first mount.
  //
  // `useState`'s initialiser runs once, and both of its inputs start wrong and settle later:
  // `pricingEngineOn` comes from BusinessConfigProvider, whose state begins at the code defaults
  // (pricingEngineEnabled: false) and flips only after /api/config/public resolves; `pricingData`
  // arrives with the draft. Mount before either lands and the control showed the fallback model
  // for the rest of the session — so a reload could display Organizer Absorbs on an event whose
  // stored record says Attendee Pays, which is the same class of lie as the ₹1 summary.
  //
  // Derived during render rather than in an effect (the idiom LicenseServicesStep already uses
  // for `grantKey`): an effect here would be a setState-in-effect cascade, which this file's
  // lint rules reject for good reason.
  //
  // `feeResyncHold` is what keeps it from fighting the organizer: while a save is pending the
  // optimistic selection must stand, or a slow round trip would snap the card back mid-request.
  const feeSourceKey = `${pricingEngineOn}|${recordedFeeModel ?? ''}`
  const [seenFeeSourceKey, setSeenFeeSourceKey] = useState(feeSourceKey)
  // STATE, not a ref: this is read during render to decide whether to re-sync, and a ref read
  // at render time is exactly what React forbids ("Cannot access refs during render") — it is
  // invisible to the renderer and wrong under concurrent rendering.
  const [feeResyncHold, setFeeResyncHold] = useState(false)
  if (feeSourceKey !== seenFeeSourceKey) {
    setSeenFeeSourceKey(feeSourceKey)
    if (!feeResyncHold) setLocalFeeModel(desiredFeeModel)
  }
  // The event's own cheapest PAID pass. `null` when there is none, which suppresses the
  // selector entirely rather than falling back to an invented sample ticket.
  const feeSamplePrice = useMemo(() => {
    const paid = ((pricingData?.passes as EventPassFull[] | undefined) ?? [])
      .map(p => p.price ?? 0)
      .filter(p => p > 0)
    return paid.length > 0 ? Math.min(...paid) : null
  }, [pricingData])
  // RD-EVENT-COMMERCE-02 — the service switches moved to License & Services; here they are
  // read-only facts of the draft.
  const localWhatsapp = !!pricingData?.whatsappEnabled

  // RD-COMMS-P1 — WhatsApp is sent only from WhatsApp capacity bought on License & Services (this
  // final step). There is no communication-balance top-up here any more: when WhatsApp is on but no
  // WhatsApp capacity is selected, the step simply says so (an advisory hint — never a payment).
  const prepaidWhatsapp = Math.max(0, Math.floor(Number((initialData?.serviceSelection as { whatsapp?: unknown } | null | undefined)?.whatsapp) || 0))
  const needsWhatsappCapacity = !isSubmitted && localWhatsapp && prepaidWhatsapp === 0

  // RD-EVENT-COMMERCE-02 · why the last submission failed, shown INLINE (a toast disappears).
  const [payNotice, setPayNotice] = useState<{ kind: 'failed'; message: string } | null>(null)

  // RD-EVENT-COMMERCE-05B · final step: the License & Services payment context (server quote),
  // the payment stage, and a guard so a double click / retry cannot start two payments.
  const [payCtx, setPayCtx]         = useState<FinalPayContext | null>(null)
  const [finalStage, setFinalStage] = useState<'paying' | null>(null)
  const finalInFlight = useRef(false)

  // Gate every submission on the draft being fully persisted (see `onSettle`).
  const settleDraft = useCallback(async (): Promise<boolean> => {
    if (!onSettle) return true
    const ok = await onSettle()
    if (!ok) {
      setPayNotice({ kind: 'failed', message: 'Your latest changes haven’t finished saving, so nothing was submitted. Check your connection and try again.' })
    }
    return ok
  }, [onSettle])

  const safeDetails = detailsData ? normalizeEventDetailsDraft(detailsData) : null

  const { showToast } = useToast()


  // ── Publish via API ────────────────────────────────────────────────────────
  const handlePublish = useCallback(() => {
    if (!allTermsAccepted || !report.canPublish || publishState !== 'idle') return
    // RD-EVENT-COMMERCE-05B — the final action needs a CURRENT server quote with nothing blocked.
    if (phase === 'final' && (!payCtx?.quoteReady || !!payCtx?.blockedReason || finalStage !== null)) return
    setShowPublishConfirm(true)
  }, [allTermsAccepted, report.canPublish, publishState, phase, payCtx, finalStage])

  const confirmPublishOnce = useCallback(async (confirmIdentityChange = false) => {
    if (publishState !== 'idle') return
    // ═══ RD-EVENT-COMMERCE-05B/05C · Pay & Publish Event ═══════════════════════════════════
    // Payment FIRST, and only a SERVER-VERIFIED payment continues to submission. Cancelled,
    // failed and still-verifying payments stop here with the event untouched (nothing is
    // submitted, nothing granted, nothing refunded). The publish route independently refuses
    // to submit an event whose capacity / services are not covered by PAID orders, so this is
    // never the only guard. A verified payment whose submission then fails is recoverable: the
    // coverage-aware quote reads "covered", the button becomes "Publish Event", no second charge.
    let paidNow = false
    if (phase === 'final') {
      if (finalInFlight.current) return
      if (payCtx && !payCtx.covered) {
        finalInFlight.current = true
        setShowPublishConfirm(false); setPayNotice(null); setFinalStage('paying')
        const outcome = await payCtx.pay(publishAgreement)
        setFinalStage(null); finalInFlight.current = false
        if (outcome !== 'paid') {
          setPayNotice({ kind: 'failed', message:
            outcome === 'cancelled' ? 'Payment cancelled — you were not charged and your event was not submitted. Your event and selections are saved; pay and submit whenever you’re ready.'
            : outcome === 'pending' ? 'Your payment is still being verified, so the event has not been submitted yet. Use “Refresh status” above in a moment — you will not be charged twice.'
            : outcome === 'busy'    ? 'A payment is already in progress.'
            : 'The payment did not complete, so your event was not submitted. Nothing further was charged — you can try again.' })
          payCtx.refresh()
          return
        }
        paidNow = true
      }
    }
    setPublishState('publishing')
    setShowPublishConfirm(false)
    if (!(await settleDraft())) { setPublishState('idle'); return }

    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch('/api/events/publish', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ draftId, confirmIdentityChange, agreement: publishAgreement }),
      })

      const json: PublishApiResponse = await res.json()

      if (!res.ok || !json.canPublish) {
        // RD-CLOSE — the 'WALLET_INSUFFICIENT' branch was removed: publishing never requires a
        // communication balance (the publish API has no such refusal), so it was unreachable and
        // described the retired "fund the wallet to publish" model.
        if (json.reason === 'AGREEMENT_REQUIRED') {
          // RD-EVENT-COMMERCE-05F — the server did not receive the Publish Agreement.
          setPayNotice({ kind: 'failed', message: json.error ?? 'Please accept the Publish Agreement before publishing.' })
          document.getElementById('publish-agreement')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setPublishState('idle')
        } else if (json.reason === 'EVENT_ALREADY_PUBLISHED') {
          setPublishState('published')
        } else if (json.reason === 'DRAFT_NOT_FOUND') {
          showToast('Draft not found. Please refresh the page and try again.', 'error')
          setPublishState('idle')
        } else if (json.reason === 'INCOMPLETE_REQUIRED_FIELDS' || json.reason === 'INVALID_EVENT_VALUES') {
          // Show the REAL missing field(s) the server reported (Phase 4/5) — never
          // a generic message unless the server sent no structured blockers.
          const first = json.blockers?.[0]
          showToast(
            first
              ? `${first.title} — ${first.description} (Step: ${first.step})`
              : 'Some required fields are missing. Please review your event details.',
            'error',
          )
          document.getElementById('publish-readiness')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          setPublishState('idle')
        } else if (json.reason === 'INVALID_TIMEZONE') {
          showToast('The event timezone is invalid. Please select a valid timezone in Schedule settings.', 'error')
          setPublishState('idle')
        } else if (json.reason === 'IDENTITY_CONFIRMATION_REQUIRED') {
          // Moderate identity drift on an already-baselined event. Surface the changed
          // fields and let the organizer confirm; confirming re-runs THIS same publish
          // path with confirmIdentityChange:true (one authoritative confirmation sequence).
          setPublishState('idle')
          setIdentityConfirm(json.governance ?? {
            decision: 'warn', level: 'moderate', changedFields: [],
            requiresConfirmation: true, suggestDuplicate: false,
          })
        } else if (json.reason === 'IDENTITY_CHANGED') {
          // Major identity drift — the server blocks republishing under the same license.
          setPublishState('idle')
          showToast(json.error ?? 'This event has changed too much to publish under the same license. Please duplicate it as a new event.', 'error')
        } else {
          showToast(json.error ?? 'Publish failed. Please try again.', 'error')
          setPayNotice({ kind: 'failed', message: json.error ?? 'The event could not be submitted. Please try again.' })
          setPublishState('idle')
        }
        if (paidNow) {
          // RD-EVENT-COMMERCE-05B — money is verified; only the submission failed. Say so plainly.
          setPayNotice({ kind: 'failed', message: `Payment verified — but the event could not be submitted yet (${json.error ?? json.reason ?? 'see the message above'}). Resolve it and select “Publish Event” — you will not be charged again.` })
          payCtx?.refresh()
        }
        return
      }

      // RD-EVENT-44 — the server's slug is the ONLY authority for the public URL.
      // `json.slug` was already returned and already typed; the client simply ignored it and
      // rebuilt the URL from draft data, falling back to draftId — a value that is never a
      // valid public slug, so Preview/Copy/Share 404'd for every event without a custom SEO slug.
      if (json.slug) setPublishedSlug(json.slug)
      setSubmittedStatus(json.lifecycleStatus === 'pending_review' ? 'pending_review' : 'published')
      onNext('Published', { publishedAt: json.publishedAt })
      setPublishState('published')
    } catch {
      showToast('Network error — check your connection and try again.', 'error')
      setPublishState('idle')
      if (paidNow) {
        setPayNotice({ kind: 'failed', message: 'Payment verified — but the submission could not reach the server. Select “Publish Event” to try again; you will not be charged again.' })
        payCtx?.refresh()
      }
    }
  }, [publishState, draftId, onNext, showToast, setIdentityConfirm, settleDraft, phase, payCtx, publishAgreement])

  // RD-CE-FIX (double publish) — React state alone could not stop a double click: both clicks saw
  // 'idle' in the same render and sent two submissions; the loser's ENTITLEMENT_ALREADY_USED then
  // landed as an error over the success screen. A ref makes the whole publish strictly one-at-a-time.
  const publishInFlight = useRef(false)
  const handleConfirmPublish = useCallback(async (confirmIdentityChange = false) => {
    if (publishInFlight.current) return
    publishInFlight.current = true
    try { await confirmPublishOnce(confirmIdentityChange) } finally { publishInFlight.current = false }
  }, [confirmPublishOnce])

  // RD-REVIEW-02 — Submit for review again, for an event whose changes were requested. Saved edits are
  // flushed first (the server reads the DRAFT), then the existing resubmit route validates, applies
  // the same identity governance as publishing, opens a new review cycle and ends the deadline. On a
  // refusal the organizer sees the server's own reason and nothing they saved is lost.
  const resubmitInFlight = useRef(false)
  async function handleResubmit(confirmIdentityChange = false) {
    if (resubmitInFlight.current || publishState !== 'idle' || !draftId) return
    resubmitInFlight.current = true
    setPublishState('publishing')
    try {
      if (!(await settleDraft())) { setPublishState('idle'); return }
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch(`/api/organizer/events/${encodeURIComponent(draftId)}/resubmit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmIdentityChange }),
      })
      const json = await res.json().catch(() => ({})) as {
        success?: boolean; error?: string; reason?: string
        blockers?: Array<{ title: string; description: string; step: string }>
        governance?: PublishGovernanceInfo
      }
      if (res.ok && json.success) {
        setSubmittedStatus('pending_review')
        setPublishState('published')
        return
      }
      setPublishState('idle')
      if (json.reason === 'IDENTITY_CONFIRMATION_REQUIRED') {
        setIdentityConfirm(json.governance ?? {
          decision: 'warn', level: 'moderate', changedFields: [], requiresConfirmation: true, suggestDuplicate: false,
        })
        return
      }
      const first = json.blockers?.[0]
      showToast(
        first ? `${first.title} — ${first.description} (Step: ${first.step})`
          : json.error ?? 'The event could not be submitted for review. Your changes are saved — please try again.',
        'error',
      )
    } catch {
      setPublishState('idle')
      showToast('Network error — your changes are saved. Check your connection and try again.', 'error')
    } finally {
      resubmitInFlight.current = false
    }
  }

  // ── Activation & services (RD-EVENT-COMMERCE-05B) ─────────────────────────────
  // Payment and submission now happen together on the FINAL step (License & Services), so
  // Review no longer quotes or reports activation. On the final step the gate is the embedded
  // License & Services' live server quote (`payCtx`); the publish route re-checks coverage.
  const reviewStepIndex = indexOfStep(reviewWizardFlow, 'review')

  // ── Save changes for already-published events ──────────────────────────────
  const saveInFlight = useRef(false)
  const handleSaveChanges = useCallback(async () => {
    // RD-EVENT-COMMERCE-05D — a ref, not only state: two clicks in the same tick both read 'idle'.
    if (saveChangesState !== 'idle' || saveInFlight.current) return
    saveInFlight.current = true
    setSaveChangesState('saving')
    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch(`/api/organizer/events/${draftId}/save-changes`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      })
      const json = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (!res.ok || json.success !== true) {
        // Nothing was saved; every edited value stays exactly as the organizer left it.
        showToast(json.error ?? 'Your changes couldn’t be saved. Nothing was changed — please try again.', 'error')
        return
      }
      // RD-EVENT-COMMERCE-05D — success ONLY after the server confirmed. save-changes also stamps the
      // draft's updatedAt, so re-align the local draft baseline (as after a publish); otherwise the
      // next autosave / reopen would read the server's newer stamp as a conflicting edit.
      onServerSaved?.()
      showToast('Changes saved successfully', 'success')
    } catch {
      showToast('We couldn’t reach the server, so your changes were not saved. Check your connection and try again.', 'error')
    } finally {
      saveInFlight.current = false
      setSaveChangesState('idle')
    }
  }, [saveChangesState, draftId, showToast, onServerSaved])

  const scoreGrade   = report.score >= 80 ? 'great' : report.score >= 50 ? 'fair' : 'poor'
  const scoreTextCls = scoreGrade === 'great' ? 'text-emerald-600' : scoreGrade === 'fair' ? 'text-amber-500' : 'text-rose-500'

  // -- Submitted success screen (draft → submitted for the first time) -------
  if (publishState === 'published' && !isAlreadyPublished) {
    const isPendingReview = submittedStatus === 'pending_review'

    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.45, ease: EASE }}
        className="flex min-h-full flex-col items-center justify-center gap-8 py-10 text-center"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.1, duration: 0.45, ease: EASE }}
          className={cn(
            'flex size-24 items-center justify-center rounded-full shadow-lg ring-8',
            isPendingReview ? 'bg-amber-50 ring-amber-100/50' : 'bg-emerald-50 ring-emerald-100/50',
          )}
        >
          <CheckCircle2 className={cn('size-12', isPendingReview ? 'text-amber-500' : 'text-emerald-500')} aria-hidden />
        </motion.div>

        <div className="max-w-sm">
          <h1 className="text-[1.4rem] font-bold tracking-tight text-foreground">
            {isPendingReview
              ? 'Event Submitted Successfully'
              : `${eventName || 'Your event'} is live!`}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
            {isPendingReview
              ? 'Status: Pending Approval. Your event has been submitted for review — you’ll be notified once an admin approves it and it goes live.'
              : isFreeEvent
                ? 'Your event is now accepting registrations.'
                : 'Your event is now accepting paid registrations.'}
          </p>
        </div>

        {/* Event URL copy row — only once live (hidden while pending approval) */}
        {!isPendingReview && eventUrl && (
          <div className="flex w-full max-w-md items-center gap-2 rounded-xl border border-border bg-muted/[0.04] px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{eventUrl}</p>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(eventUrl).catch(() => null) }}
              className={cn(buttonVariants({ variant: 'outline' }), 'shrink-0 gap-1.5 text-[12px]')}
            >
              <Copy className="size-3.5" aria-hidden />Copy Link
            </button>
          </div>
        )}

        {/* The Wallet's "Increase Limit" hand-off (lib/wallet/purchaseIntent): a draft's purchase is paid
            together with its submission, so the organizer sees this confirmation first, then returns to
            the same event's Wallet from here. (This screen only renders client-side, after a submit.) */}
        {(() => {
          const walletIntent = readIntent(draftId)
          return walletIntent ? (
            <Link href={walletIntent.returnTo} onClick={() => clearIntent()} className={cn(buttonVariants({ variant: 'primary' }), 'gap-1.5')}>
              {/* RD-PURCHASE-RETURN-01 — named after where it goes (Wallet / Certificates / Broadcasts). */}
              <ArrowLeft className="size-4" aria-hidden />{returnLabelFor(walletIntent.returnTo)}
            </Link>
          ) : null
        })()}

        {/* Action grid */}
        <div className="grid w-full max-w-md grid-cols-1 gap-3 sm:grid-cols-3">
          {([
            {
              icon: ExternalLink,
              label: 'Open Live Event',
              desc:  'View your event page',
              href:  eventUrl ?? ROUTES.DASHBOARD,
              external: !!eventUrl,
            },
            {
              icon: Users,
              label: 'Attendees',
              desc:  'Manage registrations',
              href:  ROUTES.DASHBOARD_ATTENDEES ?? ROUTES.DASHBOARD,
              external: false,
            },
            {
              icon: TrendingUp,
              label: 'Analytics',
              desc:  'Track performance',
              href:  ROUTES.DASHBOARD,
              external: false,
            },
          ] as Array<{ icon: LucideIcon; label: string; desc: string; href: string; external: boolean }>).map(({ icon: Icon, label, desc, href, external }) => (
            <Link key={label} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="flex flex-col items-center gap-2.5 rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-primary/30 hover:bg-primary/[0.02]">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
                <Icon className="size-4 text-primary" aria-hidden />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-foreground">{label}</p>
                <p className="text-[12px] text-muted-foreground">{desc}</p>
              </div>
            </Link>
          ))}
        </div>

        <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 text-left shadow-sm">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Next Steps</p>
          {[
            { icon: Award,      text: 'Share your event link on social media and email campaigns'  },
            { icon: UserCheck,  text: 'Review incoming registrations from your Attendees dashboard' },
            { icon: Settings2,  text: 'Edit event details anytime — changes apply immediately'     },
            { icon: TrendingUp, text: 'Monitor check-ins on event day via the Check-in panel'      },
          ].map(({ icon: Icon, text }, i) => (
            <div key={i} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                <Icon className="size-3.5 text-muted-foreground" aria-hidden />
              </div>
              <p className="text-[13px] leading-relaxed text-foreground">{text}</p>
            </div>
          ))}
        </div>

        <Link href={ROUTES.DASHBOARD} className={cn(buttonVariants({ variant: 'primary' }), 'gap-2')}>
          Go to Dashboard <ArrowRight className="size-4" aria-hidden />
        </Link>
      </motion.div>
    )
  }

  // -- Review & Submit ---------------------------------------------------------
  const stepsList   = wizardSteps ?? WIZARD_STEPS
  const stepContext = `Step ${currentStep + 1} of ${stepsList.length} · ${stepsList[currentStep]?.name ?? ''}`

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      {/* RD-EVENT-COMMERCE-05B — the final step is License & Services (it renders its own
          stepper and header); the agreement and the final action follow it below. */}
      {phase === 'final' && renderLicense?.(setPayCtx)}

      {phase === 'review' && <>
      <Link href={ROUTES.DASHBOARD}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
        <ArrowLeft className="size-4" aria-hidden />Back to Dashboard
      </Link>

      {/* RD-REVIEW-02 — what the Super Admin asked for, and the server-stored deadline. */}
      {isChangesRequested && (
        <div role="status" className="mb-4 space-y-2.5 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3.5">
          <p className="text-[13.5px] font-bold text-foreground">
            {reviewInSecondWindow ? 'Action required: update and resubmit this event' : 'Changes requested by RegisterDesk'}
          </p>
          {requestedChanges && (
            <p className="break-words text-[12.5px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{requestedChanges}</p>
          )}
          {reviewDueAtMs !== null && (
            <ReviewDeadlineCountdown
              dueAt={reviewDueAtMs}
              label={reviewInSecondWindow ? 'Closes automatically' : 'Changes due'}
              expiredText={reviewInSecondWindow
                ? 'The deadline has passed, so this event is being closed and can no longer be resubmitted.'
                : 'Submit soon: the event moves to Action Required, then closes 24 hours later.'}
            />
          )}
          <p className="text-[12px] text-muted-foreground">Make the changes in the steps above, then select “Submit for review” below.</p>
        </div>
      )}

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={stepsList} />

      {/* Header row with Preview button */}
      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">
            {isAlreadyPublished ? <>Review &amp; Save</> : 'Review'}
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isAlreadyPublished
              ? 'Review your changes and save to update your live event.'
              : 'Check your event’s information. Capacity, optional services, payment and submission come next, on License & Services.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowEventPreview(true)}
          className={cn(buttonVariants({ variant: 'outline' }), 'shrink-0 gap-1.5 text-[12px]')}
        >
          <Eye className="size-3.5" aria-hidden />
          Preview Event
        </button>
      </div>

      {/* Safety banner */}
      <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground/60">
        <Shield className="size-3 shrink-0" aria-hidden />
        Your event is safe. You can edit anytime before publishing.
      </p>

      {/* ── PUBLISH READINESS CARD ─────────────────────────────────────── */}
      {(() => {
        const completedCount = report.steps.filter(s => s.status === 'complete').length
        // Driven directly by the shared publish requirements (same source of
        // truth as the server), so EVERY mandatory blocker renders automatically
        // — no hardcoded per-field cards.
        const blockerItems = report.requirements.filter(r => !r.passed)
        return (
          <div id="publish-readiness" className="mt-4 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">

            {/* ── Header ── */}
            <div className="flex items-center justify-between px-5 py-4 sm:px-6">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
                  <CheckCircle2 className="size-4 text-primary" aria-hidden />
                </div>
                <p className="text-[15px] font-bold tracking-tight text-foreground">Publish Readiness</p>
              </div>
              {report.canPublish
                ? <span className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[12px] font-semibold text-emerald-700"><CheckCircle2 className="size-3" aria-hidden />Ready to publish</span>
                : <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-[12px] font-semibold text-amber-700"><AlertCircle className="size-3" aria-hidden />{blockerItems.length} issue{blockerItems.length !== 1 ? 's' : ''} remaining</span>
              }
            </div>

            {/* ── Score + progress bar ── */}
            <div className="border-t border-border/40 px-5 py-4 sm:px-6">
              <div className="mb-3 flex items-end gap-2">
                <span className={cn('text-[2.6rem] font-extrabold tabular-nums leading-none tracking-tight', scoreTextCls)}>
                  {report.score}
                </span>
                <span className="mb-1 text-[14px] font-medium leading-none text-muted-foreground/60">/ 100</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${report.score}%` }}
                  transition={{ duration: 0.8, ease: EASE }}
                  className="h-full rounded-full"
                  style={{
                    backgroundImage: report.canPublish
                      ? 'linear-gradient(90deg,#10b981,#34d399)'
                      : 'var(--primary-gradient)',
                  }}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-600">
                  <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                  {completedCount} section{completedCount !== 1 ? 's' : ''} complete
                </span>
                {blockerItems.length > 0 && (
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-amber-600">
                    <AlertCircle className="size-3.5 shrink-0" aria-hidden />
                    {blockerItems.length} issue{blockerItems.length !== 1 ? 's' : ''} remaining
                  </span>
                )}
              </div>
            </div>

            {/* ── Blocker action cards ── */}
            {/* RD-EVENT-25 — legacy "Action required" list REPLACED.
                It rendered `report.requirements.filter(r => !r.passed)` — a fourth place that
                re-derived the failed set, with every issue styled identically regardless of
                whether it blocked publishing. The panel below consumes `report.findings`,
                which the engine has already split by severity. */}
            <div className="border-t border-border/40 px-5 pb-5 pt-4 sm:px-6">
              <PublishFindingsPanel findings={report.findings} onGoToStep={onGoToStep} />
            </div>

            {/* RD-EVENT-26 · Review Summary — presentation over the draft Step 7 already
                receives. The Publish card reads the shared `report`; nothing here
                recomputes readiness. Edit resolves its step via the registry. */}
            <div className="border-t border-border/40 px-5 pb-5 pt-4 sm:px-6">
              <ReviewSummary
                data={initialData ?? null}
                report={report}
                flow={reviewWizardFlow}
                onGoToStep={onGoToStep}
              />
            </div>

            {/* ── RD-EVENT-21 · Section Health ──
                Rendered straight from `report.sections`, which is the engine's
                `buildSectionHealth()` output. "Fix now" reuses the wizard's existing
                `onGoToStep`; no section→step mapping is duplicated here. */}
            {report.sections.length > 0 && (
              <div className="border-t border-border px-5 py-5 sm:px-6">
                <PublishSectionHealthGrid sections={report.sections} onGoToStep={onGoToStep} />
              </div>
            )}

            {/* ── All clear footer ── */}
            {report.canPublish && (
              <div className="flex items-center gap-2.5 border-t border-emerald-100/80 bg-emerald-50/40 px-5 py-3.5 sm:px-6">
                <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden />
                <p className="text-[13px] font-medium text-emerald-700">All checks passed — your event is ready to publish</p>
              </div>
            )}

          </div>
        )
      })()}
      </>}

      {/* RD-EVENT-COMMERCE-05B — final step: blockers are fixed on Review, not re-listed here. */}
      {phase === 'final' && !isSubmitted && !report.canPublish && (
        <div role="alert" className="mt-4 flex flex-wrap items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50/60 px-4 py-3.5">
          <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden />
          <p className="min-w-0 flex-1 text-[12.5px] text-rose-700">
            {report.requirements.filter(r => !r.passed).length} required item{report.requirements.filter(r => !r.passed).length === 1 ? '' : 's'} must be completed before this event can be submitted.
          </p>
          {onGoToStep && reviewStepIndex >= 0 && (
            <button type="button" onClick={() => onGoToStep(reviewStepIndex)} className={cn(buttonVariants({ variant: 'outline' }), 'shrink-0 text-[12px]')}>
              Go to Review
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {/* RD-PHASE4-S3 · Q1 — the Fee Collection Method card is removed (fee collection is fixed to
            organizer-pays). The informational Easy Split notice keeps its place: paid events, final step. */}
        {/* RD-FEE-RESTORE-01 — the selector sits where it always did: final phase, PAID events only.
            `!isFreeEvent` is the guard whose absence was the original defect — a free event showed
            a fee comparison for a ticket nobody buys. `pricingEngineOn` is the live flag; with it
            off this renders nothing and the Easy Split notice below keeps the slot unchanged.
            `samplePrice` is the event's own cheapest paid pass — never an invented default. */}
        {/* RD-LICENSE-LOCK-01 — a SUBMITTED event's purchase surface is read-only until "Unlock
            to edit", and this control sits on that surface, so it obeys the same lock. The flag
            is reported up by LicenseServicesStep (payCtx.locked); it is false for an unpublished
            draft, which is never locked, so the new-event flow is untouched. */}
        {phase === 'final' && !isFreeEvent && pricingEngineOn && feeSamplePrice !== null && (
          <FeeCollectionSection
            feeModel={localFeeModel}
            // RD-LICENSE-LOCK-03 · fails CLOSED while the lock state is unknown.
            //
            // `payCtx` starts null and is only populated once LicenseServicesStep reports, so
            // `payCtx?.locked === true` was false for the first render(s) — a submitted event's
            // fee options were briefly live before the lock arrived. Reading it as "locked unless
            // explicitly told otherwise" removes that window; an unpublished draft is never
            // submitted, so it stays unlocked exactly as before.
            locked={isSubmitted && payCtx?.locked !== false}
            samplePrice={feeSamplePrice}
            // RD-FEE-RESTORE-02 — optimistic, then REVERTED if the server did not take it.
            // Leaving the card selected after a failed save is how the organizer came to believe
            // a choice was live when checkout had never seen it.
            onChange={m => {
              const previous = localFeeModel
              setLocalFeeModel(m)
              setFeeResyncHold(true)
              void (async () => {
                try {
                  const saved = await onFeeModelChange?.(m)
                  if (saved === false) {
                    setLocalFeeModel(previous)
                    showToast('That fee setting could not be saved. Nothing was changed — please try again.', 'error')
                  }
                } finally {
                  // Cleared in `finally`: a throw that left this set would freeze the re-sync
                  // above for the rest of the session.
                  setFeeResyncHold(false)
                }
              })()
            }}
          />
        )}
        {phase === 'final' && !isFreeEvent && <EasySplitNotice />}

        {/* RD-COMMS-P1 — WhatsApp needs WhatsApp capacity from this step (no wallet top-up). */}
        {phase === 'final' && needsWhatsappCapacity && (
          <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-3.5">
            <MessageSquare className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <p className="text-[12.5px] text-amber-800">
              WhatsApp messages are sent only from WhatsApp capacity. Add WhatsApp messages in License &amp; Services
              above — without capacity, attendees receive email only.
            </p>
          </div>
        )}

        {/* PUBLISH STATUS / LIVE STATUS */}
        {/* RD-EVENT-COMMERCE-05D — no live / pending status here: a submitted event's status (with
            View Live and Buy capacity or services) is the ONE banner on License & Services. This
            block is the NEW event's readiness on the final step only. */}
        {phase === 'review' || isSubmitted ? null : report.canPublish ? (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-200/60 bg-emerald-50/60 px-4 py-3.5 shadow-sm">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
            </div>
            <div>
              <p className="text-[13.5px] font-bold text-emerald-800">Ready to submit</p>
              <p className="text-[12px] text-emerald-700">
                {payCtx && !payCtx.covered
                  ? 'Select “Pay & Publish Event”: once RegisterDesk verifies your payment, your event is published — or sent for approval first if your account requires review.'
                  : 'When you submit, your event is published — or sent for approval first if your account requires review.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-rose-200/60 bg-rose-50/60 px-4 py-3.5 shadow-sm">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rose-100">
              <XCircle className="size-4 text-rose-500" aria-hidden />
            </div>
            <div>
              <p className="text-[13.5px] font-bold text-rose-700">Not Ready to Publish</p>
              <p className="text-[12px] text-rose-600">Complete the required sections above before publishing.</p>
            </div>
          </div>
        )}

        {payNotice && (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50/60 px-4 py-3.5">
            <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden />
            <p className="text-[12.5px] text-rose-700">{payNotice.message}</p>
          </div>
        )}

        {/* 4. PUBLISH AGREEMENT — draft events only */}
        {phase === 'final' && !isSubmitted && <div id="publish-agreement" role="group" aria-labelledby="publish-agreement-heading" className={cn(
          'scroll-mb-[calc(var(--wizard-footer-h,0px)+1rem)] overflow-hidden rounded-xl border shadow-sm transition-colors',
          allTermsAccepted ? 'border-emerald-200/60 bg-emerald-50/10' : 'border-border bg-card',
        )}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Shield className="size-3.5 text-muted-foreground" aria-hidden />
              <p id="publish-agreement-heading" className="text-[13px] font-semibold text-foreground">Publish Agreement</p>
            </div>
            <AnimatePresence>
              {allTermsAccepted && (
                <motion.span
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[12px] font-semibold text-emerald-700"
                >
                  <CheckCircle2 className="size-3" aria-hidden />Ready
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {/* RD-EVENT-COMMERCE-05F — what to do while anything is unticked (the final action is disabled). */}
          {!allTermsAccepted && (
            <p role="status" className="border-b border-border/40 px-4 py-2.5 text-[12px] text-muted-foreground">
              Required — tick every item below to enable “{payCtx && !payCtx.covered ? 'Pay & Publish Event' : 'Publish Event'}”.
            </p>
          )}
          <div className="flex flex-col divide-y divide-border/40 px-4">
            {/* 1: accurate */}
            <button type="button" onClick={() => setTermInfo(v => !v)} role="checkbox" aria-checked={termInfo}
              className="flex items-center gap-3 py-3.5 text-left focus-visible:outline-none">
              <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all',
                termInfo ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                {termInfo && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
              </span>
              <span className={cn('text-[13px]', termInfo ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                Event information is accurate and complete.
              </span>
            </button>

            {/* 2: settlement modal — paid events only */}
            {!isFreeEvent && (
              <div className="flex items-center gap-3 py-3.5">
                {/* RD-EVENT-23 — this checkbox had NO accessible name: its only content is an
                    aria-hidden icon, and its label is the sibling <p> below. The usual fixes
                    don't apply — that paragraph contains its own <button> ("settlement
                    timelines and fee policy"), so it can be neither a <label> wrapper nor a
                    child of this button, because nesting interactive elements is invalid.
                    `aria-labelledby` names it from the existing visible text instead, with no
                    duplicated string and no DOM restructure. The other two consent checkboxes
                    (3076, 3109) already get their name from content, so only this one differs. */}
                <button type="button"
                  onClick={() => termsFees ? setFeesAcceptedAt(null) : setShowCommercialModal(true)}
                  role="checkbox" aria-checked={termsFees}
                  aria-labelledby="terms-fees-label"
                  className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all focus-visible:outline-none',
                    termsFees ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                  {termsFees && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
                </button>
                <p id="terms-fees-label" className={cn('text-[13px]', termsFees ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  I understand{' '}
                  <button type="button" onClick={() => setShowCommercialModal(true)}
                    className="text-primary underline underline-offset-2 hover:no-underline">
                    settlement timelines and fee policy
                  </button>
                  .{feesAcceptedAt && <span className="ml-1.5 text-[12px] text-emerald-600">Reviewed ✓</span>}
                </p>
              </div>
            )}

            {/* 3: ToS — RD-EVENT-COMMERCE-05F: same wording; "Terms of Service" now opens the existing
                /terms page. A link can't sit inside the checkbox button, so the checkbox is named by
                its visible label (aria-labelledby), exactly like item 2. */}
            <div className="flex items-center gap-3 py-3.5">
              <button type="button" onClick={() => setConsentFeeModel(v => !v)} role="checkbox" aria-checked={consentFeeModel}
                aria-labelledby="terms-tos-label"
                className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
                  consentFeeModel ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                {consentFeeModel && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
              </button>
              <p id="terms-tos-label" className={cn('text-[13px]', consentFeeModel ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                I agree to RegisterDesk <a href={PUBLISH_AGREEMENT_DOCUMENTS.termsOfService} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">Terms of Service</a>.
              </p>
            </div>

            {/* 4: Privacy — same wording; "Privacy Policy" opens the existing /privacy page. */}
            <div className="flex items-center gap-3 py-3.5">
              <button type="button" onClick={() => setConsentTimeline(v => !v)} role="checkbox" aria-checked={consentTimeline}
                aria-labelledby="terms-privacy-label"
                className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
                  consentTimeline ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                {consentTimeline && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
              </button>
              <p id="terms-privacy-label" className={cn('text-[13px]', consentTimeline ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                I agree to RegisterDesk <a href={PUBLISH_AGREEMENT_DOCUMENTS.privacyPolicy} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">Privacy Policy</a>.
              </p>
            </div>
          </div>
        </div>}
      </div>

      {(publishState === 'publishing' || saveChangesState === 'saving' || finalStage === 'paying') && (
        <div role="status" className="flex items-center justify-center gap-2 py-3 text-[13px] text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" aria-hidden />
          {saveChangesState === 'saving' ? 'Saving changes…'
            : finalStage === 'paying' ? 'Waiting for your payment to be verified — the event is submitted only after verification…'
            : 'Payment verified. Submitting your event…'}
        </div>
      )}

      <EventPagePreviewModal
        open={showEventPreview}
        onClose={() => setShowEventPreview(false)}
        eventTypeId={eventTypeId}
        eventSubtype={eventSubtype}
        visibility={visibility}
        detailsData={safeDetails}
        pricingData={pricingData}
        formData={formData}
        acData={acData}
        isFreeEvent={isFreeEvent}
        passes={passes}
        minPassPrice={minPassPrice}
      />
      <AnimatePresence>
        {showCommercialModal && (
          <CommercialAgreementModal
            open={showCommercialModal}
            onClose={() => setShowCommercialModal(false)}
            onAccept={(ts) => { setFeesAcceptedAt(ts); setShowCommercialModal(false) }}
            isFreeEvent={isFreeEvent}
            passes={passes}
            feeModel={localFeeModel}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPublishConfirm && (
          <PublishConfirmModal
            open={showPublishConfirm}
            onClose={() => setShowPublishConfirm(false)}
            onConfirm={() => { void handleConfirmPublish() }}
            report={report}
            eventName={eventName}
            eventTypeId={eventTypeId}
            visibility={visibility}
            passes={passes}
            isFreeEvent={isFreeEvent}
            isPublishing={publishState === 'publishing'}
            feeModel={localFeeModel}
            plan={phase === 'final'
              ? (payCtx ? { ...payCtx, capacityExplicit: payCtx.capacityChosen || initialData?.registrationCapacitySaved === true } : null)
              : undefined}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {identityConfirm && (
          <IdentityConfirmModal
            open={!!identityConfirm}
            governance={identityConfirm}
            onCancel={() => setIdentityConfirm(null)}
            onConfirm={() => { setIdentityConfirm(null); void (isChangesRequested ? handleResubmit(true) : handleConfirmPublish(true)) }}
            isPublishing={publishState === 'publishing'}
          />
        )}
      </AnimatePresence>
      {phase === 'review' && isChangesRequested ? (
        // RD-REVIEW-02 — the event's own "Submit for review": resubmits the saved event (no payment).
        <WizardFooter
          onBack={onBack}
          onNext={() => { void handleResubmit() }}
          isFinalStep
          nextLabel={publishState === 'publishing' ? 'Submitting…' : 'Submit for review'}
          isNextDisabled={!report.canPublish || publishState !== 'idle'}
          stepContext={stepContext}
        />
      ) : phase === 'review' ? (
        // RD-EVENT-COMMERCE-05B — Review collects nothing: it continues to License & Services.
        // A LIVE event keeps "Save Changes" here (buying more is one click away, above).
        <WizardFooter
          onBack={onBack}
          onNext={isAlreadyPublished ? handleSaveChanges : () => onNext('Reviewed')}
          isFinalStep={isAlreadyPublished}
          nextLabel={isAlreadyPublished ? (saveChangesState === 'saving' ? 'Saving…' : 'Save Changes') : 'Continue'}
          isNextDisabled={isAlreadyPublished ? saveChangesState === 'saving' : false}
          // RD-EVENT-COMMERCE-05D — a live event's status, View Live and purchases are on License & Services.
          secondaryAction={isAlreadyPublished ? { label: 'License & Services', onClick: () => onNext(), disabled: saveChangesState === 'saving' } : undefined}
          stepContext={stepContext}
        />
      ) : isSubmitted ? null /* RD-EVENT-COMMERCE-05E — License & Services renders the ONE footer (Unlock / Pay / Done) */ : (
        <WizardFooter
          onBack={onBack}
          onNext={handlePublish}
          isFinalStep
          nextLabel={payCtx && !payCtx.covered ? 'Pay & Publish Event' : 'Publish Event'}
          isNextDisabled={
            // RD-CE-FIX M1 — the communication balance never gates publishing (it is a prompt above).
            isPendingReview || !allTermsAccepted || !report.canPublish || publishState !== 'idle'
              || !payCtx?.quoteReady || !!payCtx?.blockedReason || finalStage !== null
          }
          stepContext={stepContext}
        />
      )}
    </motion.div>
  )
}

// --- Campaign Publish Success --------------------------------------------------

function CampaignPublishSuccess({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const campaignUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/campaign/${slug}`
    : `/campaign/${slug}`

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(campaignUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not available — ignore
    }
  }

  return (
    <div className="rounded-xl border border-green-300 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/20">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-green-700 dark:text-green-400">
        <CheckCircle2 size={16} />
        Campaign published!
      </p>
      <p className="mt-1 text-[13px] text-green-600 dark:text-green-500 font-mono break-all">
        /campaign/{slug}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={`/campaign/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-700 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-green-800"
        >
          View Campaign <ExternalLink size={13} />
        </Link>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-white px-3 py-1.5 text-[13px] font-medium text-green-700 transition-colors hover:bg-green-50 dark:border-green-700 dark:bg-transparent dark:text-green-400"
        >
          {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
        <Link
          href={ROUTES.DASHBOARD}
          className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-white px-3 py-1.5 text-[13px] font-medium text-green-700 transition-colors hover:bg-green-50 dark:border-green-700 dark:bg-transparent dark:text-green-400"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}

// --- Donation Campaign Wizard -------------------------------------------------

type DonationPublishState = 'idle' | 'publishing' | 'success' | 'error'

function DonationCampaignWizard({
  eventSubtype,
  onBackToEventType,
}: {
  eventSubtype:       string | null
  onBackToEventType:  () => void
}) {
  const { draft, isLoading, updateDraft } = useCampaignDraft({
    campaignType: 'donation_only',
    eventSubtype: eventSubtype ?? undefined,
  })

  const [currentStep,     setCurrentStep]     = useState(0)
  const [completedValues, setCompletedValues] = useState<(string | undefined)[]>(
    Array(CAMPAIGN_WIZARD_STEPS.length).fill(undefined),
  )
  const [hydrated, setHydrated] = useState(false)

  // Track validation errors shown for each step
  const [showDetailsErrors,  setShowDetailsErrors]  = useState(false)
  const [showSettingsErrors, setShowSettingsErrors] = useState(false)

  // Controlled form state (synced into campaign draft on advance)
  const [campaignDetails,  setCampaignDetails]  = useState(makeBlankCampaignDetailsDraft())
  const [donationSettings, setDonationSettings] = useState(makeBlankDonationSettingsDraft())
  const [visibility, setVisibility]             = useState<'public' | 'private' | null>(null)

  // Publish flow
  const [publishState, setPublishState] = useState<DonationPublishState>('idle')
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null)
  const [publishError,  setPublishError]  = useState<string | null>(null)

  const { showToast } = useToast()

  useEffect(() => {
    if (isLoading || hydrated || !draft) return
    setCurrentStep(draft.currentStep ?? 0)
    setCompletedValues(
      (draft.completedValues ?? Array(CAMPAIGN_WIZARD_STEPS.length).fill(null)).map(
        v => (v as string | null | undefined) ?? undefined,
      ),
    )
    if (draft.campaignDetails)  setCampaignDetails(draft.campaignDetails)
    if (draft.donationSettings) setDonationSettings(draft.donationSettings)
    if (draft.visibility)       setVisibility(draft.visibility)
    setHydrated(true)
  }, [isLoading, draft, hydrated])

  const totalSteps = CAMPAIGN_WIZARD_STEPS.length

  function advance(label: string) {
    const nextStep   = Math.min(currentStep + 1, totalSteps - 1)
    const newValues  = completedValues.map((v, i) => (i === currentStep ? label : v))
    setCompletedValues(newValues)
    setCurrentStep(nextStep)
    void updateDraft({ currentStep: nextStep, completedValues: newValues.map(v => v ?? null) })
  }

  function goBack() {
    if (currentStep === 0) {
      onBackToEventType()
    } else {
      setCurrentStep(s => Math.max(s - 1, 0))
    }
  }

  async function handlePublish() {
    setPublishState('publishing')
    setPublishError(null)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Not authenticated')
      const token = await user.getIdToken()
      const res   = await fetch('/api/campaigns/publish', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ draftId: draft?.id }),
      })
      const json = await res.json() as { success: boolean; slug?: string; error?: string }
      if (!json.success) throw new Error(json.error ?? 'Publish failed')
      setPublishedSlug(json.slug ?? null)
      setPublishState('success')
      advance('Published')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Publish failed'
      setPublishError(msg)
      setPublishState('error')
      showToast(msg, 'error')
    }
  }

  if (!hydrated || isLoading) {
    return (
      <div className="flex min-h-full flex-col gap-5 pt-1" aria-busy="true">
        <div className="h-4 w-36 animate-pulse rounded-lg bg-muted/50" />
        <div className="h-[76px] animate-pulse rounded-xl bg-muted/30" />
        <div className="mt-1 h-7 w-52 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-44 animate-pulse rounded-xl bg-muted/30" />
      </div>
    )
  }

  const stepContext = `Step ${currentStep + 1} of ${totalSteps} · ${CAMPAIGN_WIZARD_STEPS[currentStep]?.name ?? ''}`

  // ── Step 0: Visibility ────────────────────────────────────────────────────
  if (currentStep === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="flex min-h-full flex-col"
      >
        <Link href={ROUTES.DASHBOARD}
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          <ArrowLeft className="size-4" aria-hidden />
          Back to Dashboard
        </Link>

        <Stepper currentStep={currentStep} completedValues={completedValues} steps={CAMPAIGN_WIZARD_STEPS} />

        <div className="mt-6">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Campaign Visibility</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Decide who can see and donate to your campaign.
          </p>
        </div>

        <div className="mt-5 grid flex-1 items-start gap-5 sm:grid-cols-2">
          {(['public', 'private'] as const).map(opt => (
            <button key={opt} type="button" onClick={() => setVisibility(opt)}
              className={cn(
                'flex flex-col gap-2 rounded-xl border-[1.5px] p-4 text-left transition-all duration-150',
                visibility === opt ? 'border-primary bg-primary/[0.03] shadow-sm' : 'border-border bg-card hover:border-primary/30',
              )}>
              <div className={cn('flex size-[16px] shrink-0 items-center justify-center rounded-full border-2', visibility === opt ? 'border-primary bg-primary' : 'border-border')}>
                {visibility === opt && <div className="size-[7px] rounded-full bg-white" />}
              </div>
              <p className="text-[15px] font-semibold text-foreground capitalize">{opt} Campaign</p>
              <p className="text-[13px] text-muted-foreground">
                {opt === 'public' ? 'Anyone with the link can donate' : 'Only people you share the link with can donate'}
              </p>
            </button>
          ))}
        </div>

        <WizardFooter
          onBack={goBack}
          onNext={() => {
            if (!visibility) return
            void updateDraft({ visibility })
            advance(visibility === 'public' ? 'Public Campaign' : 'Private Campaign')
          }}
          isNextDisabled={!visibility}
          stepContext={stepContext}
        />
      </motion.div>
    )
  }

  // ── Step 1: Campaign Details ──────────────────────────────────────────────
  if (currentStep === 1) {
    const detailsValid = validateStep('details', { draft: campaignDetails }).valid
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="flex min-h-full flex-col"
      >
        <Link href={ROUTES.DASHBOARD}
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          <ArrowLeft className="size-4" aria-hidden />
          Back to Dashboard
        </Link>

        <Stepper currentStep={currentStep} completedValues={completedValues} steps={CAMPAIGN_WIZARD_STEPS} />

        <div className="mt-6">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Campaign Details</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Tell donors your story and set your fundraising goal.</p>
        </div>

        <div className="mt-5 flex-1">
          <DonationCampaignDetailsBuilder
            draft={campaignDetails}
            onChange={patch => setCampaignDetails(prev => ({ ...prev, ...patch }))}
            showErrors={showDetailsErrors}
          />
        </div>

        <WizardFooter
          onBack={goBack}
          onNext={() => {
            if (!detailsValid) { setShowDetailsErrors(true); return }
            void updateDraft({ campaignDetails })
            advance(campaignDetails.basics.title || 'Campaign Details')
          }}
          isNextDisabled={showDetailsErrors && !detailsValid}
          stepContext={stepContext}
        />
      </motion.div>
    )
  }

  // ── Step 2: Donation Settings ─────────────────────────────────────────────
  if (currentStep === 2) {
    const settingsValid = isDonationSettingsValid(donationSettings)
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="flex min-h-full flex-col"
      >
        <Link href={ROUTES.DASHBOARD}
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          <ArrowLeft className="size-4" aria-hidden />
          Back to Dashboard
        </Link>

        <Stepper currentStep={currentStep} completedValues={completedValues} steps={CAMPAIGN_WIZARD_STEPS} />

        <div className="mt-6">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Donation Settings</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Configure how donors give and what they experience.</p>
        </div>

        <div className="mt-5 flex-1">
          <DonationSettingsBuilder
            draft={donationSettings}
            onChange={patch => setDonationSettings(prev => ({ ...prev, ...patch }))}
            showErrors={showSettingsErrors}
          />
        </div>

        <WizardFooter
          onBack={goBack}
          onNext={() => {
            if (!settingsValid) { setShowSettingsErrors(true); return }
            void updateDraft({ donationSettings })
            advance('Donation Settings')
          }}
          isNextDisabled={showSettingsErrors && !settingsValid}
          stepContext={stepContext}
        />
      </motion.div>
    )
  }

  // ── Step 3: Review & Publish ──────────────────────────────────────────────
  const blockers = getCampaignPublishBlockers(campaignDetails)
  const canPublish = blockers.length === 0 && !!visibility

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      <Link href={ROUTES.DASHBOARD}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={CAMPAIGN_WIZARD_STEPS} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">Review & Publish</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Check your campaign details before going live.</p>
      </div>

      <div className="mt-5 flex-1 space-y-4">
        {/* Summary cards */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-2">
          <p className="text-[14px] font-semibold text-foreground">Campaign</p>
          <p className="text-[15px] font-bold text-foreground">{campaignDetails.basics.title || '—'}</p>
          {campaignDetails.basics.tagline && (
            <p className="text-[13px] text-muted-foreground">{campaignDetails.basics.tagline}</p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm grid grid-cols-2 gap-3">
          <div>
            <p className="text-[12px] text-muted-foreground">Goal</p>
            <p className="text-[15px] font-semibold text-foreground">
              {campaignDetails.goal.targetAmountRupees
                ? `₹${campaignDetails.goal.targetAmountRupees.toLocaleString('en-IN')}`
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-[12px] text-muted-foreground">End Date</p>
            <p className="text-[15px] font-semibold text-foreground">{campaignDetails.goal.endDate || '—'}</p>
          </div>
          <div>
            <p className="text-[12px] text-muted-foreground">Visibility</p>
            <p className="text-[15px] font-semibold text-foreground capitalize">{visibility ?? '—'}</p>
          </div>
          <div>
            <p className="text-[12px] text-muted-foreground">80G</p>
            <p className="text-[15px] font-semibold text-foreground">
              {campaignDetails.taxConfig.enabled ? 'Enabled' : 'Not enabled'}
            </p>
          </div>
        </div>

        {/* Blockers */}
        {blockers.length > 0 && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-2">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
              <AlertCircle size={15} />
              Fix these before publishing
            </p>
            <ul className="space-y-1">
              {blockers.map(b => (
                <li key={b.field} className="text-[13px] text-destructive/80">· {b.message}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Publish success */}
        {publishState === 'success' && publishedSlug && (
          <CampaignPublishSuccess slug={publishedSlug} />
        )}

        {publishError && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-[13px] text-destructive">{publishError}</p>
          </div>
        )}
      </div>

      <WizardFooter
        onBack={goBack}
        onNext={handlePublish}
        nextLabel={publishState === 'publishing' ? 'Publishing…' : 'Publish Campaign'}
        isNextDisabled={!canPublish || publishState === 'publishing' || publishState === 'success'}
        stepContext={stepContext}
      />
    </motion.div>
  )
}

// --- License step (F2.1) ------------------------------------------------------

// RD-CAPACITY-01 · the step now sells REGISTRATION CAPACITY, not a tier.
//
// The tier cards are gone: there are no tiers, and every feature is included for every
// organizer. What the organizer chooses here is a number, and what they see is the server's
// own quote for it — the component fetches its figures rather than computing them, so the
// screen and the order it produces can never disagree about a price.
// RD-EVENT-COMMERCE-03 · LICENSE & SERVICES — capacity, WhatsApp, email, SMS, certificates, media,
// the itemized cost and the payment, for a draft AND for a submitted event, all on this ONE step.
// The step itself lives in components/wizard/LicenseServicesStep.tsx.
function LicenseStepView(props: LicenseServicesStepProps) {
  return <LicenseServicesStep {...props} />
}

// --- Wizard -------------------------------------------------------------------

export default function CreateEventWizard() {
  const {
    draft, isLoading, createDraft, updateDraft, autosaveDraft, flushNow, settle, markPublished, syncRenderState,
    saveState, lastSavedAt, hasUnsavedChanges, conflict, resolveConflict,
  } = useDraft()

  // RD-PRODUCT-01B: warn on tab close/reload while a save is pending or in flight.
  useUnsavedChangesWarning(hasUnsavedChanges, flushNow)
  // RD-CE-FIX (draft recovery) — bumped on every recovery choice to remount the step views.
  const [stepEpoch, setStepEpoch] = useState(0)

  // RD-CE-FIX (header/breadcrumb) — the header selector and breadcrumb show the GLOBALLY selected
  // event, which could be a different draft from the one open here ("Untitled Event" over a named
  // draft). The wizard selects the draft it is editing; a brand-new draft is not in the list yet, so
  // the list is refreshed once for it (never in a loop).
  const eventCtx = useEventContext()
  const refreshedForRef = useRef<string | null>(null)
  useEffect(() => {
    const id = draft?.id
    if (!id || eventCtx.loading || eventCtx.selectedEventId === id) return
    if (eventCtx.events.some(e => e.draftId === id)) { eventCtx.selectEvent(id); return }
    if (refreshedForRef.current !== id) { refreshedForRef.current = id; eventCtx.refresh() }
  }, [draft?.id, eventCtx])

  // RD-WIZARD-01 · …and once more whenever the SAVED name changes, so the header stops reading
  // "Untitled Event" for an event the organizer has already named (it only caught up on reload).
  // `draft` re-syncs at navigation and save points, never per keystroke, so this is one list read
  // per rename. Keyed on the name, so a refresh that returns the same name cannot loop.
  const draftNameRaw = (draft?.eventDetails as { info?: { name?: unknown } } | null | undefined)?.info?.name
  const draftName = typeof draftNameRaw === 'string' ? draftNameRaw.trim() : ''
  const refreshedNameRef = useRef<string>('')
  useEffect(() => {
    if (!draft?.id || !draftName || eventCtx.loading || eventCtx.selectedEventId !== draft.id) return
    if (eventCtx.selectedEvent?.name === draftName || refreshedNameRef.current === draftName) return
    refreshedNameRef.current = draftName
    eventCtx.refresh()
  }, [draft?.id, draftName, eventCtx])

  // Buffers the Step 1 (category) and Step 2 (visibility) selections BEFORE any
  // Firestore document exists. These seed the deferred createDraft and let the
  // organizer navigate Back without losing choices while no draft is persisted.
  // Held in state (not a ref) so it can be safely read during render.
  const [pending, setPending] = useState<{ step0: Step1State | null; visibility: VisibilityId | null }>({
    step0:      null,
    visibility: null,
  })

  const [currentStep,     setCurrentStep]     = useState(0)
  // Over-provisioned to 9 — the max across all wizard types (event_plus_donation has 9 steps)
  const [completedValues, setCompletedValues] = useState<(string | undefined)[]>(
    Array(9).fill(undefined),
  )
  // Prevents rendering before draft state is hydrated into local state
  const [hydrated, setHydrated] = useState(false)

  // isDonationOnly: true when user selected Fundraising + Donation Only and advanced past step 0
  const isDonationOnly =
    draft?.eventType === 'fundraising' && draft?.campaignType === 'donation_only'

  // isEventPlusDonation: fundraising event with a linked donation campaign (8-step wizard)
  const isEventPlusDonation =
    draft?.eventType === 'fundraising' && draft?.campaignType === 'event_plus_donation'

  // ─── RD-EVENT-03 · step→draft mapping, from the registry ───────────────────
  //
  // These three call sites used 29 positional `step === N` comparisons between them, and the
  // step ORDER is not fixed — 'Fundraising' shifts License and Review by one. Nothing tied
  // index 3 to `pricing` except a literal repeated in three places.
  //
  // The registry answers "which field does this step write, for THIS call site". The three
  // sites persist different sets of steps — goNext skips License and Review, autosave covers
  // only three steps — and that asymmetry is existing behaviour, encoded per-site in the
  // registry rather than smoothed over here.
  const wizardFlow: WizardFlow = isEventPlusDonation ? 'fundraising' : 'standard'
  const eventTypeStep  = indexOfStep(wizardFlow, 'eventType')
  const visibilityStep = indexOfStep(wizardFlow, 'visibility')

  /**
   * Writes one step's contribution into a draft payload.
   *
   * `step0` is the one key that is not a straight assignment: the Category step expands a
   * single Step1State into four top-level draft fields. That expansion is unchanged.
   */
  // RD-CE-FIX H3 · an event-TYPE change on an existing draft resets exactly what the new type cannot
  // use (lib/events/builder/typeTransition). The organizer is told what will be reset and confirms;
  // the resets are written together with the new type keys. Returns null when they cancel.
  const { confirm } = useConfirm()
  const confirmTypeChange = useCallback(
    async (step0: Step1State | null): Promise<Record<string, unknown> | null> => {
      if (!draft?.id || !step0) return {}
      const plan = planTypeTransition(draft as unknown as Record<string, unknown>, {
        eventType: step0.eventType ?? null, eventSubtype: step0.subtype ?? null, campaignType: step0.campaignType ?? null,
      })
      if (!plan.changed) return {}
      if (plan.resets.length > 0) {
        const ok = await confirm({
          title:        'Change the event type?',
          message:      `These settings don’t apply to the new event type and will be reset: ${plan.resets.join(' · ')}. ` +
                        'Your event name, dates, venue, organizer details, passes and prices are kept.',
          confirmLabel: 'Change type and reset',
          cancelLabel:  'Keep current type',
          tone:         'danger',
        })
        if (!ok) return null
      }
      return plan.patch as Record<string, unknown>
    },
    [draft, confirm],
  )

  const applyStepPayload = useCallback(
    (
      payload: Record<string, unknown>,
      step: number,
      data: unknown,
      site: 'next' | 'saveDraft' | 'autosave',
    ) => {
      const key = draftKeyFor(wizardFlow, step, site)
      if (!key) return
      if (key === 'step0') {
        const d = data as Step1State | null
        payload.eventType          = d?.eventType     ?? null
        payload.eventSubtype       = d?.subtype       ?? null
        payload.customEventSubtype = d?.customSubtype ?? null
        payload.campaignType       = d?.campaignType  ?? null
        return
      }
      payload[key] = data
    },
    [wizardFlow],
  )

  // On first load, seed wizard state from the persisted draft
  useEffect(() => {
    if (isLoading || hydrated) return
    if (draft) {
      // RD-EVENT-COMMERCE-02 — an out-of-range persisted index reopens on a real step (see
      // resumeStepFor). The flow is read off the draft itself, as `wizardFlow` is.
      const draftFlow: WizardFlow =
        draft.eventType === 'fundraising' && draft.campaignType === 'event_plus_donation' ? 'fundraising' : 'standard'
      // The Wallet's "Increase Limit" hand-off opens License & Services directly (lib/wallet/purchaseIntent).
      const walletIntent = readIntent(draft.id)
      // RD-REVIEW-02 — an event whose changes were requested opens on Review: the requested changes,
      // the deadline and "Submit for review" are there (License & Services would read "awaiting approval").
      const changesRequested = (draft as unknown as Record<string, unknown>).lifecycleStatus === 'changes_requested'
      setCurrentStep(draft.eventType === 'fundraising' && draft.campaignType === 'donation_only'
        ? (draft.currentStep ?? 0)   // the campaign wizard keeps its own indexing, untouched
        : walletIntent ? indexOfStep(draftFlow, 'license')
        : changesRequested ? indexOfStep(draftFlow, 'review')
        : resumeStepFor(draftFlow, draft.currentStep))
      setCompletedValues(
        (draft.completedValues ?? Array(WIZARD_STEPS.length).fill(null)).map(
          v => (v as string | null | undefined) ?? undefined,
        ),
      )
    }
    setHydrated(true)
  }, [isLoading, draft, hydrated])

  const goNext = useCallback(
    async (label?: string, data?: unknown) => {
      // RD-EVENT-12 · audited sync point: navigation. Typing advances persistence only, so
      // render state must catch up BEFORE the next step mounts and seeds its initialData —
      // otherwise Form could seed its pass list from a pre-edit pricing.
      syncRenderState()
      const step       = currentStep
      const totalSteps = isEventPlusDonation ? FUNDRAISING_EVENT_WIZARD_STEPS.length : WIZARD_STEPS.length
      const nextStep   = Math.min(step + 1, totalSteps - 1)
      const newValues  = completedValues.map((v, i) => (i === step ? label : v))

      // M1: a successful publish (signalled by the review step's 'Published' label from
      // handleConfirmPublish) advances the server's authoritative updatedAt OUTSIDE the
      // autosave path. Align the local draft baseline to it FIRST, so any snapshot the
      // step-persist below writes carries the aligned (unknown) baseline — never a stale
      // pre-publish value that would surface as a false conflict on reopen.
      if (label === 'Published') markPublished()

      // Buffer Step 1/2 selections so they can seed the deferred createDraft
      // (and survive Back navigation) before any Firestore document exists.
      const step0      = step === eventTypeStep  ? (data as Step1State)  : pending.step0
      const visibility = step === visibilityStep ? (data as VisibilityId) : pending.visibility
      // RD-CE-FIX H3 — confirm + collect the type-change resets BEFORE anything moves.
      const typePatch = step === eventTypeStep ? await confirmTypeChange(step0) : {}
      if (typePatch === null) return
      if (step === eventTypeStep || step === visibilityStep) setPending({ step0, visibility })

      // ── First Firestore write — happens ONLY here, on an explicit Continue ──
      // • donation-only commits at the Category step (it has no Visibility step
      //   and forks to the campaign wizard immediately after).
      // • every other event type commits at the Visibility step.
      const donationOnlyCommit = step === eventTypeStep && step0?.campaignType === 'donation_only'
      const standardCommit     = step === visibilityStep
      if (!draft?.id && (donationOnlyCommit || standardCommit)) {
        const created = await createDraft({
          eventType:          step0?.eventType     ?? null,
          eventSubtype:       step0?.subtype       ?? null,
          customEventSubtype: step0?.customSubtype ?? null,
          campaignType:       step0?.campaignType  ?? null,
          visibility:         visibility ?? null,
          currentStep:        nextStep,
          completedValues:    newValues.map(v => v ?? null),
        })
        if (!created) return   // creation failed — stay on the current step
        // Advance only after the draft (and its optimistic local state) exists,
        // so the donation-only fork reads the correct campaignType with no flash.
        setCompletedValues(newValues)
        setCurrentStep(nextStep)
        return
      }

      setCompletedValues(newValues)
      setCurrentStep(nextStep)

      // Draft already exists (Resume, or any post-creation step) — persist the
      // partial payload for this step exactly as before.
      const payload: Record<string, unknown> = {
        currentStep:     nextStep,
        completedValues: newValues.map(v => v ?? null),
      }
      // Persists steps 0–5, plus Fundraising in the fundraising flow. License and Review
      // are deliberately NOT persisted on advance — see the registry.
      applyStepPayload(payload, step, data, 'next')
      Object.assign(payload, typePatch)
      // NOTE (LS2.2): the client must NEVER write `publishedAt` — it is a
      // server-controlled field (set only by the Admin-SDK publish route) and
      // firestore.rules blocks any client draft update whose affectedKeys include
      // it. Writing it here was the root cause of the wizard's
      // "Missing or insufficient permissions" error on reaching the Review step.

      void updateDraft(payload)
    },
    [currentStep, completedValues, createDraft, updateDraft, markPublished, isEventPlusDonation, draft?.id, pending,
     applyStepPayload, eventTypeStep, visibilityStep, syncRenderState, confirmTypeChange],
  )

  const goBack = useCallback(
    () => { syncRenderState(); setCurrentStep(s => Math.max(s - 1, 0)) },
    [syncRenderState],
  )

  const [stepFocusHint, setStepFocusHint] = useState<string | undefined>(undefined)

  const goToStep = useCallback(
    (step: number, fieldHint?: string) => {
      syncRenderState()
      setCurrentStep(step)
      setStepFocusHint(fieldHint)
    },
    [syncRenderState],
  )

  // Called by "Save Draft" buttons (no step advance)
  const saveDraft = useCallback(
    async (step: number, data?: unknown) => {
      // Keep the buffer current so a Save Draft on Step 1/2 seeds creation.
      const step0      = step === eventTypeStep  ? (data as Step1State)  : pending.step0
      const visibility = step === visibilityStep ? (data as VisibilityId) : pending.visibility
      if (step === eventTypeStep || step === visibilityStep) setPending({ step0, visibility })

      // "Save Draft" is an explicit user action too: if no document exists yet
      // (only possible on Step 1/2), create it once via the same deduped path.
      if (!draft?.id) {
        await createDraft({
          eventType:          step0?.eventType     ?? null,
          eventSubtype:       step0?.subtype       ?? null,
          customEventSubtype: step0?.customSubtype ?? null,
          campaignType:       step0?.campaignType  ?? null,
          visibility:         visibility ?? null,
        })
        return
      }

      // RD-CE-FIX H3 — Save Draft on Step 1 applies the same confirmed type-change resets.
      const typePatch = step === eventTypeStep ? await confirmTypeChange(step0) : {}
      if (typePatch === null) return
      const payload: Record<string, unknown> = {}
      // Every keyed step, INCLUDING License and Review — a wider scope than goNext, which
      // is why the registry carries a flag per call site rather than one shared flag.
      applyStepPayload(payload, step, data, 'saveDraft')
      Object.assign(payload, typePatch)
      if (Object.keys(payload).length) {
        void updateDraft(payload)
      }
    },
    [createDraft, updateDraft, draft?.id, pending,
     applyStepPayload, eventTypeStep, visibilityStep, confirmTypeChange],
  )

  // RD-PRODUCT-01B: within-step autosave funnel — same step→payload mapping as
  // saveDraft, but debounced via the hook. Only the major editing steps are wired;
  // a draft always exists by the time these steps are reachable.
  const autosave = useCallback(
    (step: number, data: unknown) => {
      if (!draft?.id) return
      const payload: Record<string, unknown> = {}
      // Only Passes & Pricing, Form and Details are wired for debounced autosave.
      applyStepPayload(payload, step, data, 'autosave')
      if (Object.keys(payload).length) autosaveDraft(payload)
    },
    [autosaveDraft, draft?.id, applyStepPayload],
  )

  // RD-CAPACITY-01 · the draft carries the organizer's chosen REGISTRATION CAPACITY.
  //
  // It defaults to the free allowance, so a draft that never reaches this step still
  // publishes — at zero cost, with the free capacity — rather than failing a quote.
  //
  // This value is INTENT, not authority. The publish route re-quotes it against the
  // effective commercial terms and refuses to store it unless a paid order covers it, so a
  // tampered draft can only produce a payment demand, never free capacity.
  const selectedCapacity: number = typeof draft?.registrationCapacity === 'number'
    && Number.isInteger(draft.registrationCapacity) && draft.registrationCapacity > 0
      ? draft.registrationCapacity
      : DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity
  const onSelectCapacity = useCallback(
    (capacity: number) => { void updateDraft({ registrationCapacity: capacity }) },
    [updateDraft],
  )
  // RD-CAPACITY-DEFAULT — License & Services is the final step and has no Continue, so the capacity
  // it opens on (the free allowance) was shown and quoted but never saved, and publish refused the
  // draft (CAPACITY_NOT_CONFIGURED). Save it once the step's quote has answered; Pay and Publish both
  // wait for that quote and settle the draft first, so the write lands before the server reads it.
  // Once per draft: `updateDraft` advances the persisted draft, not render state (RD-EVENT-12).
  // Not over a verified legacy paid tier: the License step reports the quote's verdict per draft.
  const capacityIntentWrittenFor = useRef<string | null>(null)
  const [legacyVerdict, setLegacyVerdict] = useState<{ draftId: string; legacy: boolean } | null>(null)
  const onLegacyEntitlement = useCallback((legacy: boolean) => {
    const id = draft?.id
    if (id) setLegacyVerdict(v => (v?.draftId === id && v.legacy === legacy ? v : { draftId: id, legacy }))
  }, [draft?.id])
  const capacityIntent = capacityIntentToPersist(
    draft, currentStep === indexOfStep(wizardFlow, 'license'), selectedCapacity,
    legacyVerdict && legacyVerdict.draftId === draft?.id ? legacyVerdict.legacy : null,
  )
  useEffect(() => {
    if (capacityIntent === null || !draft?.id || capacityIntentWrittenFor.current === draft.id) return
    capacityIntentWrittenFor.current = draft.id
    void updateDraft({ registrationCapacity: capacityIntent })
  }, [capacityIntent, draft?.id, updateDraft])
  // RD-EVENT-COMMERCE-02 · the License & Services step's service switches live on `pricing`,
  // where every sender already reads them (`pricing.whatsappEnabled` gates each WhatsApp send).
  // Merged over the current pricing so no pass, date or fee field is touched.
  const draftPricing = draft?.pricing
  // RD-LICENSE-LOCK-02 — declared HERE, above every callback that reads them. A `const` read by
  // a useCallback defined earlier in the body defeats the React Compiler's analysis ("Compilation
  // Skipped: Existing memoization could not be preserved") and drops memoization for the whole
  // wizard, which on this page means re-rendering the builder on every keystroke.
  const isPublishedDraft = draft?.status === 'published'
  const feeEditDraftId   = draft?.id ?? ''
  // RD-LICENSE-LOCK-02 — a SUBMITTED event's service flags go through the server.
  //
  // These flags gate whether anything is sent at all, and the wizard used to write them straight
  // to the draft with the client SDK: no server authorization beyond firestore.rules, and the
  // LIVE event they actually govern was only updated by a separate Save Changes the organizer
  // might never press — so the switch and the sending behaviour could disagree indefinitely.
  //
  // PATCH /edit verifies the caller, verifies that the draft AND the live document are the same
  // event owned by them, writes both in ONE batch and records an edit-history row. An unpublished
  // draft keeps the direct write: it has no live document, no lock, and nothing to desynchronise.
  //
  // Resolves false when nothing was saved, so the caller can restore the previous switch state
  // rather than leave the UI asserting something the server never accepted.
  const onServicesChange = useCallback(
    async (values: PaygServiceFlags): Promise<boolean> => {
      if (!isPublishedDraft || !feeEditDraftId) {
        void updateDraft({ pricing: { ...(draftPricing ?? {}), ...values } })
        return true
      }
      try {
        const token = await auth.currentUser?.getIdToken()
        const res = await fetch(`/api/organizer/events/${feeEditDraftId}/edit`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body:    JSON.stringify(values),
        })
        const json = await res.json().catch(() => ({})) as { success?: boolean }
        return res.ok && json.success === true
      } catch {
        return false
      }
    },
    [updateDraft, draftPricing, isPublishedDraft, feeEditDraftId],
  )
  // RD-EVENT-COMMERCE-02 — the prepaid service QUANTITIES selected on License & Services.
  // Intent only (publish checks it against the allowance ledger). A malformed stored value reads
  // as nothing selected.
  const storedSelection = (draft as { serviceSelection?: unknown } | null)?.serviceSelection
  const initialServiceSelection = useMemo<ServiceSelection>(() => {
    const parsed = parseServiceSelection(storedSelection)
    return parsed.ok ? parsed.selection : { ...EMPTY_SELECTION }
  }, [storedSelection])
  const onServiceSelectionChange = useCallback(
    (selection: ServiceSelection) => { void updateDraft({ serviceSelection: selection }) },
    [updateDraft],
  )
  // RD-FEE-RESTORE-01 — the Fee Collection Method, merged over the current pricing exactly as
  // the service switches above are, so no pass, date or fee field is disturbed.
  //
  // Writes `feeCollection` (the explicit record) and deliberately leaves the legacy
  // `pricing.feeModel` alone: that field is what every pre-existing event carries, and the
  // server never reads it. `setBy` is the authenticated uid — without one no record is written,
  // so an unauthenticated client cannot produce a selection that would later be honoured.
  // RD-FEE-RESTORE-02 — a PUBLISHED event must also reach `events/{slug}`.
  //
  // The draft write alone was the reported defect: the builder previews from the draft and
  // showed ₹1.04, while an attendee — priced from the LIVE document, which had no record — was
  // charged ₹1. For an unpublished draft the gap closes at publish (which copies pricing
  // wholesale); for an already-published event nothing in this path wrote the live document, so
  // the choice stayed invisible to checkout until the organizer happened to press Save Changes.
  //
  // PATCH /edit is the designated path for exactly this (lib/events/editing/applyEdit.ts): it is
  // engine-gated, validated, audited, and writes the draft and the live event in ONE batch. It is
  // used INSTEAD of the draft write for a published event rather than in addition to it, so the
  // two documents can never be left disagreeing by a partial success.
  //
  // Returns false when nothing was saved, so the caller can restore the previous selection
  // instead of leaving the UI showing a choice the server does not have.
  // `isPublishedDraft` / `feeEditDraftId` are declared once, above onServicesChange — both
  // callbacks read them, and a later declaration would defeat the React Compiler for both.
  const feeActorUid = useAuth().user?.uid ?? ''
  const onFeeModelChange = useCallback(
    async (model: FeeModel): Promise<boolean> => {
      if (!feeActorUid || !feeEditDraftId) return false
      if (isPublishedDraft) {
        try {
          const token = await auth.currentUser?.getIdToken()
          const res = await fetch(`/api/organizer/events/${feeEditDraftId}/edit`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body:    JSON.stringify({ feeModel: model }),
          })
          const json = await res.json().catch(() => ({})) as { success?: boolean }
          return res.ok && json.success === true
        } catch {
          return false
        }
      }
      void updateDraft({
        pricing: {
          ...(draftPricing ?? {}),
          feeCollection: buildFeeCollection(model, feeActorUid, new Date().toISOString()),
        },
      })
      return true
    },
    [updateDraft, draftPricing, feeActorUid, isPublishedDraft, feeEditDraftId],
  )
  const draftStatus = typeof draft?.status === 'string' ? draft.status : null

  // The legacy tier field is still read by the Review summary and by the publish route's
  // grandfathered path. It is pinned to the version's free tier and never chosen by the
  // organizer again — retiring the field itself is cleanup, not part of this change.
  const selectedLicense: AnyEventLicenseTier = isValidTierForVersion(draft?.licenseTier, CURRENT_LICENSE_VERSION)
    ? draft.licenseTier
    : defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)

  // ─── RD-EVENT-10 · stable step props ────────────────────────────────────────
  //
  // Each step block previously wrote `onSaveDraft={data => saveDraft(N, data)}` and an
  // inline `initialData={{ … }}`, so BOTH allocated a new identity on every render of this
  // 4,000-line component — including the render caused by the organizer's own keystroke.
  //
  // The step index is bound from `currentStep` rather than the literal N. That is exact,
  // not approximate: every block is guarded by `currentStep === N` and passed the same N,
  // so inside a mounted block the two are always equal. Binding this way means ONE pair of
  // callbacks serves every step and their identity changes only on navigation.
  const handleSaveDraft = useCallback(
    (data?: unknown) => saveDraft(currentStep, data),
    [saveDraft, currentStep],
  )
  const handleAutosave = useCallback(
    (data: unknown) => autosave(currentStep, data),
    [autosave, currentStep],
  )

  // `draft` is replaced wholesale on every autosave (`{ ...prev, ...payload }`), but the
  // FIELDS it did not touch keep their identity. Depending on individual fields rather than
  // on `draft` is therefore what makes these stable while typing in a different step.
  const eventTypeInitialData = useMemo(() => ({
    eventType:          draft?.eventType          ?? pending.step0?.eventType     ?? null,
    eventSubtype:       draft?.eventSubtype        ?? pending.step0?.subtype       ?? null,
    customEventSubtype: draft?.customEventSubtype  ?? pending.step0?.customSubtype ?? null,
    campaignType:       (draft?.campaignType as CampaignType | null) ?? pending.step0?.campaignType ?? null,
  }), [draft?.eventType, draft?.eventSubtype, draft?.customEventSubtype, draft?.campaignType, pending.step0])

  const visibilityInitialData = useMemo(
    () => ({ visibility: draft?.visibility ?? pending.visibility ?? null }),
    [draft?.visibility, pending.visibility],
  )

  const pricingInitialData = useMemo(() => ({
    pricing: draft?.pricing ?? null, eventTypeId: draft?.eventType ?? null, eventSubtype: draft?.eventSubtype ?? null,
    // RD-PRICING-UI-LOCK-01 — Passes & Pricing locks commercial fields on a PUBLISHED event.
    // `status` is server-written only (firestore.rules refuse client writes to it).
    status:  draft?.status ?? null,
  }), [draft?.pricing, draft?.eventType, draft?.eventSubtype, draft?.status])

  const formInitialData = useMemo(() => ({
    registrationForm: draft?.registrationForm ?? null,
    eventTypeId:      draft?.eventType        ?? null,
    eventSubtype:     draft?.eventSubtype      ?? null,
    pricing:          draft?.pricing          ?? null,
    accessControl:    draft?.accessControl    ?? null,
  }), [draft?.registrationForm, draft?.eventType, draft?.eventSubtype, draft?.pricing, draft?.accessControl])

  const detailsInitialData = useMemo(() => ({
    eventDetails: draft?.eventDetails ?? null,
    eventTypeId:  draft?.eventType    ?? null,
    eventSubtype: draft?.eventSubtype  ?? null,
    pricing:      draft?.pricing      ?? null,
    draftId:      draft?.id           ?? null,
    // RD-EVENT-SLUG — the details step needs to know the event is live, so the URL slug
    // can be shown as the frozen identity it already is server-side. Review has carried
    // `status` all along; this is the same value, not a new one.
    status:       draft?.status       ?? null,
  }), [draft?.eventDetails, draft?.eventType, draft?.eventSubtype, draft?.pricing, draft?.id, draft?.status])

  const fundraisingInitialData = useMemo(() => ({
    linkedCampaign: draft?.linkedCampaign ?? null,
    eventEndDate:   (draft?.eventDetails as Record<string, unknown> | null)?.endDate as string | null ?? null,
  }), [draft?.linkedCampaign, draft?.eventDetails])

  // RD-REVIEW-02 — the server-written review fields of the draft (not part of the wizard's own shape).
  const draftRecord = draft as unknown as Record<string, unknown> | null
  const reviewFields = useMemo(() => ({
    lifecycleStatus: (draftRecord?.lifecycleStatus as string | undefined) ?? null,
    reviewDeadline:  draftRecord?.reviewDeadline ?? null,
    reviewCycleId:   (draftRecord?.reviewCycleId as string | undefined) ?? null,
    changesComment:  (draftRecord?.changesComment as string | undefined) ?? null,
    reviewClosed:    isReviewClosed(draftRecord),
  }), [draftRecord])
  const licenseLifecycle = useMemo(() => ({ status: reviewFields.lifecycleStatus, reviewClosed: reviewFields.reviewClosed }), [reviewFields.lifecycleStatus, reviewFields.reviewClosed])

  // Both Review mount points read the identical payload — one memo serves both.
  const reviewInitialData = useMemo(() => ({
    draftId:          draft?.id               ?? null,
    status:           draft?.status           ?? null,
    eventType:        draft?.eventType        ?? null,
    eventSubtype:     draft?.eventSubtype      ?? null,
    visibility:       draft?.visibility        ?? null,
    accessControl:    draft?.accessControl     ?? null,
    pricing:          draft?.pricing           ?? null,
    registrationForm: draft?.registrationForm  ?? null,
    eventDetails:     draft?.eventDetails      ?? null,
    licenseTier:      selectedLicense,
    // RD-CAPACITY-01 · the review step prices the activation, so it needs the chosen capacity.
    // Without this it would read `undefined`, fall back to the free allowance, and offer a
    // free submission for a capacity the organizer is supposed to pay for.
    registrationCapacity: selectedCapacity,
    // RD-PUBLISH-PLAN — whether the draft carries a capacity of its OWN (selectedCapacity falls back to the
    // free allowance): only then does a legacy paid tier stop deciding what publishes.
    registrationCapacitySaved: isPersistedCapacity(draft?.registrationCapacity),
    // RD-EVENT-COMMERCE-02 — Review checks the SAME selection License & Services paid for.
    serviceSelection:     initialServiceSelection,
    // RD-REVIEW-02 — Review shows the requested changes and the server deadline, and becomes the
    // event's "Submit for review" when its changes were requested (server-written fields).
    lifecycleStatus:      reviewFields.lifecycleStatus,
    reviewDeadline:       reviewFields.reviewDeadline,
    reviewCycleId:        reviewFields.reviewCycleId,
    changesComment:       reviewFields.changesComment,
  }), [draft?.id, draft?.status, draft?.eventType, draft?.eventSubtype, draft?.visibility,
       draft?.accessControl, draft?.pricing, draft?.registrationForm, draft?.eventDetails,
       selectedLicense, selectedCapacity, draft?.registrationCapacity, initialServiceSelection, reviewFields])

  // Loading skeleton — shown while draft is being fetched from Firestore
  if (!hydrated || isLoading) {
    return (
      <div
        className="flex min-h-full flex-col gap-5 pt-1"
        aria-busy="true"
        aria-label="Loading event draft"
      >
        <div className="h-4 w-36 animate-pulse rounded-lg bg-muted/50" />
        <div className="h-[76px] animate-pulse rounded-xl bg-muted/30" />
        <div className="mt-1 h-7 w-52 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-44 animate-pulse rounded-xl bg-muted/30" />
        <div className="h-32 animate-pulse rounded-xl bg-muted/30" />
      </div>
    )
  }

  // RD-EVENT-02 S1D (H1): every step view must render the Stepper + footer against the SAME
  // canonical step definition the parent navigates by, so the 9-step event_plus_donation
  // workflow shows 9 steps on every step (not the default 8). One source of truth.
  // Spread at each call site, so this object's own identity never reaches a step — React
  // compares the individual props. Every one of them is now stable across a re-render.
  const activeWizardSteps = isEventPlusDonation ? FUNDRAISING_EVENT_WIZARD_STEPS : WIZARD_STEPS
  // RD-EVENT-COMMERCE-05B — Review precedes License & Services (the final step); positions from the registry.
  const reviewStepIndex  = indexOfStep(wizardFlow, 'review')
  const licenseStepIndex = indexOfStep(wizardFlow, 'license')
  // RD-EVENT-COMMERCE-05D — the live event's canonical public URL for "View Live" (same builder and
  // slug source Review used: the draft's SEO slug == events/{slug}; null when not set).
  const liveSlug: unknown = draft?.eventDetails ? normalizeEventDetailsDraft(draft.eventDetails as unknown as EventDetailsDraft)?.seo?.urlSlug : undefined
  const livePublicHref = typeof liveSlug === 'string' && liveSlug ? buildEventHref(liveSlug) : null
  const sharedProps = { completedValues, onNext: goNext, onBack: goBack, wizardSteps: activeWizardSteps }


  // When donation-only: step 0 shows event type selector; step 1+ hands off to DonationCampaignWizard
  if (isDonationOnly && currentStep >= 1) {
    return (
      <DonationCampaignWizard
        eventSubtype={draft?.eventSubtype ?? null}
        onBackToEventType={() => {
          // Reset back to step 0 so user can change event type
          setCurrentStep(0)
          void updateDraft({ currentStep: 0, campaignType: null })
        }}
      />
    )
  }

  return (
    <>
      {/* RD-PRODUCT-01B — always-visible save status + draft recovery */}
      <div className="sticky top-0 z-30 -mb-1 flex justify-end px-1 pt-0.5">
        <SaveStatusIndicator state={saveState} lastSavedAt={lastSavedAt} />
      </div>
      {conflict && <DraftRecoveryPrompt conflict={conflict} onResolve={keepLocal => { resolveConflict(keepLocal); setStepEpoch(e => e + 1) }} />}
      {/* RD-CE-FIX (draft recovery) — the steps seed their state ONCE from the draft; after a recovery
          choice the draft changes underneath them, so they are remounted to re-seed from it (otherwise
          the next keystroke autosaved the pre-recovery values over the recovered edits). */}
      <Fragment key={`steps-${stepEpoch}`}>
      {currentStep === 0 && (
        <Step1View
          currentStep={0}
          {...sharedProps}
          onSaveDraft={handleSaveDraft}
          initialData={eventTypeInitialData}
          locked={draft?.publishedAt != null}
        />
      )}
      {currentStep === 1 && (
        <Step2View
          currentStep={1}
          {...sharedProps}
          onSaveDraft={handleSaveDraft}
          initialData={visibilityInitialData}
        />
      )}
      {currentStep === 2 && (
        <Step3View
          currentStep={2}
          {...sharedProps}
          onSaveDraft={handleSaveDraft}
          initialData={(draft?.accessControl as Record<string, unknown> | null) ?? null}
          onAutosave={handleAutosave}
        />
      )}
      {currentStep === 3 && (
        <Step4View
          currentStep={3}
          {...sharedProps}
          onSaveDraft={handleSaveDraft}
          onAutosave={handleAutosave}
          initialData={pricingInitialData}
        />
      )}
      {currentStep === 4 && (
        <Step5View
          currentStep={4}
          {...sharedProps}
          onSaveDraft={handleSaveDraft}
          onAutosave={handleAutosave}
          initialData={formInitialData}
        />
      )}
      {currentStep === 5 && (
        <Step6View
          currentStep={5}
          {...sharedProps}
          focusHint={stepFocusHint}
          onSaveDraft={handleSaveDraft}
          onAutosave={handleAutosave}
          initialData={detailsInitialData}
        />
      )}
      {/* Step 6: Fundraising setup for event_plus_donation, or Review for all other types */}
      {currentStep === 6 && isEventPlusDonation && (
        <LinkedCampaignStep
          currentStep={6}
          completedValues={completedValues}
          onNext={goNext}
          onBack={goBack}
          onSaveDraft={handleSaveDraft}
          wizardSteps={FUNDRAISING_EVENT_WIZARD_STEPS}
          initialData={fundraisingInitialData}
        />
      )}
      {/* RD-EVENT-COMMERCE-05B — Review, then License & Services (the final step). Mounted by
          step ID, so the standard (7, 8) and fundraising (8, 9) positions come from the registry. */}
      {currentStep === reviewStepIndex && (
        <Step7View
          phase="review"
          onSettle={settle}
          onServerSaved={markPublished}
          currentStep={reviewStepIndex}
          {...sharedProps}
          onGoToStep={goToStep}
          onSaveDraft={handleSaveDraft}
          initialData={reviewInitialData}
        />
      )}
      {currentStep === licenseStepIndex && (isSubmittedDraftStatus(draftStatus) ? (
        // A submitted event buys MORE here — no submission, no republish. Its status banner (Event
        // is Live / awaiting approval, View Live) is at the top of this step. RD-EVENT-COMMERCE-05E —
        // rendered through the SAME final view as a new event, so the Fee Collection Method card has
        // one render site; here it saves on the server (future checkouts only), and License &
        // Services owns the footer (Unlock to edit / Pay ₹X via Razorpay / Done).
        <Step7View
          phase="final"
          onSettle={settle}
          onServerSaved={markPublished}
          currentStep={licenseStepIndex}
          {...sharedProps}
          onGoToStep={goToStep}
          onSaveDraft={data => saveDraft(reviewStepIndex, data)}
          onFeeModelChange={onFeeModelChange}
          initialData={reviewInitialData}
          renderLicense={() => (
            <LicenseStepView
              liveStatus={{ publicHref: livePublicHref }}
              currentStep={licenseStepIndex}
              completedValues={completedValues}
              onNext={goNext}
              onBack={goBack}
              steps={activeWizardSteps}
              selectedCapacity={selectedCapacity}
              onSelectCapacity={onSelectCapacity}
              onLegacyEntitlement={onLegacyEntitlement}
              onSettle={settle}
              pricing={draft?.pricing ?? null}
              onServicesChange={onServicesChange}
              initialServiceSelection={initialServiceSelection}
              onServiceSelectionChange={onServiceSelectionChange}
              draftStatus={draftStatus}
              lifecycle={licenseLifecycle}
              draftId={draft?.id ?? null}
            />
          )}
        />
      ) : (
        <Step7View
          phase="final"
          onSettle={settle}
          currentStep={licenseStepIndex}
          {...sharedProps}
          onGoToStep={goToStep}
          // RD-EVENT-COMMERCE-05C — the only thing this view saves is the Fee Collection Method,
          // which belongs to `pricing`. `handleSaveDraft` would save through the CURRENT step's key
          // (License → `licenseTier`) and put the pricing object in the wrong field, so the save is
          // routed through the Review step's key (`pricing`) explicitly.
          onSaveDraft={data => saveDraft(reviewStepIndex, data)}
          onFeeModelChange={onFeeModelChange}
          initialData={reviewInitialData}
          renderLicense={onContext => (
            <LicenseStepView
              currentStep={licenseStepIndex}
              completedValues={completedValues}
              onNext={goNext}
              onBack={goBack}
              steps={activeWizardSteps}
              selectedCapacity={selectedCapacity}
              onSelectCapacity={onSelectCapacity}
              onLegacyEntitlement={onLegacyEntitlement}
              onSettle={settle}
              pricing={draft?.pricing ?? null}
              onServicesChange={onServicesChange}
              initialServiceSelection={initialServiceSelection}
              onServiceSelectionChange={onServiceSelectionChange}
              draftStatus={draftStatus}
              lifecycle={licenseLifecycle}
              draftId={draft?.id ?? null}
              embeddedFinal={{ onContext }}
            />
          )}
        />
      ))}
      </Fragment>
    </>
  )
}
