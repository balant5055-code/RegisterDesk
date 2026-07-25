'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
  type FeeModel, normalizeFeeModel,
  type FeeBreakdown, type FeeRates, type StepSummary, type ReadinessReport,
} from '@/lib/events/builder/types'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import { Stepper } from '@/components/event-builder/Stepper'
import { Step1View, type Step1State } from '@/components/event-builder/steps/Step1View'
import { Step2View } from '@/components/event-builder/steps/Step2View'
import { Step3View } from '@/components/event-builder/steps/Step3View'
import { Step4View } from '@/components/event-builder/steps/Step4View'
import { Step5View } from '@/components/event-builder/steps/Step5View'
import { Step6View } from '@/components/event-builder/steps/Step6View'
import { isChannelImplemented } from '@/lib/communications/health/channels'
import {
  type CampaignType,
  makeBlankCampaignDetailsDraft,
  isCampaignDetailsValid,
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
  Info,
  Lock,
  Mail,
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
  Wallet,
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
import { calculateCommunicationCost } from '@/lib/events/communicationCost'
import { estimateCapacity }           from '@/lib/events/estimateCapacity'
import { evaluatePublishRequirements } from '@/lib/events/publishRequirements'
import type { CommunicationCostResult, PublishApiResponse, PublishGovernanceInfo, WalletBalanceResponse, WalletTopupOrderResponse, WalletTopupVerifyResponse } from '@/types/events'
import { CURRENT_LICENSE_VERSION, isValidTierForVersion, defaultLicenseTierForVersion, type AnyEventLicenseTier } from '@/lib/licensing/eventLicense'
import { useCurrentLicenseCatalogView } from '@/lib/licensing/licenseCatalogClient'
import type { LicenseCatalogEntryView } from '@/lib/licensing/licenseCatalogShared'
import { useCommunicationConfig } from '@/lib/communications/communicationConfigClient'
import { useFeesConfig } from '@/lib/fees/feesConfigClient'
import type { PublicFeesConfig } from '@/lib/fees/publicFeesShared'
import { useToast } from '@/components/ui/Toast'

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
const LicenseCards = dynamic(
  () => import('@/components/wizard/LicenseCards').then(m => m.LicenseCards), { loading: builderLoading },
)
const FinalCostSummary = dynamic(
  () => import('@/components/wizard/FinalCostSummary').then(m => m.FinalCostSummary), { loading: builderLoading },
)
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
  { name: 'License' },
  { name: 'Review' },
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

// --- Fee Breakdown Popover ---------------------------------------------------

function FeeBreakdownPopover({
  fees,
  type,
  platformPercent,
  gstPercent,
}: {
  fees: FeeBreakdown
  type: 'attendee' | 'organizer'
  platformPercent: number
  gstPercent:      number
}) {
  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const rows =
    type === 'attendee'
      ? [
          { label: 'Ticket Price',                       val: formatINR(fees.ticketPrice), cls: 'text-foreground'       },
          { label: `RegisterDesk Fee (${platformPercent}%)`, val: formatINR(fees.platformFee), cls: 'text-muted-foreground' },
          { label: 'Gateway Fee',                        val: formatINR(fees.gatewayFee),  cls: 'text-muted-foreground' },
          { label: `GST on Fees (${gstPercent}%)`,       val: formatINR(fees.gstOnFees),   cls: 'text-muted-foreground' },
        ]
      : [
          { label: 'Ticket Price',     val:  formatINR(fees.ticketPrice), cls: 'text-foreground' },
          { label: 'RegisterDesk Fee', val: `-${formatINR(fees.platformFee)}`, cls: 'text-rose-500' },
          { label: 'Gateway Fee',      val: `-${formatINR(fees.gatewayFee)}`,  cls: 'text-rose-500' },
          { label: 'GST on Fees',      val: `-${formatINR(fees.gstOnFees)}`,   cls: 'text-rose-500' },
        ]

  const totalLabel = type === 'attendee' ? 'Total Payable'       : 'Settlement Amount'
  const totalVal   = type === 'attendee' ? formatINR(fees.attendeePays) : formatINR(fees.organizerGets)
  const totalCls   = type === 'attendee' ? 'text-violet-700'     : 'text-emerald-700'

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        className="ml-1 flex items-center justify-center text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        aria-label="Show fee breakdown"
      >
        <Info className="size-3.5" aria-hidden />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="popover"
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1    }}
            exit={{   opacity: 0, y: 6, scale: 0.96 }}
            transition={{ duration: 0.15, ease: EASE }}
            className="absolute bottom-full left-1/2 z-50 mb-2 w-56 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="border-b border-border bg-muted/[0.04] px-3.5 py-2.5">
              <p className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
                Sample Calculation
              </p>
            </div>
            <div className="flex flex-col gap-1.5 px-3.5 py-3">
              {rows.map(row => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-muted-foreground">{row.label}</span>
                  <span className={cn('text-[12px] font-semibold tabular-nums', row.cls)}>
                    {row.val}
                  </span>
                </div>
              ))}
              <div className="my-1 border-t border-border/60" />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-bold text-foreground">{totalLabel}</span>
                <span className={cn('text-[12px] font-extrabold tabular-nums', totalCls)}>
                  {totalVal}
                </span>
              </div>
            </div>
            <div className="border-t border-border/40 bg-muted/[0.03] px-3.5 py-2">
              <p className="text-[12px] leading-relaxed text-muted-foreground/60">
                Actual gateway charges may vary by payment method.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// --- Step 4: Fee Collection Section — comparison cards with embedded examples ---

function FeeCollectionSection({
  feeModel,
  onChange,
  samplePrice = 500,
}: {
  feeModel:     FeeModel
  onChange:     (m: FeeModel) => void
  samplePrice?: number
}) {
  const feesCfg = useFeesConfig()
  const rates   = feeRatesFrom(feesCfg)
  // RD-PAYMENT-02 Phase 7: Attendee Pays becomes selectable ONLY when the pricing engine
  // is active. While dormant (production default) it stays "Coming Soon" and any stored
  // value normalizes to organizer_absorbs — byte-identical to before.
  const engineEnabled = feesCfg.pricingEngineEnabled
  const oaFees = computeFeePreview(samplePrice, 'organizer_absorbs', rates)
  const apFees = engineEnabled ? computeFeePreview(samplePrice, 'attendee_pays', rates) : undefined
  const effectiveModel = normalizeFeeModel(feeModel, engineEnabled)

  type FeeOption = {
    id:          FeeModel
    label:       string
    badge:       string | null
    badgeCls:    string
    desc:        string
    supported:   boolean
    fees?:       FeeBreakdown
    summaryNote: string
    summaryCls:  string
  }
  const OPTIONS: FeeOption[] = [
    {
      id:      'organizer_absorbs',
      label:   'Organizer Absorbs Fees',
      badge:   engineEnabled ? null : 'How it works',
      badgeCls:'bg-emerald-100 text-emerald-700',
      desc:    'Attendees pay only the ticket price. RegisterDesk platform fees are deducted from your payout.',
      supported:   true,
      fees:        oaFees,
      summaryNote: 'Platform fees absorbed by you',
      summaryCls:  'text-amber-700',
    },
    {
      id:      'attendee_pays',
      label:   'Attendee Pays Fees',
      badge:   engineEnabled ? null : 'Coming Soon',
      badgeCls: engineEnabled ? '' : 'bg-muted text-muted-foreground',
      desc:    engineEnabled
        ? 'Platform fees are added on top of the ticket price so attendees cover them — you receive the full ticket value.'
        : 'Add platform fees on top of the ticket price so attendees cover them. Not available yet — every event currently uses Organizer Absorbs Fees.',
      supported:   engineEnabled,
      fees:        apFees,
      summaryNote: engineEnabled ? 'Attendees cover the fees' : 'Not available yet',
      summaryCls:  engineEnabled ? 'text-emerald-700' : 'text-muted-foreground',
    },
  ]

  return (
    <div className="border-t border-border/60 px-5 pt-5 sm:px-6">
      <p className="mb-1 text-[13px] font-semibold text-foreground">Fee Collection Method</p>
      <p className="mb-4 text-[12px] text-muted-foreground">
        {engineEnabled
          ? `Choose who covers RegisterDesk platform fees — shown on a ${formatINR(samplePrice)} ticket below.`
          : `RegisterDesk platform fees are absorbed by you (the organizer). Attendees pay only the ticket price — shown on a ${formatINR(samplePrice)} ticket below.`}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OPTIONS.map(opt => {
          const selected = opt.supported && effectiveModel === opt.id
          return (
            <motion.div
              key={opt.id}
              role="button"
              tabIndex={opt.supported ? 0 : -1}
              aria-disabled={!opt.supported}
              whileTap={opt.supported ? { scale: 0.985 } : undefined}
              onClick={() => { if (opt.supported) onChange(opt.id) }}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (opt.supported && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  onChange(opt.id)
                }
              }}
              aria-pressed={opt.supported ? selected : undefined}
              className={cn(
                'group relative flex flex-col rounded-xl border-[1.5px] bg-card p-4 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
                !opt.supported
                  ? 'cursor-not-allowed border-dashed border-border/70 opacity-60'
                  : selected
                    ? 'cursor-pointer border-primary bg-primary/[0.02] ring-1 ring-primary/10'
                    : 'cursor-pointer border-border hover:border-primary/30 hover:shadow-sm',
              )}
            >
              {/* Selected check */}
              <AnimatePresence>
                {selected && (
                  <motion.span
                    key="chk"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ duration: 0.14, ease: EASE }}
                    className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    aria-hidden
                  >
                    <Check className="size-3" />
                  </motion.span>
                )}
              </AnimatePresence>

              {/* Label + badge */}
              <div className="mb-2 flex flex-wrap items-center gap-1.5 pr-7">
                <p className="text-[14px] font-bold text-foreground">{opt.label}</p>
                {opt.badge && (
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold', opt.badgeCls)}>
                    {opt.badge}
                  </span>
                )}
              </div>
              <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">{opt.desc}</p>

              {/* Embedded example — shown only for the supported model. The Coming Soon
                  card shows no numbers so it never implies attendee fee collection works. */}
              {opt.supported && opt.fees ? (
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-muted/[0.04] p-3">
                  <div className="flex flex-col items-center gap-0.5 rounded-lg bg-background/80 px-2 py-2 text-center">
                    <p className="text-[9.5px] font-semibold uppercase tracking-wider text-violet-500">Attendee Pays</p>
                    <div className="flex items-center gap-0.5">
                      <p className="text-[1.1rem] font-extrabold text-violet-700">{formatINR(opt.fees.attendeePays)}</p>
                      <FeeBreakdownPopover fees={opt.fees} type="attendee" platformPercent={rates.platformPercent} gstPercent={rates.gstPercent} />
                    </div>
                    <p className="text-[12px] text-muted-foreground">at checkout</p>
                  </div>
                  <div className="flex flex-col items-center gap-0.5 rounded-lg bg-background/80 px-2 py-2 text-center">
                    <p className="text-[9.5px] font-semibold uppercase tracking-wider text-emerald-600">You Receive</p>
                    <div className="flex items-center gap-0.5">
                      <p className="text-[1.1rem] font-extrabold text-emerald-700">{formatINR(opt.fees.organizerGets)}</p>
                      <FeeBreakdownPopover fees={opt.fees} type="organizer" platformPercent={rates.platformPercent} gstPercent={rates.gstPercent} />
                    </div>
                    <p className="text-[12px] text-muted-foreground">per registration</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/[0.04] px-3 py-5 text-center">
                  <p className="text-[12px] font-medium text-muted-foreground">Coming soon</p>
                </div>
              )}

              {/* Summary note */}
              <p className={cn('mt-2.5 text-[12px] font-medium', opt.summaryCls)}>
                {opt.summaryNote}
              </p>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

// --- Step 4: Summary Panel ----------------------------------------------------


// --- Step 4: RegisterDesk Services & Pricing section -------------------------


// Section 2: Communication & Add-ons — selectable service cards
type CommAddonValues = { whatsappEnabled: boolean; smsEnabled: boolean; certEnabled: boolean }

function RegisterDeskServicesPricingSection({
  isFreeEvent,
  values,
  onChange,
  standalone = true,
}: {
  isFreeEvent: boolean
  values:      CommAddonValues
  onChange:    (field: keyof CommAddonValues, value: boolean) => void
  standalone?: boolean
}) {

  type SvcDef = {
    key:      string
    Icon:     React.ElementType
    label:    string
    always:   boolean
    badge:    string
    badgeCls: string
    desc:     string
    rate:     string | null
    rateNote: string | null
    example:  string | null
    unavailable?: boolean
  }

  // RD-COMMS-01 Phase 2B: SMS availability comes from the canonical capability SSOT — SMS
  // has no transport, so its add-on is shown as Unavailable and cannot be toggled or priced.
  const SMS_AVAILABLE = isChannelImplemented('sms')

  // RD-EVENT-02 S1B (H2): per-message rates come from the SAME canonical pricing source the
  // Final Cost Summary uses — the Business Configuration communication rates (seeded from
  // lib/communications/pricing.ts). No hard-coded paise anywhere in this card.
  const commConfig        = useCommunicationConfig()
  const whatsappRatePaise = commConfig.whatsapp.pricePaise
  const smsRatePaise      = commConfig.sms.pricePaise
  // Illustrative scenario (display only): 100 attendees × 2 messages. The monetary total is
  // derived from the canonical per-message rate so the rate and example can never diverge.
  const rateLabel   = (paise: number) => `${formatINR(paise / 100)} per delivered message`
  const exampleLine = (paise: number) => `100 attendees × 2 messages ≈ ${formatINR((100 * 2 * paise) / 100)}`

  const SERVICES: SvcDef[] = [
    {
      key:      'email',
      Icon:     Mail,
      label:    'Email Notifications',
      always:   true,
      badge:    'Always Included',
      badgeCls: 'bg-emerald-100 text-emerald-700',
      desc:     'Registration confirmations, reminders & updates',
      rate:     null,
      rateNote: null,
      example:  null,
    },
    {
      key:      'whatsappEnabled',
      Icon:     Phone,
      label:    'WhatsApp Notifications',
      always:   false,
      badge:    'Optional',
      badgeCls: 'bg-amber-100 text-amber-700',
      desc:     isFreeEvent
        ? 'Recharge credits before sending messages'
        : 'Charges deducted from settlement amount',
      rate:     rateLabel(whatsappRatePaise),
      rateNote: isFreeEvent ? 'Pre-paid credits required' : 'Deducted at settlement',
      example:  exampleLine(whatsappRatePaise),
    },
    {
      key:      'smsEnabled',
      Icon:     MoreHorizontal,
      label:    'SMS Notifications',
      always:   false,
      badge:    SMS_AVAILABLE ? 'Optional' : 'Unavailable',
      badgeCls: SMS_AVAILABLE ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground',
      desc:     SMS_AVAILABLE
        ? (isFreeEvent ? 'Recharge credits before sending messages' : 'Charges deducted from settlement amount')
        : 'SMS delivery is not available yet — no messages are sent for this channel.',
      rate:     SMS_AVAILABLE ? rateLabel(smsRatePaise) : null,
      rateNote: SMS_AVAILABLE ? (isFreeEvent ? 'Pre-paid credits required' : 'Deducted at settlement') : null,
      example:  SMS_AVAILABLE ? exampleLine(smsRatePaise) : null,
      unavailable: !SMS_AVAILABLE,
    },
    {
      key:      'certEnabled',
      Icon:     Award,
      label:    'Certificates',
      always:   false,
      badge:    'Optional',
      badgeCls: 'bg-blue-100 text-blue-700',
      desc:     'Auto-generate and email participation certificates',
      rate:     null,
      rateNote: null,
      example:  null,
    },
  ]

  const serviceRows = (
    <div className="divide-y divide-border/60">
      {SERVICES.map((svc) => {
          const isOn   = !svc.unavailable && (svc.always || !!values[svc.key as keyof CommAddonValues])
          const canTog = !svc.always && !svc.unavailable

          return (
            <div
              key={svc.key}
              className={cn(
                'flex items-start gap-4 px-5 py-4 transition-colors sm:px-6',
                isOn && !svc.always ? 'bg-primary/[0.015]' : '',
              )}
            >
              {/* Icon */}
              <div className={cn(
                'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
                isOn
                  ? svc.always ? 'bg-emerald-100' : 'bg-primary/10'
                  : 'bg-muted/50',
              )}>
                <svc.Icon className={cn(
                  'size-4',
                  isOn ? (svc.always ? 'text-emerald-600' : 'text-primary') : 'text-muted-foreground/50',
                )} aria-hidden />
              </div>

              {/* Label + desc */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-semibold text-foreground">{svc.label}</p>
                  <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-semibold', svc.badgeCls)}>
                    {svc.badge}
                  </span>
                </div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{svc.desc}</p>

                {/* Rate info — shown when there's a rate */}
                {svc.rate && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[13px] font-semibold text-foreground">{svc.rate}</span>
                    {svc.rateNote && (
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[12px] font-medium',
                        isFreeEvent
                          ? 'bg-amber-50 text-amber-700'
                          : 'bg-emerald-50 text-emerald-700',
                      )}>
                        {svc.rateNote}
                      </span>
                    )}
                  </div>
                )}

                {/* Example calculation — shown when enabled */}
                {svc.example && isOn && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-1 text-[12px] text-muted-foreground/70"
                  >
                    e.g. {svc.example}
                  </motion.p>
                )}
              </div>

              {/* Toggle / always badge */}
              {svc.always ? (
                <div className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1">
                  <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
                  <span className="text-[12px] font-semibold text-emerald-700">Active</span>
                </div>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  aria-label={`${isOn ? 'Disable' : 'Enable'} ${svc.label}`}
                  onClick={() => canTog && onChange(svc.key as keyof CommAddonValues, !values[svc.key as keyof CommAddonValues])}
                  className={cn(
                    'relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    isOn ? 'bg-primary' : 'bg-muted-foreground/25',
                  )}
                >
                  <span className={cn(
                    'inline-block size-[20px] rounded-full bg-white shadow-sm transition-transform duration-200',
                    isOn ? 'translate-x-5' : 'translate-x-0',
                  )} />
                </button>
              )}
            </div>
          )
        })}
    </div>
  )

  if (!standalone) return serviceRows

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <Mail className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[15px] font-bold tracking-tight text-foreground">Communication &amp; Add-ons</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Optional services to improve attendee experience.</p>
        </div>
      </div>
      {serviceRows}
    </div>
  )
}

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
          <div className="grid gap-6 px-5 py-6 lg:grid-cols-[1fr_320px]">

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

          {/* RegisterDesk fee */}
          <div className="mb-5 rounded-xl border border-border bg-card p-4">
            <p className="mb-3 text-[12px] font-semibold text-foreground">RegisterDesk Charges</p>
            <div className="flex flex-col gap-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Platform Fee</span>
                <span className="font-semibold text-foreground">{feesCfg.platformFeePercent}% of ticket revenue</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payment Gateway</span>
                <span className="font-semibold text-foreground">{feesCfg.gatewayFeeEnabled ? `${feesCfg.gatewayFeePercent}% per ticket` : 'Waived'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">GST on fees</span>
                <span className="font-semibold text-foreground">{feesCfg.gstEnabled ? `${feesCfg.gstPercent}%` : 'Not applicable'}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-2">
                <span className="text-muted-foreground">Free events</span>
                <span className="font-semibold text-emerald-600">Always free</span>
              </div>
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
}) {
  if (!open) return null

  const regStatus = isFreeEvent
    ? 'Free — opens on publish'
    : passes.length > 0 ? `${passes.length} pass type${passes.length !== 1 ? 's' : ''}` : 'Not configured'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
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
              <p className="text-[16px] font-bold text-foreground">Ready to Publish?</p>
              <p className="text-[13px] text-muted-foreground">Your event will go live immediately.</p>
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
                  { icon: Globe,        text: 'Event page goes live — accessible via your event link' },
                  { icon: Users,        text: 'Registrations open — attendees can sign up immediately' },
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
              disabled={!report.canPublish || isPublishing}
              className={cn(
                buttonVariants({ variant: 'primary' }),
                'flex-1 gap-2',
                (!report.canPublish || isPublishing) && 'cursor-not-allowed opacity-50',
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
  const requirements = evaluatePublishRequirements({
    pricing:          pricingData,
    eventDetails:     detailsData as unknown as Record<string, unknown> | null,
    registrationForm: formData,
  })
  const failed   = requirements.filter(r => !r.passed)
  const blockers = failed.map(r => `${r.stepName}: ${r.title}`)
  const warnings = steps.flatMap(s => s.checks.filter(c => !c.required && !c.passed).map(c => `${s.name}: ${c.label}`))

  return {
    score: Math.min(100, Math.round(earned)),
    steps,
    requirements,
    blockers,
    warnings,
    canPublish: failed.length === 0,
  }
}

// Wraps FeeCollectionSection (designed for inside a card) as a standalone card
function FeeCollectionCard({
  feeModel,
  onChange,
  samplePrice,
}: {
  feeModel:    FeeModel
  onChange:    (m: FeeModel) => void
  samplePrice?: number
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-3 px-5 py-4 sm:px-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <IndianRupee className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[15px] font-bold tracking-tight text-foreground">Fee Collection Method</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            How RegisterDesk platform fees are handled for this event.
          </p>
        </div>
      </div>
      {/* FeeCollectionSection uses border-t as header separator */}
      <FeeCollectionSection feeModel={feeModel} onChange={onChange} samplePrice={samplePrice} />
    </div>
  )
}

function Step7View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData, onGoToStep, wizardSteps }: StepViewProps) {
  const draftId      = (initialData?.draftId          as string | null) ?? null
  const draftStatus  = (initialData?.status           as string | null) ?? null
  const eventTypeId  = (initialData?.eventType        as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype     as string | null) ?? null
  const visibility   = (initialData?.visibility       as string | null) ?? null
  const acData       = (initialData?.accessControl    as Record<string, unknown> | null) ?? null
  const pricingData  = (initialData?.pricing          as Record<string, unknown> | null) ?? null
  const formData     = (initialData?.registrationForm as Record<string, unknown> | null) ?? null
  const detailsData  = (initialData?.eventDetails     as EventDetailsDraft | null) ?? null
  const reviewLicenseTier: AnyEventLicenseTier = isValidTierForVersion(initialData?.licenseTier, CURRENT_LICENSE_VERSION)
    ? initialData.licenseTier
    : defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)

  const isFreeEvent        = pricingData?.eventType === 'free'
  const isAlreadyPublished = draftStatus === 'published'

  // Build shareable event URL once — used by both the publish success screen
  // and the "Changes saved" banner.
  const _slug     = (detailsData ? normalizeEventDetailsDraft(detailsData) : null)?.seo as Record<string, unknown> | null | undefined
  const eventSlug = _slug?.urlSlug as string | undefined
  const eventPath = eventSlug ? `/e/${eventSlug}` : draftId ? `/e/${draftId}` : null
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

  // ── Interactive state — initialized from draft, persisted via onSaveDraft ──
  // RD-PAYMENT-02 Phase 7: normalize the stored fee model against the pricing-engine gate.
  // Dormant (production default) → organizer_absorbs, identical to before; when active, an
  // Attendee-Pays selection is honoured and persists across reloads.
  const feeEngineEnabled = useFeesConfig().pricingEngineEnabled
  const [localFeeModel,  setLocalFeeModel]  = useState<FeeModel>(() =>
    normalizeFeeModel(pricingData?.feeModel, feeEngineEnabled))
  const [localWhatsapp, setLocalWhatsapp] = useState<boolean>(!!pricingData?.whatsappEnabled)
  const [localSms,      setLocalSms]      = useState<boolean>(!!pricingData?.smsEnabled)
  const [localCert,     setLocalCert]     = useState<boolean>(!!pricingData?.certEnabled)

  // Communication cost estimate uses local interactive state. The Final Cost
  // Summary (F2.5) is the single source of truth for pricing — the standalone
  // Registration-Plan slider and Billing-Summary panels were removed, so their
  // derived totals (plan upgrade, platform-fee roll-up, GST) live there now.
  // Config-resolved per-message rates so the estimate matches the actual charge.
  const commConfig = useCommunicationConfig()
  const estimatedCapacity = estimateCapacity(pricingData)
  const commCostEstimate: CommunicationCostResult = calculateCommunicationCost({
    estimatedCapacity,
    whatsappEnabled: localWhatsapp,
    smsEnabled:      localSms,
    whatsappRatePaise: commConfig.whatsapp.pricePaise,
    smsRatePaise:      commConfig.sms.pricePaise,
  })
  // Per-certificate price from Business Configuration (SSOT) — no longer hardcoded.
  const certCostAmount = localCert ? estimatedCapacity * (commConfig.certificates.pricePaise / 100) : 0

  // Wallet balance check — only for draft publish flow; free events with comm channels
  const needsWalletCheck = !isAlreadyPublished && isFreeEvent && (localWhatsapp || localSms)

  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [walletLoading, setWalletLoading] = useState(false)
  const [payState, setPayState] = useState<'idle' | 'paying'>('idle')
  const [showAddFundsModal, setShowAddFundsModal] = useState(false)
  // Applied license coupon (validated by the wizard's cost summary; the server
  // re-validates + is authoritative). Sent to POST /api/licensing/purchase.
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(null)

  // Wallet is sufficient when: not needed, or balance >= estimated cost
  const walletReady = !needsWalletCheck ||
    (!walletLoading && walletBalance !== null && walletBalance >= commCostEstimate.totalPaise)
  // "Add Funds" mode: balance fetched, insufficient
  const showAddFundsMode = needsWalletCheck && !walletLoading && walletBalance !== null && !walletReady

  // Auto-save pricing changes (feeModel, comm toggles) back to the draft
  const savePricingChanges = useCallback((patch: Record<string, unknown>) => {
    onSaveDraft?.({ ...(pricingData ?? {}), feeModel: localFeeModel, whatsappEnabled: localWhatsapp, smsEnabled: localSms, certEnabled: localCert, ...patch })
  }, [onSaveDraft, pricingData, localFeeModel, localWhatsapp, localSms, localCert])

  const safeDetails = detailsData ? normalizeEventDetailsDraft(detailsData) : null

  const { showToast } = useToast()

  // Fetch wallet balance when free event with comm channels
  useEffect(() => {
    if (!needsWalletCheck) return
    setWalletLoading(true)
    auth.currentUser?.getIdToken()
      .then(tok => fetch('/api/organizer/wallet', {
        headers: { Authorization: `Bearer ${tok}` },
      }))
      .then(r => r.json() as Promise<WalletBalanceResponse>)
      .then(data => setWalletBalance(data.balancePaise))
      .catch(() => setWalletBalance(0))
      .finally(() => setWalletLoading(false))
  }, [needsWalletCheck])

  // ── Publish via API ────────────────────────────────────────────────────────
  const handlePublish = useCallback(() => {
    if (!allTermsAccepted || !report.canPublish || publishState !== 'idle') return
    setShowPublishConfirm(true)
  }, [allTermsAccepted, report.canPublish, publishState])

  const handleConfirmPublish = useCallback(async (confirmIdentityChange = false) => {
    if (publishState !== 'idle') return
    setPublishState('publishing')
    setShowPublishConfirm(false)

    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch('/api/events/publish', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ draftId, confirmIdentityChange }),
      })

      const json: PublishApiResponse = await res.json()

      if (!res.ok || !json.canPublish) {
        if (json.reason === 'WALLET_INSUFFICIENT') {
          // Race condition: wallet was drained between check and publish
          setWalletBalance(0)
          setPublishState('idle')
          showToast('Insufficient wallet balance. Please add funds and try again.', 'error')
        } else if (json.reason === 'EVENT_ALREADY_PUBLISHED') {
          setPublishState('published')
        } else if (json.reason === 'DRAFT_NOT_FOUND') {
          showToast('Draft not found. Please refresh the page and try again.', 'error')
          setPublishState('idle')
        } else if (json.reason === 'INCOMPLETE_REQUIRED_FIELDS') {
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
          setPublishState('idle')
        }
        return
      }

      setSubmittedStatus(json.lifecycleStatus === 'pending_review' ? 'pending_review' : 'published')
      onNext('Published', { publishedAt: json.publishedAt })
      setPublishState('published')
    } catch {
      showToast('Network error — check your connection and try again.', 'error')
      setPublishState('idle')
    }
  }, [publishState, draftId, onNext, showToast, setIdentityConfirm])

  // ── Wallet top-up via Razorpay ─────────────────────────────────────────────
  const [topupLoading, setTopupLoading] = useState(false)

  const handleTopupWallet = useCallback(async (amountPaise: number) => {
    if (topupLoading) return
    setTopupLoading(true)
    try {
      const tok = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/organizer/wallet/topup', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ amountPaise }),
      })
      const order: WalletTopupOrderResponse = await res.json()
      if (!res.ok) {
        showToast('Could not initiate payment. Please try again.', 'error')
        setTopupLoading(false)
        return
      }

      // Open Razorpay checkout
      const rzKey = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? ''
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      document.head.appendChild(script)
      script.onload = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rz = new (window as any).Razorpay({
          key:         rzKey,
          order_id:    order.orderId,
          amount:      order.amount,
          currency:    order.currency,
          name:        'RegisterDesk',
          description: 'Wallet top-up',
          handler: async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            try {
              const tok2  = await auth.currentUser?.getIdToken()
              const vRes  = await fetch('/api/organizer/wallet/topup/verify', {
                method:  'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(tok2 ? { Authorization: `Bearer ${tok2}` } : {}),
                },
                body: JSON.stringify({
                  orderId:   resp.razorpay_order_id,
                  paymentId: resp.razorpay_payment_id,
                  signature: resp.razorpay_signature,
                }),
              })
              const vJson: WalletTopupVerifyResponse = await vRes.json()
              if (vJson.success) {
                setWalletBalance(vJson.newBalance ?? 0)
                setShowAddFundsModal(false)
                showToast('Wallet funded successfully!', 'success')
              } else {
                showToast(vJson.error ?? 'Payment verification failed.', 'error')
              }
            } catch {
              showToast('Network error during verification. Please contact support.', 'error')
            } finally {
              setTopupLoading(false)
            }
          },
          modal: { ondismiss: () => setTopupLoading(false) },
        })
        rz.open()
      }
      script.onerror = () => {
        showToast('Could not load payment SDK. Check your connection.', 'error')
        setTopupLoading(false)
      }
    } catch {
      showToast('Network error — please try again.', 'error')
      setTopupLoading(false)
    }
  }, [topupLoading, showToast])

  // ── License payment (F2.2) — wallet-first, then Razorpay for the remainder ──
  // Effective (config-aware) catalog so paid-tier detection matches the server.
  const licenseView    = useCurrentLicenseCatalogView()
  const licenseDef: LicenseCatalogEntryView = licenseView.find(e => e.tier === reviewLicenseTier) ?? licenseView[0]
  const isPaidLicense  = licenseDef.licensePricePaise > 0
  // Every paid tier (Growth/Professional/Enterprise) goes through payment; Starter
  // (free) submits directly. undefined → 'Submit Event'.
  const submitLabel    = isPaidLicense ? 'Continue to Payment' : undefined

  // Finalize the purchase (deduct wallet + persist), then auto-submit the event.
  const confirmAndSubmit = useCallback(async (
    walletUsePaise: number,
    razorpay?: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
  ) => {
    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch('/api/licensing/checkout/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body:    JSON.stringify({ eventId: draftId, tier: reviewLicenseTier, walletUsePaise, ...(razorpay ?? {}) }),
      })
      const json = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Could not confirm payment')
      setPayState('idle')
      void handleConfirmPublish()   // automatic submission — no second click
    } catch (e) {
      setPayState('idle')
      showToast(e instanceof Error ? e.message : 'Could not confirm payment. Your draft is saved — you can retry.', 'error')
    }
  }, [draftId, reviewLicenseTier, handleConfirmPublish, showToast])

  const handlePayAndSubmit = useCallback(async () => {
    // Starter (free) or Enterprise (contact sales) → submit directly (no payment).
    if (!isPaidLicense) { handlePublish(); return }
    // Phase 3 — HARD GATE: never open Razorpay while blockers remain. Stay on the
    // Review page and scroll to Action Required. (The button is also disabled in
    // this state; this is a defensive second gate — "no exceptions".)
    if (!report.canPublish) {
      document.getElementById('publish-readiness')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (payState !== 'idle' || !draftId || !allTermsAccepted) return
    setPayState('paying')
    console.info('[publish] payment started', { draftId, tier: reviewLicenseTier })
    try {
      const token = await auth.currentUser?.getIdToken()
      const pRes  = await fetch('/api/licensing/purchase', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body:    JSON.stringify({ eventId: draftId, tier: reviewLicenseTier, ...(appliedCouponCode ? { couponCode: appliedCouponCode } : {}) }),
      })
      const purchase = await pRes.json() as {
        ok?: boolean; alreadyPaid?: boolean; message?: string; error?: string
        walletUsePaise?: number; remainderPaise?: number
        checkout?: { keyId: string; razorpayOrderId: string; amountPaise: number } | null
      }
      if (!pRes.ok || !purchase.ok) throw new Error(purchase.message ?? purchase.error ?? 'Could not start payment')

      // Phase 7 — RETRY without a second charge: a paid license already exists for
      // this draft (payment succeeded before but publish failed). Skip Razorpay and
      // re-run submission directly. Never charge twice.
      if (purchase.alreadyPaid) {
        console.info('[publish] retry — license already paid, no charge', { draftId })
        setPayState('idle')
        void handleConfirmPublish()
        return
      }

      const walletUsePaise = purchase.walletUsePaise ?? 0
      const remainderPaise = purchase.remainderPaise ?? 0

      // Wallet fully covers the price → confirm directly, no Razorpay.
      if (remainderPaise <= 0 || !purchase.checkout) { await confirmAndSubmit(walletUsePaise); return }

      // Remainder → reuse the existing Razorpay checkout script.
      const checkout = purchase.checkout
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rz = new (window as any).Razorpay({
          key:         checkout.keyId,
          order_id:    checkout.razorpayOrderId,
          amount:      checkout.amountPaise,
          currency:    'INR',
          name:        'RegisterDesk',
          description: `${licenseDef.name} License`,
          handler: (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            void confirmAndSubmit(walletUsePaise, resp)
          },
          modal: { ondismiss: () => { setPayState('idle'); showToast('Payment cancelled. Your draft is saved — you can retry.', 'error') } },
        })
        rz.open()
      }
      script.onerror = () => { setPayState('idle'); showToast('Could not load payment. Please retry.', 'error') }
      document.body.appendChild(script)
    } catch (e) {
      setPayState('idle')
      showToast(e instanceof Error ? e.message : 'Payment failed. Your draft is saved — you can retry.', 'error')
    }
  }, [isPaidLicense, payState, draftId, allTermsAccepted, report.canPublish, reviewLicenseTier, licenseDef, appliedCouponCode, handlePublish, handleConfirmPublish, confirmAndSubmit, showToast])

  // ── Save changes for already-published events ──────────────────────────────
  const handleSaveChanges = useCallback(async () => {
    if (saveChangesState !== 'idle') return
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
      const json: { success: boolean; error?: string } = await res.json()
      if (!res.ok) {
        showToast(json.error ?? 'Failed to save changes.', 'error')
        setSaveChangesState('idle')
        return
      }
      showToast('Changes saved — your public event page has been updated.', 'success')
      setSaveChangesState('idle')
    } catch {
      showToast('Network error — check your connection and try again.', 'error')
      setSaveChangesState('idle')
    }
  }, [saveChangesState, draftId, showToast])

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

  // -- Main review view ------------------------------------------------------
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      <Link href={ROUTES.DASHBOARD}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
        <ArrowLeft className="size-4" aria-hidden />Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      {/* Header row with Preview button */}
      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">
            Review &amp; {isAlreadyPublished ? 'Save' : 'Submit'}
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isAlreadyPublished
              ? 'Review your changes and save to update your live event.'
              : 'Review your event and publish when ready.'}
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
            {blockerItems.length > 0 && (
              <div className="border-t border-border/40 px-5 pb-5 pt-4 sm:px-6">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Action required
                </p>
                <div className="flex flex-col gap-2">
                  {blockerItems.map((req) => (
                    <button
                      key={req.id}
                      type="button"
                      onClick={() => onGoToStep?.(req.stepIndex, req.fieldHint)}
                      className="group flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3.5 text-left transition-all duration-200 hover:border-primary/25 hover:bg-card hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-100">
                          <AlertCircle className="size-3.5 text-amber-600" aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-foreground">{req.title}</p>
                          <p className="mt-0.5 text-[12px] text-muted-foreground">{req.description}</p>
                        </div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        Fix now <ArrowRight className="size-3" aria-hidden />
                      </span>
                    </button>
                  ))}
                </div>
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

        {/* ── REVIEW GRID: Left 70% content · Right 30% sticky Final Cost Summary (F2.5) ── */}
        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">

          {/* ── LEFT COLUMN (70%) ──────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-5">

            {/* Fee Collection Method */}
            <FeeCollectionCard
              feeModel={localFeeModel}
              onChange={v => { setLocalFeeModel(v); savePricingChanges({ feeModel: v }) }}
              samplePrice={passes.find(p => p.price && p.price > 0)?.price}
            />

            {/* Communication Services */}
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
                  <Zap className="size-4 text-primary" aria-hidden />
                </div>
                <div>
                  <p className="text-[15px] font-bold tracking-tight text-foreground">Communication Services</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">Enable paid add-ons for this event</p>
                </div>
              </div>
              <RegisterDeskServicesPricingSection
                isFreeEvent={isFreeEvent}
                values={{ whatsappEnabled: localWhatsapp, smsEnabled: localSms, certEnabled: localCert }}
                onChange={(field, value) => {
                  if (field === 'whatsappEnabled') { setLocalWhatsapp(value); savePricingChanges({ whatsappEnabled: value }) }
                  if (field === 'smsEnabled')      { setLocalSms(value);      savePricingChanges({ smsEnabled:      value }) }
                  if (field === 'certEnabled')     { setLocalCert(value);     savePricingChanges({ certEnabled:     value }) }
                }}
                standalone={false}
              />
              <div className="border-t border-border/30 bg-muted/[0.03] px-5 py-3.5 sm:px-6">
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-semibold text-foreground">Why are these paid? </span>
                  Email confirmations are always free. WhatsApp, SMS, and certificates require third-party
                  integrations with per-message costs. For paid events, charges are deducted from settlement —
                  no upfront payment needed. Free events require wallet balance before publishing.
                </p>
              </div>
            </div>

          </div>
          {/* END LEFT COLUMN */}

          {/* ── RIGHT COLUMN (30%) · sticky single-source Final Cost Summary (F2.5) ── */}
          {/* order-first on mobile → summary shows above the left content; natural order on desktop */}
          <div className="order-first lg:order-none lg:sticky lg:top-4 lg:self-start">
            <FinalCostSummary
              tier={reviewLicenseTier}
              isFreeEvent={isFreeEvent}
              walletBalancePaise={walletBalance}
              walletLoading={walletLoading}
              whatsappEnabled={localWhatsapp}
              smsEnabled={localSms}
              certEnabled={localCert}
              whatsappCostRupees={commCostEstimate.whatsappCost}
              smsCostRupees={commCostEstimate.smsCost}
              certCostRupees={certCostAmount}
              needsWalletCheck={needsWalletCheck}
              walletReady={walletReady}
              onAddFunds={() => setShowAddFundsModal(true)}
              eventId={draftId ?? undefined}
              onCouponChange={setAppliedCouponCode}
            />
          </div>
          {/* END RIGHT COLUMN */}

        </div>
        {/* END MAIN GRID */}

        {/* 4. PUBLISH STATUS / LIVE STATUS */}
        {isAlreadyPublished ? (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-200/60 bg-emerald-50/60 px-4 py-3.5 shadow-sm">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100">
              <Globe className="size-4 text-emerald-600" aria-hidden />
            </div>
            <div className="flex-1">
              <p className="text-[13.5px] font-bold text-emerald-800">Event is Live</p>
              <p className="text-[12px] text-emerald-700">Changes will apply to your public event page immediately after saving.</p>
            </div>
            {eventUrl && (
              <Link href={eventUrl} target="_blank" rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline' }), 'shrink-0 gap-1.5 text-[12px]')}>
                <ExternalLink className="size-3.5" aria-hidden />View Live
              </Link>
            )}
          </div>
        ) : report.canPublish ? (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-200/60 bg-emerald-50/60 px-4 py-3.5 shadow-sm">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
            </div>
            <div>
              <p className="text-[13.5px] font-bold text-emerald-800">Ready to Publish</p>
              <p className="text-[12px] text-emerald-700">All required sections are complete. Your event goes live immediately after publishing.</p>
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

        {/* 4. PUBLISH AGREEMENT — draft events only */}
        {!isAlreadyPublished && <div className={cn(
          'overflow-hidden rounded-xl border shadow-sm transition-colors',
          allTermsAccepted ? 'border-emerald-200/60 bg-emerald-50/10' : 'border-border bg-card',
        )}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Shield className="size-3.5 text-muted-foreground" aria-hidden />
              <p className="text-[13px] font-semibold text-foreground">Publish Agreement</p>
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
                <button type="button"
                  onClick={() => termsFees ? setFeesAcceptedAt(null) : setShowCommercialModal(true)}
                  role="checkbox" aria-checked={termsFees}
                  className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all focus-visible:outline-none',
                    termsFees ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                  {termsFees && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
                </button>
                <p className={cn('text-[13px]', termsFees ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  I understand{' '}
                  <button type="button" onClick={() => setShowCommercialModal(true)}
                    className="text-primary underline underline-offset-2 hover:no-underline">
                    settlement timelines and fee policy
                  </button>
                  .{feesAcceptedAt && <span className="ml-1.5 text-[12px] text-emerald-600">Reviewed ✓</span>}
                </p>
              </div>
            )}

            {/* 3: ToS */}
            <button type="button" onClick={() => setConsentFeeModel(v => !v)} role="checkbox" aria-checked={consentFeeModel}
              className="flex items-center gap-3 py-3.5 text-left focus-visible:outline-none">
              <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all',
                consentFeeModel ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                {consentFeeModel && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
              </span>
              <span className={cn('text-[13px]', consentFeeModel ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                I agree to RegisterDesk <span className="text-primary underline underline-offset-2">Terms of Service</span>.
              </span>
            </button>

            {/* 4: Privacy */}
            <button type="button" onClick={() => setConsentTimeline(v => !v)} role="checkbox" aria-checked={consentTimeline}
              className="flex items-center gap-3 py-3.5 text-left focus-visible:outline-none">
              <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded border-2 transition-all',
                consentTimeline ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/50')}>
                {consentTimeline && <Check className="size-2.5 text-primary-foreground" aria-hidden />}
              </span>
              <span className={cn('text-[13px]', consentTimeline ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                I agree to RegisterDesk <span className="text-primary underline underline-offset-2">Privacy Policy</span>.
              </span>
            </button>
          </div>
        </div>}

      {(publishState === 'publishing' || saveChangesState === 'saving') && (
        <div className="flex items-center justify-center gap-2 py-3 text-[13px] text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" aria-hidden />
          {saveChangesState === 'saving' ? 'Saving changes…' : 'Publishing your event…'}
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

      {/* Add Funds Modal */}
      <AnimatePresence>
        {showAddFundsModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
            onClick={() => setShowAddFundsModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1,    y: 0 }}
              exit={{ opacity:   0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.25, ease: EASE }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
            >
              {/* Header */}
              <div className="border-b border-border px-5 py-4">
                <div className="flex items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Wallet className="size-4 text-primary" aria-hidden />
                    </div>
                    <div>
                      <p className="text-[15px] font-bold text-foreground">Add Funds to Wallet</p>
                      <p className="text-[13px] text-muted-foreground">Top up your organizer wallet to publish this event.</p>
                    </div>
                  </div>
                  <button type="button" onClick={() => setShowAddFundsModal(false)} className="shrink-0 text-muted-foreground hover:text-foreground">
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="px-5 py-4">
                {/* Balance summary */}
                <div className="mb-4 divide-y divide-border/40 overflow-hidden rounded-xl border border-border">
                  <div className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                    <span className="text-muted-foreground">Required for publish</span>
                    <span className="font-semibold text-foreground">{formatINR(commCostEstimate.totalCost)}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                    <span className="text-muted-foreground">Current balance</span>
                    <span className="font-medium text-foreground">
                      {walletBalance !== null ? formatINR(walletBalance / 100) : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between bg-muted/[0.03] px-4 py-3 text-[13px]">
                    <span className="font-semibold text-foreground">Amount to add</span>
                    <span className="font-bold text-primary">
                      {walletBalance !== null
                        ? formatINR(Math.max(0, commCostEstimate.totalPaise - walletBalance) / 100)
                        : formatINR(commCostEstimate.totalCost)}
                    </span>
                  </div>
                </div>

                <p className="text-[12px] text-muted-foreground">
                  Funds are charged from your wallet when WhatsApp or SMS messages are sent to attendees.
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setShowAddFundsModal(false)}
                  className="text-[13px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const shortfall = walletBalance !== null
                      ? Math.max(0, commCostEstimate.totalPaise - walletBalance)
                      : commCostEstimate.totalPaise
                    handleTopupWallet(shortfall > 0 ? shortfall : commCostEstimate.totalPaise)
                  }}
                  className={cn(buttonVariants({ variant: 'primary' }), 'gap-1.5 text-[13px]')}
                >
                  <Wallet className="size-3.5" aria-hidden />
                  Add Funds via Razorpay
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {identityConfirm && (
          <IdentityConfirmModal
            open={!!identityConfirm}
            governance={identityConfirm}
            onCancel={() => setIdentityConfirm(null)}
            onConfirm={() => { setIdentityConfirm(null); void handleConfirmPublish(true) }}
            isPublishing={publishState === 'publishing'}
          />
        )}
      </AnimatePresence>

      <WizardFooter
        onBack={onBack}
        onNext={
          isAlreadyPublished
            ? handleSaveChanges
            : showAddFundsMode
              ? () => setShowAddFundsModal(true)
              : handlePayAndSubmit
        }
        isFinalStep
        nextLabel={
          isAlreadyPublished
            ? 'Save Changes'
            : showAddFundsMode
              ? 'Add Funds'
              : payState === 'paying'
                ? 'Processing…'
                : submitLabel
        }
        isNextDisabled={
          isAlreadyPublished
            ? saveChangesState === 'saving'
            : showAddFundsMode
              ? false
              : !allTermsAccepted || !report.canPublish || publishState !== 'idle' || !walletReady || payState !== 'idle'
        }
        stepContext={(() => {
          const steps = wizardSteps ?? WIZARD_STEPS
          return `Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`
        })()}
      />
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
    const detailsValid = isCampaignDetailsValid(campaignDetails)
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

function LicenseStepView({
  currentStep, completedValues, onNext, onBack, steps, selectedTier, onSelectLicense,
}: {
  currentStep:     number
  completedValues: (string | undefined)[]
  onNext:          (label?: string, data?: unknown) => void
  onBack:          () => void
  steps:           WizardStep[]
  selectedTier:    AnyEventLicenseTier
  onSelectLicense: (t: AnyEventLicenseTier) => void
}) {
  const [tier, setTier] = useState<AnyEventLicenseTier>(selectedTier)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const licenseView = useCurrentLicenseCatalogView()

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!token) { if (alive) setWalletBalance(0); return }
        const res  = await fetch('/api/organizer/wallet', { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json() as WalletBalanceResponse
        if (alive) setWalletBalance(typeof data.balancePaise === 'number' ? data.balancePaise : 0)
      } catch { if (alive) setWalletBalance(0) }
    })()
    return () => { alive = false }
  }, [])

  const select = (t: AnyEventLicenseTier) => { setTier(t); onSelectLicense(t) }
  const tierName = (t: AnyEventLicenseTier): string => (licenseView.find(e => e.tier === t) ?? licenseView[0]).name
  const handleNext = () => { onSelectLicense(tier); onNext(`License: ${tierName(tier)}`, tier) }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={steps} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">Choose your Event License</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Every event runs on a license. Pick the tier for this event — you can see the price, registration
          limit, and wallet impact below. You’ll pay after submitting.
        </p>
      </div>

      <div className="mt-5 flex-1">
        <LicenseCards selected={tier} onSelect={select} walletBalancePaise={walletBalance} />
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={handleNext}
        stepContext={`Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`}
      />
    </motion.div>
  )
}

// --- Wizard -------------------------------------------------------------------

export default function CreateEventWizard() {
  const {
    draft, isLoading, createDraft, updateDraft, autosaveDraft, flushNow, markPublished,
    saveState, lastSavedAt, hasUnsavedChanges, conflict, resolveConflict,
  } = useDraft()

  // RD-PRODUCT-01B: warn on tab close/reload while a save is pending or in flight.
  useUnsavedChangesWarning(hasUnsavedChanges, flushNow)

  // Buffers the Step 1 (category) and Step 2 (visibility) selections BEFORE any
  // Firestore document exists. These seed the deferred createDraft and let the
  // organizer navigate Back without losing choices while no draft is persisted.
  // Held in state (not a ref) so it can be safely read during render.
  const [pending, setPending] = useState<{ step0: Step1State | null; visibility: VisibilityId | null }>({
    step0:      null,
    visibility: null,
  })

  const [currentStep,     setCurrentStep]     = useState(0)
  // Over-provisioned to 8 — the max across all wizard types (event_plus_donation has 8 steps)
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

  // On first load, seed wizard state from the persisted draft
  useEffect(() => {
    if (isLoading || hydrated) return
    if (draft) {
      setCurrentStep(draft.currentStep ?? 0)
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
      const step0      = step === 0 ? (data as Step1State)  : pending.step0
      const visibility = step === 1 ? (data as VisibilityId) : pending.visibility
      if (step === 0 || step === 1) setPending({ step0, visibility })

      // ── First Firestore write — happens ONLY here, on an explicit Continue ──
      // • donation-only commits at the Category step (it has no Visibility step
      //   and forks to the campaign wizard immediately after).
      // • every other event type commits at the Visibility step.
      const donationOnlyCommit = step === 0 && step0?.campaignType === 'donation_only'
      const standardCommit     = step === 1
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
      if (step === 0) {
        const d = data as Step1State | null
        payload.eventType          = d?.eventType     ?? null
        payload.eventSubtype       = d?.subtype       ?? null
        payload.customEventSubtype = d?.customSubtype ?? null
        payload.campaignType       = d?.campaignType  ?? null
      }
      if (step === 1) payload.visibility       = data
      if (step === 2) payload.accessControl    = data
      if (step === 3) payload.pricing          = data
      if (step === 4) payload.registrationForm = data
      if (step === 5) payload.eventDetails     = data
      // Step 6: Fundraising (event_plus_donation) saves the linked campaign.
      if (step === 6 && isEventPlusDonation) payload.linkedCampaign = data
      // NOTE (LS2.2): the client must NEVER write `publishedAt` — it is a
      // server-controlled field (set only by the Admin-SDK publish route) and
      // firestore.rules blocks any client draft update whose affectedKeys include
      // it. Writing it here was the root cause of the wizard's
      // "Missing or insufficient permissions" error on reaching the Review step.

      void updateDraft(payload)
    },
    [currentStep, completedValues, createDraft, updateDraft, markPublished, isEventPlusDonation, draft?.id, pending],
  )

  const goBack = useCallback(
    () => setCurrentStep(s => Math.max(s - 1, 0)),
    [],
  )

  const [stepFocusHint, setStepFocusHint] = useState<string | undefined>(undefined)

  const goToStep = useCallback(
    (step: number, fieldHint?: string) => {
      setCurrentStep(step)
      setStepFocusHint(fieldHint)
    },
    [],
  )

  // Called by "Save Draft" buttons (no step advance)
  const saveDraft = useCallback(
    async (step: number, data?: unknown) => {
      // Keep the buffer current so a Save Draft on Step 1/2 seeds creation.
      const step0      = step === 0 ? (data as Step1State)  : pending.step0
      const visibility = step === 1 ? (data as VisibilityId) : pending.visibility
      if (step === 0 || step === 1) setPending({ step0, visibility })

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

      const payload: Record<string, unknown> = {}
      if (step === 0) {
        const d = data as Step1State | null
        payload.eventType          = d?.eventType     ?? null
        payload.eventSubtype       = d?.subtype       ?? null
        payload.customEventSubtype = d?.customSubtype ?? null
        payload.campaignType       = d?.campaignType  ?? null
      }
      if (step === 1) payload.visibility        = data
      if (step === 2) payload.accessControl     = data
      if (step === 3) payload.pricing           = data
      if (step === 4) payload.registrationForm  = data
      if (step === 5) payload.eventDetails      = data
      // Step 6: linkedCampaign draft for event_plus_donation (Fundraising step).
      if (step === 6 && isEventPlusDonation)  payload.linkedCampaign = data
      // License step (index 6 standard / 7 event_plus_donation) persists the tier.
      if (step === 6 && !isEventPlusDonation) payload.licenseTier    = data
      if (step === 7 && isEventPlusDonation)  payload.licenseTier    = data
      // Review step (index 7 standard / 8 event_plus_donation): save updated pricing (feeModel).
      if (step === 7 && !isEventPlusDonation) payload.pricing        = data
      if (step === 8 && isEventPlusDonation)  payload.pricing        = data
      if (Object.keys(payload).length) {
        void updateDraft(payload)
      }
    },
    [createDraft, updateDraft, isEventPlusDonation, draft?.id, pending],
  )

  // RD-PRODUCT-01B: within-step autosave funnel — same step→payload mapping as
  // saveDraft, but debounced via the hook. Only the major editing steps are wired;
  // a draft always exists by the time these steps are reachable.
  const autosave = useCallback(
    (step: number, data: unknown) => {
      if (!draft?.id) return
      const payload: Record<string, unknown> = {}
      if (step === 3) payload.pricing          = data
      if (step === 4) payload.registrationForm = data
      if (step === 5) payload.eventDetails     = data
      if (Object.keys(payload).length) autosaveDraft(payload)
    },
    [autosaveDraft, draft?.id],
  )

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
  const sharedProps = { completedValues, onNext: goNext, onBack: goBack, wizardSteps: isEventPlusDonation ? FUNDRAISING_EVENT_WIZARD_STEPS : WIZARD_STEPS }

  // Selected Event License tier (F2.1) — defaults to Starter until the organizer chooses.
  const selectedLicense: AnyEventLicenseTier = isValidTierForVersion(draft?.licenseTier, CURRENT_LICENSE_VERSION)
    ? draft.licenseTier
    : defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)
  const onSelectLicense = (t: AnyEventLicenseTier) => { void updateDraft({ licenseTier: t }) }

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
      {conflict && <DraftRecoveryPrompt conflict={conflict} onResolve={resolveConflict} />}
      {currentStep === 0 && (
        <Step1View
          currentStep={0}
          {...sharedProps}
          onSaveDraft={data => saveDraft(0, data)}
          initialData={{
            eventType:          draft?.eventType          ?? pending.step0?.eventType     ?? null,
            eventSubtype:       draft?.eventSubtype        ?? pending.step0?.subtype       ?? null,
            customEventSubtype: draft?.customEventSubtype  ?? pending.step0?.customSubtype ?? null,
            campaignType:       (draft?.campaignType as CampaignType | null) ?? pending.step0?.campaignType ?? null,
          }}
        />
      )}
      {currentStep === 1 && (
        <Step2View
          currentStep={1}
          {...sharedProps}
          onSaveDraft={data => saveDraft(1, data)}
          initialData={{ visibility: draft?.visibility ?? pending.visibility ?? null }}
        />
      )}
      {currentStep === 2 && (
        <Step3View
          currentStep={2}
          {...sharedProps}
          onSaveDraft={data => saveDraft(2, data)}
          initialData={(draft?.accessControl as Record<string, unknown> | null) ?? null}
        />
      )}
      {currentStep === 3 && (
        <Step4View
          currentStep={3}
          {...sharedProps}
          onSaveDraft={data => saveDraft(3, data)}
          onAutosave={data => autosave(3, data)}
          initialData={{ pricing: draft?.pricing ?? null, eventTypeId: draft?.eventType ?? null, eventSubtype: draft?.eventSubtype ?? null }}
        />
      )}
      {currentStep === 4 && (
        <Step5View
          currentStep={4}
          {...sharedProps}
          onSaveDraft={data => saveDraft(4, data)}
          onAutosave={data => autosave(4, data)}
          initialData={{
            registrationForm: draft?.registrationForm ?? null,
            eventTypeId:      draft?.eventType        ?? null,
            eventSubtype:     draft?.eventSubtype      ?? null,
            pricing:          draft?.pricing          ?? null,
            accessControl:    draft?.accessControl    ?? null,
          }}
        />
      )}
      {currentStep === 5 && (
        <Step6View
          currentStep={5}
          {...sharedProps}
          focusHint={stepFocusHint}
          onSaveDraft={data => saveDraft(5, data)}
          onAutosave={data => autosave(5, data)}
          initialData={{
            eventDetails: draft?.eventDetails ?? null,
            eventTypeId:  draft?.eventType    ?? null,
            eventSubtype: draft?.eventSubtype  ?? null,
            pricing:      draft?.pricing      ?? null,
            draftId:      draft?.id           ?? null,
          }}
        />
      )}
      {/* Step 6: Fundraising setup for event_plus_donation, or Review for all other types */}
      {currentStep === 6 && isEventPlusDonation && (
        <LinkedCampaignStep
          currentStep={6}
          completedValues={completedValues}
          onNext={goNext}
          onBack={goBack}
          onSaveDraft={data => saveDraft(6, data)}
          wizardSteps={FUNDRAISING_EVENT_WIZARD_STEPS}
          initialData={{
            linkedCampaign: draft?.linkedCampaign ?? null,
            eventEndDate:   (draft?.eventDetails as Record<string, unknown> | null)?.endDate as string | null ?? null,
          }}
        />
      )}
      {/* Step 6 (standard) / Step 7 (event_plus_donation): License selection */}
      {currentStep === 6 && !isEventPlusDonation && (
        <LicenseStepView
          currentStep={6}
          completedValues={completedValues}
          onNext={goNext}
          onBack={goBack}
          steps={WIZARD_STEPS}
          selectedTier={selectedLicense}
          onSelectLicense={onSelectLicense}
        />
      )}
      {currentStep === 7 && isEventPlusDonation && (
        <LicenseStepView
          currentStep={7}
          completedValues={completedValues}
          onNext={goNext}
          onBack={goBack}
          steps={FUNDRAISING_EVENT_WIZARD_STEPS}
          selectedTier={selectedLicense}
          onSelectLicense={onSelectLicense}
        />
      )}
      {/* Review — Step 7 (standard) / Step 8 (event_plus_donation) */}
      {currentStep === 7 && !isEventPlusDonation && (
        <Step7View
          currentStep={7}
          {...sharedProps}
          onGoToStep={goToStep}
          onSaveDraft={data => saveDraft(7, data)}
          initialData={{
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
          }}
        />
      )}
      {currentStep === 8 && isEventPlusDonation && (
        <Step7View
          currentStep={8}
          completedValues={completedValues}
          onNext={goNext}
          onBack={goBack}
          onGoToStep={goToStep}
          onSaveDraft={data => saveDraft(8, data)}
          wizardSteps={FUNDRAISING_EVENT_WIZARD_STEPS}
          initialData={{
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
          }}
        />
      )}
    </>
  )
}
