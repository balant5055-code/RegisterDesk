'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useDraft } from '@/lib/hooks/useDraft'
import { useCampaignDraft } from '@/lib/hooks/useCampaignDraft'
import {
  type CampaignType,
  type DonationCampaignSubtype,
  DONATION_SUBTYPE_LABELS,
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
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Award,
  Check,
  CheckCircle2,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Coffee,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  Gift,
  Globe,
  GraduationCap,
  Hash,
  Headphones,
  Heart,
  IndianRupee,
  Info,
  Lightbulb,
  Link2,
  Lock,
  Mail,
  MapPin,
  MoreHorizontal,
  Music,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Sparkles,
  Store,
  Tag,
  Ticket,
  Trash2,
  TrendingUp,
  Trophy,
  Upload,
  UserCheck,
  Users,
  Wallet,
  Wand2,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { AddPassEditor, type EventPassFull, makeBlankPass } from '@/components/wizard/AddPassEditor'
import type { PassSummary } from '@/components/wizard/RegistrationFormBuilder'
import { makeBlankFormDraft, type RegistrationFormDraft, type FormField, type FormSection, type RegistrationRules } from '@/components/wizard/registrationFormConfig'
import { getTemplate } from '@/lib/events/templateRegistry'
import { makeBlankEventDetailsDraft, calcStepHealth, normalizeEventDetailsDraft, type EventDetailsDraft, type Speaker, type Sponsor, type AgendaSession, ONLINE_PLATFORM_LABELS, SPONSOR_TIER_LABELS, SESSION_TYPE_LABELS } from '@/components/wizard/eventDetailsConfig'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { auth } from '@/lib/firebase/auth'
import { calculateCommunicationCost } from '@/lib/events/communicationCost'
import { estimateCapacity }           from '@/lib/events/estimateCapacity'
import { evaluatePublishRequirements, type PublishRequirement } from '@/lib/events/publishRequirements'
import type { CommunicationCostResult, PublishApiResponse, WalletBalanceResponse, WalletTopupOrderResponse, WalletTopupVerifyResponse } from '@/types/events'
import { isEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import { useLicenseCatalog } from '@/lib/licensing/licenseCatalogClient'
import { useBranding } from '@/lib/config/brandingClient'
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
const RegistrationFormBuilder = dynamic(
  () => import('@/components/wizard/RegistrationFormBuilder').then(m => m.RegistrationFormBuilder), { loading: builderLoading },
)
const EventDetailsBuilder = dynamic(
  () => import('@/components/wizard/EventDetailsBuilder').then(m => m.EventDetailsBuilder), { loading: builderLoading },
)
const LinkedCampaignStep = dynamic(
  () => import('@/components/wizard/LinkedCampaignStep').then(m => m.LinkedCampaignStep), { loading: builderLoading },
)
const TemplatePreviewPanel = dynamic(
  () => import('@/components/wizard/TemplatePreviewPanel').then(m => m.TemplatePreviewPanel), { loading: builderLoading },
)
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

const EASE = [0.22, 1, 0.36, 1] as const

interface WizardStep { name: string }

const WIZARD_STEPS: WizardStep[] = [
  { name: 'Event Type' },
  { name: 'Visibility' },
  { name: 'Access Control' },
  { name: 'Passes & Pricing' },
  { name: 'Form' },
  { name: 'Details' },
  { name: 'License' },
  { name: 'Review' },
]

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

// Donation-only subtypes — replaces the ticket-based fundraising subtypes
const DONATION_CAMPAIGN_SUBTYPES: Array<{ id: DonationCampaignSubtype; label: string }> = [
  { id: 'medical',     label: DONATION_SUBTYPE_LABELS.medical },
  { id: 'ngo',         label: DONATION_SUBTYPE_LABELS.ngo },
  { id: 'disaster',    label: DONATION_SUBTYPE_LABELS.disaster },
  { id: 'animal',      label: DONATION_SUBTYPE_LABELS.animal },
  { id: 'education',   label: DONATION_SUBTYPE_LABELS.education },
  { id: 'environment', label: DONATION_SUBTYPE_LABELS.environment },
  { id: 'community',   label: DONATION_SUBTYPE_LABELS.community },
  { id: 'other',       label: DONATION_SUBTYPE_LABELS.other },
]

// --- Step 1 constants ---------------------------------------------------------

interface EventTypeOption {
  id:            string
  name:          string
  description:   string
  examples:      string
  icon:          LucideIcon
  iconBg:        string
  iconColor:     string
  hasDiscipline?: boolean
}

const EVENT_TYPES: EventTypeOption[] = [
  {
    id: 'conference',
    name: 'Conference',
    description: 'Large-scale meetings with speakers, sessions and attendees.',
    examples: 'Business, Corporate, Rotary, Summit',
    icon: Users,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
  },
  {
    id: 'exhibition',
    name: 'Exhibition & Expo',
    description: 'Exhibitions, trade shows and product showcases.',
    examples: 'Trade Show, Expo, Fair, Showcase',
    icon: Store,
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-500',
  },
  {
    id: 'sports',
    name: 'Sports & Fitness',
    description: 'Sports events, marathons, tournaments and fitness activities.',
    examples: 'Marathon, Cycling, Cricket, Football, Tennis',
    icon: Trophy,
    iconBg: 'bg-green-100',
    iconColor: 'text-green-600',
    hasDiscipline: true,
  },
  {
    id: 'workshop',
    name: 'Workshop & Training',
    description: 'Educational workshops, training programs and bootcamps.',
    examples: 'Workshop, Training, Certification, Masterclass',
    icon: GraduationCap,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
  },
  {
    id: 'meetup',
    name: 'Business Meetup',
    description: 'Networking events and professional business gatherings.',
    examples: 'Meetup, Networking, Startup, Investor',
    icon: Coffee,
    iconBg: 'bg-rose-100',
    iconColor: 'text-rose-500',
  },
  {
    id: 'community',
    name: 'Community & Awareness',
    description: 'Community programs, NGO activities and awareness campaigns.',
    examples: 'Awareness, NGO, Volunteer, Social Impact',
    icon: Heart,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
  },
  {
    id: 'cultural',
    name: 'Cultural & Entertainment',
    description: 'Music, arts, cultural programs and entertainment events.',
    examples: 'Concert, Festival, Show, DJ Night',
    icon: Music,
    iconBg: 'bg-purple-100',
    iconColor: 'text-purple-600',
  },
  {
    id: 'awards',
    name: 'Awards & Recognition',
    description: 'Award ceremonies and recognition programs.',
    examples: 'Awards Night, Graduation, Excellence Awards',
    icon: Award,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
  },
  {
    id: 'fundraising',
    name: 'Fundraising & Charity',
    description: 'Donation drives and fundraising events.',
    examples: 'Charity Run, Fundraiser, Donation Campaign',
    icon: Gift,
    iconBg: 'bg-pink-100',
    iconColor: 'text-pink-600',
  },
  {
    id: 'custom',
    name: 'Custom Event',
    description: 'Create a fully customized event experience.',
    examples: 'Custom, Special Event, Hybrid Event',
    icon: Wand2,
    iconBg: 'bg-slate-100',
    iconColor: 'text-slate-600',
  },
]

// Config-driven secondary subtype options for each event type
interface SubtypeOption { id: string; name: string }
interface SubtypeConfig { label: string; hint: string; options: SubtypeOption[] }

function sub(id: string, name: string): SubtypeOption { return { id, name } }

const SUBTYPES_BY_EVENT_TYPE: Record<string, SubtypeConfig> = {
  conference: {
    label: 'Conference Style',
    hint:  'Select the format that best describes your conference.',
    options: [
      sub('business',  'Business'),     sub('corporate', 'Corporate'),
      sub('rotary',    'Rotary'),       sub('summit',    'Summit'),
      sub('academic',  'Academic'),     sub('medical',   'Medical'),
      sub('tech',      'Tech'),         sub('other',     'Other'),
    ],
  },
  exhibition: {
    label: 'Expo Type',
    hint:  'What kind of exhibition or expo are you organising?',
    options: [
      sub('trade_show', 'Trade Show'),        sub('fair',       'Fair'),
      sub('product',    'Product Showcase'),   sub('auto',       'Auto Expo'),
      sub('education',  'Education Expo'),     sub('property',   'Property Expo'),
      sub('other',      'Other'),
    ],
  },
  sports: {
    label: 'Sport Discipline',
    hint:  'Select the specific sport or fitness discipline.',
    options: [
      sub('running',    'Running'),      sub('cycling',    'Cycling'),
      sub('cricket',    'Cricket'),      sub('football',   'Football'),
      sub('hockey',     'Hockey'),       sub('tennis',     'Tennis'),
      sub('badminton',  'Badminton'),    sub('swimming',   'Swimming'),
      sub('basketball', 'Basketball'),   sub('volleyball', 'Volleyball'),
      sub('triathlon',  'Triathlon'),    sub('other',      'Other'),
    ],
  },
  workshop: {
    label: 'Training Type',
    hint:  'What kind of workshop or training is this?',
    options: [
      sub('workshop',      'Workshop'),          sub('bootcamp',     'Bootcamp'),
      sub('certification', 'Certification Course'), sub('masterclass', 'Masterclass'),
      sub('seminar',       'Seminar'),           sub('live_training','Live Training'),
      sub('other',         'Other'),
    ],
  },
  meetup: {
    label: 'Meetup Focus',
    hint:  'What is the primary focus of this meetup?',
    options: [
      sub('networking', 'Networking'),    sub('startup',   'Startup Meetup'),
      sub('investor',   'Investor Meetup'), sub('founder',  'Founder Circle'),
      sub('corporate',  'Corporate Meetup'), sub('alumni',  'Alumni Meetup'),
      sub('other',      'Other'),
    ],
  },
  community: {
    label: 'Cause Type',
    hint:  'What cause or community program is this for?',
    options: [
      sub('awareness', 'Awareness'),      sub('ngo',       'NGO Event'),
      sub('volunteer', 'Volunteer Program'), sub('donation', 'Donation Drive'),
      sub('cleanup',   'Clean-up Drive'), sub('social',    'Social Impact'),
      sub('other',     'Other'),
    ],
  },
  cultural: {
    label: 'Entertainment Type',
    hint:  'What kind of cultural or entertainment event is this?',
    options: [
      sub('concert',   'Concert'),        sub('festival',  'Festival'),
      sub('dance',     'Dance Show'),     sub('drama',     'Drama'),
      sub('dj_night',  'DJ Night'),       sub('talent',    'Talent Show'),
      sub('cultural',  'Cultural Program'), sub('other',   'Other'),
    ],
  },
  awards: {
    label: 'Recognition Type',
    hint:  'What kind of recognition ceremony is this?',
    options: [
      sub('awards_night', 'Awards Night'),   sub('recognition',  'Recognition Ceremony'),
      sub('graduation',   'Graduation'),     sub('felicitation', 'Felicitation'),
      sub('excellence',   'Excellence Awards'), sub('summit',    'Summit Awards'),
      sub('other',        'Other'),
    ],
  },
  fundraising: {
    label: 'Fundraising Type',
    hint:  'What type of fundraising or charity event is this?',
    options: [
      sub('charity_run',    'Charity Run'),     sub('donation_drive', 'Donation Drive'),
      sub('benefit_dinner', 'Benefit Dinner'),  sub('gala',           'Gala Night'),
      sub('campaign',       'Campaign Event'),  sub('fundraiser',     'Fundraiser'),
      sub('other',          'Other'),
    ],
  },
}

const BENEFITS = [
  'Get a pre-built registration form',
  'Recommended ticket types',
  'Smart features for your event',
  'Better attendee experience',
] as const

// --- Step 2 constants ---------------------------------------------------------

export type VisibilityId = 'public' | 'private'

interface VisibilityOption {
  id:          VisibilityId
  name:        string
  badge:       { label: string; className: string }
  description: string
  features:    string[]
  tip:         string
  tipIcon:     LucideIcon
  tipIconBg:   string
  tipColor:    string
  tipBg:       string
  icon:        LucideIcon
  iconBg:      string
  iconColor:   string
}

const VISIBILITY_OPTIONS: VisibilityOption[] = [
  {
    id: 'public',
    name: 'Public Event',
    badge: { label: 'Recommended', className: 'bg-primary/10 text-primary' },
    description: 'Anyone can find your event and register.',
    features: [
      'Visible in search results',
      'Listed on event listing pages',
      'Open registration for everyone',
      'Shareable link works for anyone',
    ],
    tip:       'Best for conferences, workshops, expos and public programs.',
    tipIcon:   Sparkles,
    tipIconBg: 'bg-primary/15',
    tipColor:  'text-primary',
    tipBg:     'bg-primary/[0.05]',
    icon:      Globe,
    iconBg:    'bg-violet-100',
    iconColor: 'text-violet-600',
  },
  {
    id: 'private',
    name: 'Private Event',
    badge: { label: 'Invite Only', className: 'bg-emerald-50 text-emerald-700' },
    description: 'Only invited people can access and register.',
    features: [
      'Not visible in search',
      'Invite only via link or code',
      'Restrict access to approved people',
      'Great for member-only events',
    ],
    tip:       'Best for member events, internal meetings and private programs.',
    tipIcon:   Shield,
    tipIconBg: 'bg-emerald-100',
    tipColor:  'text-emerald-600',
    tipBg:     'bg-emerald-50/60',
    icon:      Lock,
    iconBg:    'bg-emerald-100',
    iconColor: 'text-emerald-600',
  },
]

const PUBLIC_REASONS = [
  'Your event is open to all',
  'You want more visibility',
  'Anyone can register',
  'You want to promote widely',
] as const

const PRIVATE_REASONS = [
  'Only selected people can attend',
  "It's a member-only event",
  'You want to control access',
  "You're hosting an internal event",
] as const

// --- Step 3 constants ---------------------------------------------------------

export type AccessControlId =
  | 'open'
  | 'invite_code'
  | 'approved_contacts'

export type ConfirmationMode = 'auto' | 'manual'

interface AccessControlOption {
  id:          AccessControlId
  name:        string
  description: string
  badge:       string
  badgeColor:  string
  badgeBg:     string
  icon:        LucideIcon
  iconBg:      string
  iconColor:   string
  experience:  readonly string[]
}

const ACCESS_CONTROL_OPTIONS: AccessControlOption[] = [
  {
    id:          'open',
    name:        'Open to All (No Restriction)',
    description: 'Anyone can find the event and register without any restrictions.',
    badge:       'Best for public events',
    badgeColor:  'text-violet-600',
    badgeBg:     'bg-violet-50',
    icon:        Globe,
    iconBg:      'bg-violet-100',
    iconColor:   'text-violet-600',
    experience: [
      'Event may be visible in search results',
      'Anyone can access and register',
      'No code or approval needed',
      'You can change this anytime',
    ],
  },
  {
    id:          'invite_code',
    name:        'Invite Code',
    description: 'People need a valid invite code to access and register.',
    badge:       'Code required',
    badgeColor:  'text-orange-600',
    badgeBg:     'bg-orange-50',
    icon:        Hash,
    iconBg:      'bg-orange-100',
    iconColor:   'text-orange-500',
    experience: [
      'Event will not be visible in search results',
      'Attendees must enter a valid invite code',
      'No approval needed after code verification',
      'You can change this anytime',
    ],
  },
  {
    id:          'approved_contacts',
    name:        'Approved Contact List',
    description: 'Only contacts on your approved list can access and register.',
    badge:       'Verified contacts only',
    badgeColor:  'text-blue-600',
    badgeBg:     'bg-blue-50',
    icon:        UserCheck,
    iconBg:      'bg-blue-100',
    iconColor:   'text-blue-600',
    experience: [
      'Only pre-approved contacts can register',
      'Attendees are verified against your contact list',
      'Manage your contact list in event settings',
      'You can change this anytime',
    ],
  },
]

// --- Shared Stepper -----------------------------------------------------------

function Stepper({
  currentStep,
  completedValues = [],
  steps = WIZARD_STEPS,
}: {
  currentStep:      number
  completedValues?: (string | undefined)[]
  steps?:           WizardStep[]
}) {
  const totalSteps = steps.length

  return (
    <nav
      aria-label="Event creation steps"
      className="rounded-2xl border border-border bg-card px-5 py-4 shadow-[0_1px_4px_rgba(0,0,0,0.05)]"
    >
      {/* ── Mobile: step name + animated progress bar ────────────────── */}
      <div className="sm:hidden">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12.5px] font-semibold text-foreground">
            {steps[currentStep]?.name}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {currentStep + 1}
            <span className="mx-px text-muted-foreground/40">/</span>
            {totalSteps}
          </span>
        </div>
        <div className="relative h-[2px] overflow-hidden rounded-full bg-muted">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            initial={false}
            animate={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }}
            transition={{ duration: 0.45, ease: EASE }}
          />
        </div>
      </div>

      {/* ── Desktop / tablet: full-width single row, no overflow ─────── */}
      {/* flex w-full replaces overflow-x-auto + min-w-max so all 7 steps
          share the available width; connectors (flex-1 min-w-0) absorb
          any extra space and can shrink to 0 on narrow viewports        */}
      <div className="hidden w-full items-start sm:flex">
        {steps.map((step, i) => {
          const isCompleted    = i < currentStep
          const isCurrent      = i === currentStep
          const completedValue = completedValues[i]

          return (
            <Fragment key={step.name}>
              {/* ── Connector ── */}
              {i > 0 && (
                <div
                  aria-hidden
                  className="relative mx-1.5 mt-[9px] h-px min-w-0 flex-1 overflow-hidden rounded-full bg-border"
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-emerald-400"
                    initial={false}
                    animate={{ width: isCompleted ? '100%' : '0%' }}
                    transition={{ duration: 0.4, ease: EASE }}
                  />
                </div>
              )}

              {/* ── Step column ── */}
              <div
                className="flex shrink-0 flex-col items-center"
                aria-current={isCurrent ? 'step' : undefined}
              >
                {/* Indicator — uniform 18 px so connector mt-[9px] aligns */}
                <div
                  className={cn(
                    'flex size-[18px] items-center justify-center rounded-full transition-all duration-300',
                    isCompleted
                      ? 'bg-emerald-500'
                      : isCurrent
                      ? 'bg-primary shadow-[0_0_0_3px_rgba(229,39,126,0.15)]'
                      : 'border border-border bg-card',
                  )}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {isCompleted ? (
                      <motion.span
                        key="check"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                      >
                        <Check className="size-[9px] text-white" aria-hidden />
                      </motion.span>
                    ) : isCurrent ? (
                      <motion.span
                        key="active"
                        className="size-[6px] rounded-full bg-white"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                      />
                    ) : (
                      <motion.span
                        key="idle"
                        className="size-[5px] rounded-full bg-muted-foreground/30"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                      />
                    )}
                  </AnimatePresence>
                </div>

                {/* Label */}
                <div className="mt-1.5 flex flex-col items-center">
                  <span
                    className={cn(
                      'whitespace-nowrap text-[10.5px] leading-none transition-colors duration-200',
                      isCompleted
                        ? 'font-medium text-emerald-600'
                        : isCurrent
                        ? 'font-bold text-foreground'
                        : 'font-normal text-muted-foreground',
                    )}
                  >
                    {step.name}
                  </span>
                  {isCompleted && completedValue && (
                    <motion.span
                      initial={{ opacity: 0, y: 2 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className="mt-0.5 max-w-[72px] truncate whitespace-nowrap text-[9.5px] leading-none text-muted-foreground"
                    >
                      {completedValue}
                    </motion.span>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>
    </nav>
  )
}

// --- Step 1 components --------------------------------------------------------

// --- Compact event type card --------------------------------------------------

function EventTypeCard({
  type,
  selected,
  onSelect,
}: {
  type:         EventTypeOption
  selected:     boolean
  onSelect:     (id: string) => void
  recommended?: boolean
}) {
  return (
    <motion.button
      type="button"
      onClick={() => onSelect(type.id)}
      whileTap={{ scale: 0.993 }}
      whileHover={
        selected
          ? {}
          : { y: -1, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] } }
      }
      aria-pressed={selected}
      aria-label={`Select ${type.name}`}
      className={cn(
        'group relative flex w-full cursor-pointer items-center gap-4 rounded-xl border px-5 py-[15px] text-left',
        'transition-[border-color,box-shadow,background-color] duration-200 ease-out',
        selected
          ? 'border-primary/50 bg-primary/[0.025] shadow-[0_0_0_2px_rgba(var(--tw-shadow-color,0,0,0),0),0_4px_20px_rgba(0,0,0,0.06)] ring-2 ring-primary/[0.12]'
          : 'border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:border-border-strong hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]',
      )}
    >
      {/* Left accent bar on selection */}
      <AnimatePresence>
        {selected && (
          <motion.span
            key="accent"
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute left-2 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-primary"
            aria-hidden
          />
        )}
      </AnimatePresence>

      {/* Icon */}
      <div
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl transition-shadow duration-200',
          type.iconBg,
          selected && 'shadow-[0_2px_8px_rgba(0,0,0,0.10)]',
        )}
        aria-hidden
      >
        <type.icon className={cn('size-[20px]', type.iconColor)} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className={cn(
          'text-[13.5px] font-semibold leading-snug tracking-tight transition-colors duration-200',
          selected ? 'text-foreground' : 'text-foreground/90 group-hover:text-foreground',
        )}>
          {type.name}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
          {type.description}
        </p>
      </div>

      {/* Selection indicator */}
      <span
        className={cn(
          'ml-1 flex size-5 shrink-0 items-center justify-center rounded-full transition-all duration-200',
          selected
            ? 'bg-primary shadow-[0_2px_6px_rgba(0,0,0,0.18)]'
            : 'border border-border bg-card group-hover:border-border-strong',
        )}
        aria-hidden
      >
        <AnimatePresence>
          {selected && (
            <motion.span
              key="check"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            >
              <Check className="size-3 text-white" />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </motion.button>
  )
}

// --- Subtype selector (secondary section for ALL event types) -----------------

function SubtypeSelector({
  eventTypeId,
  subtype,
  customSubtype,
  onSubtype,
  onCustomSubtype,
}: {
  eventTypeId:     string
  subtype:         string | null
  customSubtype:   string
  onSubtype:       (id: string) => void
  onCustomSubtype: (v: string) => void
}) {
  const config       = SUBTYPES_BY_EVENT_TYPE[eventTypeId]
  const isCustomType = eventTypeId === 'custom'
  const isOther      = subtype === 'other'
  const et           = EVENT_TYPES.find(e => e.id === eventTypeId)
  const resolvedName =
    isCustomType ? (customSubtype.trim() || null)
    : isOther    ? (customSubtype.trim() || 'Other')
    : config?.options.find(o => o.id === subtype)?.name ?? null

  // Focus without scroll — avoids the browser's native scroll-to-focused-element behaviour
  const customInputRef = useRef<HTMLInputElement>(null)
  const otherInputRef  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isCustomType) customInputRef.current?.focus({ preventScroll: true })
  }, [isCustomType, eventTypeId])

  useEffect(() => {
    if (isOther) otherInputRef.current?.focus({ preventScroll: true })
  }, [isOther])

  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

  return (
    <motion.div
      key={eventTypeId}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex flex-col gap-3"
    >
      <div className="rounded-xl border border-border bg-card p-5 shadow-[0_1px_4px_rgba(0,0,0,0.05)]">
        {/* Header */}
        <div className="mb-3 flex items-center gap-2.5">
          {et && (
            <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', et.iconBg)}>
              <et.icon className={cn('size-3.5', et.iconColor)} aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {/* Brief accent highlight on first reveal */}
            <div className="relative">
              <motion.div
                key={eventTypeId}
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: 'easeOut' }}
                className="pointer-events-none absolute -inset-x-1 -inset-y-0.5 rounded bg-primary/10"
                aria-hidden
              />
              {isCustomType ? (
                <p className="relative text-[13px] font-semibold text-foreground">
                  Custom Event Category
                </p>
              ) : (
                <div className="relative flex items-center gap-1.5">
                  <Sparkles className="size-[12px] shrink-0 text-muted-foreground/60" aria-hidden />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                    Event Format
                  </span>
                  <span className="ml-0.5 text-[10px] text-red-500">*</span>
                </div>
              )}
            </div>
            <p className="text-[12px] text-muted-foreground">
              {isCustomType
                ? 'Describe your event type or create a custom category.'
                : 'Choose the specific format for your event.'}
            </p>
          </div>
        </div>

        {/* Custom Event — text input (no autoFocus, uses ref) */}
        {isCustomType ? (
          <input
            ref={customInputRef}
            className={inputCls}
            placeholder="e.g. Hybrid Conference, Product Launch, Speed Dating…"
            value={customSubtype}
            onChange={e => onCustomSubtype(e.target.value)}
            maxLength={60}
          />
        ) : config ? (
          <>
            {/* Chip grid */}
            <div
              role="radiogroup"
              aria-label={config.label}
              className="flex flex-wrap gap-1.5"
            >
              {config.options.map(opt => {
                const sel = subtype === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={sel}
                    onClick={() => onSubtype(opt.id)}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-3 py-[5px] text-[12px] font-medium transition-all duration-150',
                      sel
                        ? 'border-primary bg-primary text-white shadow-sm'
                        : 'border-border bg-card text-foreground hover:border-border-strong hover:bg-muted/60',
                    )}
                  >
                    {sel && <Check className="size-2.5 shrink-0" aria-hidden />}
                    {opt.name}
                  </button>
                )
              })}
            </div>

            {/* "Other" custom input — animated, no autoFocus */}
            <AnimatePresence>
              {isOther && (
                <motion.div
                  key="other-input"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="mt-3">
                    <input
                      ref={otherInputRef}
                      className={inputCls}
                      placeholder="Describe your event format…"
                      value={customSubtype}
                      onChange={e => onCustomSubtype(e.target.value)}
                      maxLength={60}
                    />
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      e.g. 15K Run, Ultra Marathon, Product Demo Day…
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : null}
      </div>

      {/* Selection summary strip */}
      {(resolvedName || (isCustomType && customSubtype.trim())) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2 rounded-lg border border-primary/20 bg-card px-3.5 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 truncate text-[14px] font-medium text-foreground">
            {et?.name}
            {resolvedName && (
              <>
                <ChevronRight className="mx-0.5 inline size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                <span className="text-primary">{resolvedName}</span>
              </>
            )}
          </p>
        </motion.div>
      )}
    </motion.div>
  )
}

// --- Step 1 helper panel ------------------------------------------------------

function Step1HelperPanel() {
  return (
    <aside
      aria-label="Event creation help"
      className="h-fit rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="p-5">
        <div className="mb-2 flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">
            Not sure which type to pick?
          </p>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Choose the closest match. Use "Custom Event" to build a fully custom experience from scratch.
        </p>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-2 flex items-start gap-2">
          <Headphones className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Need Help?</p>
        </div>
        <p className="mb-3.5 text-[12px] leading-relaxed text-muted-foreground">
          We're here to help you create the perfect event.
        </p>
        {/* GA-7 S1: organizer-facing help docs are not yet published — the help
            action is hidden rather than shipping a dead link. Restore with the
            real docs URL once the guide exists. */}
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <p className="mb-3 text-[13px] font-semibold text-primary">
          Why choose the right type?
        </p>
        <ul className="space-y-2" aria-label="Benefits">
          {BENEFITS.map(benefit => (
            <li key={benefit} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              <span className="text-[12px] leading-snug text-muted-foreground">{benefit}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

// --- Step 2 components --------------------------------------------------------

function RadioIndicator({ selected }: { selected: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex size-[22px] items-center justify-center rounded-full border-2 transition-all duration-200',
        selected ? 'border-primary bg-primary' : 'border-border bg-card',
      )}
    >
      {selected && <div className="size-2.5 rounded-full bg-white" />}
    </div>
  )
}

function VisibilityCard({
  option,
  selected,
  onSelect,
}: {
  option:   VisibilityOption
  selected: boolean
  onSelect: (id: VisibilityId) => void
}) {
  const TipIcon = option.tipIcon

  return (
    <motion.button
      onClick={() => onSelect(option.id)}
      whileTap={{ scale: 0.994 }}
      aria-pressed={selected}
      aria-label={`Select ${option.name}`}
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border-[1.5px] bg-card text-left shadow-sm transition-all duration-200',
        selected
          ? 'border-primary shadow-md ring-1 ring-primary/10'
          : 'border-border hover:border-primary/35 hover:shadow',
      )}
    >
      <div className="absolute right-4 top-4">
        <RadioIndicator selected={selected} />
      </div>

      <div className="flex flex-col items-center px-6 pb-5 pt-8 text-center">
        <div
          className={cn(
            'flex size-[88px] items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-[1.05]',
            option.iconBg,
          )}
          aria-hidden
        >
          <option.icon className={cn('size-9', option.iconColor)} />
        </div>

        <p className="mt-5 text-[19px] font-bold text-foreground">{option.name}</p>

        <span className={cn(
          'mt-2 rounded-full px-3 py-0.5 text-[13px] font-semibold',
          option.badge.className,
        )}>
          {option.badge.label}
        </span>

        <p className="mt-3 max-w-[260px] text-[13px] leading-relaxed text-muted-foreground">
          {option.description}
        </p>
      </div>

      <div className="mx-5 border-t border-border" />

      <ul className="flex-1 space-y-3 px-6 py-5">
        {option.features.map(feature => (
          <li key={feature} className="flex items-center gap-3">
            <div
              className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-emerald-500"
              aria-hidden
            >
              <Check className="size-2.5 text-white" />
            </div>
            <span className="text-[13px] text-foreground">{feature}</span>
          </li>
        ))}
      </ul>

      <div className={cn(
        'flex items-start gap-3 border-t border-border px-5 py-4',
        option.tipBg,
      )}>
        <div className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg',
          option.tipIconBg,
        )}>
          <TipIcon className={cn('size-3.5', option.tipColor)} aria-hidden />
        </div>
        <p className={cn('text-[13px] leading-relaxed', option.tipColor)}>
          {option.tip}
        </p>
      </div>
    </motion.button>
  )
}

function Step2HelperPanel() {
  const { supportEmail } = useBranding()
  return (
    <aside
      aria-label="Visibility selection guide"
      className="h-fit rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="p-5">
        <div className="mb-2 flex items-start gap-2">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">
            Not sure which one to choose?
          </p>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Here's a quick guide to help you decide.
        </p>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Globe className="size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Choose Public if:</p>
        </div>
        <ul className="space-y-2">
          {PUBLIC_REASONS.map(reason => (
            <li key={reason} className="flex items-start gap-2.5 text-[12px] text-muted-foreground">
              <span
                className="mt-[5px] h-[5px] w-[5px] shrink-0 rounded-full bg-muted-foreground/60"
                aria-hidden
              />
              {reason}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Lock className="size-4 shrink-0 text-emerald-600" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Choose Private if:</p>
        </div>
        <ul className="space-y-2">
          {PRIVATE_REASONS.map(reason => (
            <li key={reason} className="flex items-start gap-2.5 text-[12px] text-muted-foreground">
              <span
                className="mt-[5px] h-[5px] w-[5px] shrink-0 rounded-full bg-muted-foreground/60"
                aria-hidden
              />
              {reason}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-1.5 flex items-center gap-2">
          <Headphones className="size-4 shrink-0 text-foreground" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Need help?</p>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          Our support team is here to assist you.
        </p>
        <Link
          href={`mailto:${supportEmail}`}
          className="inline-flex items-center gap-1 text-[14px] font-semibold text-primary hover:underline underline-offset-4"
          aria-label="Contact support"
        >
          Contact Support
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      </div>
    </aside>
  )
}

// --- Step 3 components --------------------------------------------------------

function AccessControlCard({
  option,
  selected,
  onSelect,
}: {
  option:   AccessControlOption
  selected: boolean
  onSelect: (id: AccessControlId) => void
}) {
  return (
    <motion.button
      onClick={() => onSelect(option.id)}
      whileTap={{ scale: 0.985 }}
      aria-pressed={selected}
      aria-label={`Select ${option.name}`}
      className={cn(
        'group relative flex cursor-pointer flex-col rounded-xl border-[1.5px] bg-card text-left shadow-sm transition-all duration-150',
        selected
          ? 'border-primary bg-primary/[0.02] shadow-md ring-1 ring-primary/10'
          : 'border-border hover:border-primary/35 hover:bg-muted/[0.03] hover:shadow',
      )}
    >
      {/* Header row: icon + title + radio */}
      <div className="flex items-center gap-3 px-4 pb-2.5 pt-4">
        <div
          className={cn(
            'flex size-[42px] shrink-0 items-center justify-center rounded-xl transition-transform duration-150 group-hover:scale-[1.05]',
            option.iconBg,
          )}
          aria-hidden
        >
          <option.icon className={cn('size-[18px]', option.iconColor)} />
        </div>

        <p className="flex-1 text-[13px] font-bold leading-snug text-foreground">
          {option.name}
        </p>

        <RadioIndicator selected={selected} />
      </div>

      {/* Description */}
      <p className="line-clamp-2 px-4 pb-3 text-[13px] leading-relaxed text-muted-foreground">
        {option.description}
      </p>

      {/* Badge footer */}
      <div className="mt-auto border-t border-border/70 px-4 py-2.5">
        <span
          className={cn(
            'inline-block rounded-md px-2 py-[3px] text-[12px] font-medium',
            option.badgeBg,
            option.badgeColor,
          )}
        >
          {option.badge}
        </span>
      </div>
    </motion.button>
  )
}

function Step3SummaryPanel({
  selectedOption,
  visibilityLabel,
  confirmationMode,
  approvedContactsCount,
}: {
  selectedOption:        AccessControlOption | null
  visibilityLabel:       string
  confirmationMode:      ConfirmationMode
  approvedContactsCount?: number
}) {
  const isPrivate    = visibilityLabel !== 'Public Event'
  const VisIcon      = isPrivate ? Lock : Globe
  const visIconBg    = isPrivate ? 'bg-emerald-100' : 'bg-violet-100'
  const visIconColor = isPrivate ? 'text-emerald-600' : 'text-violet-600'
  const displayLabel = visibilityLabel || 'Private Event'

  const defaultExperience = [
    'Select an access method to see details',
    'Attendees will see the relevant options',
    'Registration will follow the chosen rule',
    'You can change this anytime',
  ] as const

  const experienceItems    = selectedOption?.experience ?? defaultExperience
  const confirmOpt         = CONFIRMATION_OPTIONS.find(o => o.id === confirmationMode)!
  const ConfirmIcon        = confirmOpt.icon

  return (
    <aside
      aria-label="Access control summary"
      className="h-fit rounded-xl border border-border bg-card shadow-sm"
    >
      {/* Panel header */}
      <div className="border-b border-border px-4 py-3">
        <p className="text-[14px] font-semibold text-foreground">
          Your event access summary
        </p>
      </div>

      {/* Visibility indicator */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', visIconBg)}>
          <VisIcon className={cn('size-[15px]', visIconColor)} aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold leading-tight text-primary">{displayLabel}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            Access restricted by selected method.
          </p>
        </div>
      </div>

      {/* Selected method */}
      <div className="border-b border-border px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Selected Method
        </p>
        {selectedOption ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2">
            <div className={cn(
              'flex size-[22px] shrink-0 items-center justify-center rounded-full',
              selectedOption.iconBg,
            )}>
              <selectedOption.icon className={cn('size-3', selectedOption.iconColor)} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium leading-tight text-foreground">
                {selectedOption.name}
              </p>
              {selectedOption.id === 'approved_contacts' && approvedContactsCount !== undefined && (
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {approvedContactsCount} contact{approvedContactsCount !== 1 ? 's' : ''} added
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2">
            <span className="text-[13px] text-muted-foreground/60">
              Select an option above
            </span>
          </div>
        )}
      </div>

      {/* What attendees will experience */}
      <div className="border-b border-border px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold text-foreground">
          What attendees will experience
        </p>
        <ul className="space-y-2">
          {experienceItems.map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircle2
                className={cn(
                  'mt-0.5 size-3 shrink-0 transition-colors',
                  selectedOption
                    ? i < experienceItems.length - 1
                      ? 'text-primary'
                      : 'text-muted-foreground/35'
                    : 'text-muted-foreground/20',
                )}
                aria-hidden
              />
              <span className={cn(
                'text-[13px] leading-snug',
                selectedOption ? 'text-muted-foreground' : 'text-muted-foreground/45',
              )}>
                {item}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Registration confirmation */}
      <div className="border-b border-border px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Confirmation
        </p>
        <div className={cn(
          'flex items-center gap-2.5 rounded-lg border px-3 py-2',
          confirmationMode === 'auto'
            ? 'border-emerald-200/60 bg-emerald-50/40'
            : 'border-amber-200/60 bg-amber-50/40',
        )}>
          <div className={cn(
            'flex size-[22px] shrink-0 items-center justify-center rounded-full',
            confirmOpt.iconBg,
          )}>
            <ConfirmIcon className={cn('size-3', confirmOpt.iconColor)} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-medium leading-tight text-foreground">
              {confirmOpt.title}
            </p>
            <p className="text-[12px] text-muted-foreground">
              {confirmationMode === 'auto'
                ? 'Confirmed instantly after submission'
                : 'Pending until manually reviewed'}
            </p>
          </div>
        </div>
      </div>

      {/* Tip */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2 rounded-lg bg-muted/[0.06] px-3 py-2.5">
          <Lightbulb className="mt-0.5 size-3 shrink-0 text-amber-500" aria-hidden />
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {confirmationMode === 'auto'
              ? 'Auto Confirm works best for open or code-gated events with immediate payment.'
              : 'Manual Approval gives you full control — ideal for exclusive or curated events.'}
          </p>
        </div>
      </div>

      {/* Need help */}
      <div className="px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5">
          <Headphones className="size-3.5 shrink-0 text-foreground" aria-hidden />
          <p className="text-[12px] font-semibold text-foreground">Need help choosing?</p>
        </div>
        <p className="mb-2.5 text-[12px] leading-relaxed text-muted-foreground">
          Learn more about access control options.
        </p>
        {/* GA-7 S1: help docs not yet published — action hidden until the guide exists. */}
      </div>
    </aside>
  )
}

// --- Step 3 — Open to All detail panel ---------------------------------------

const OPEN_BENEFITS = [
  'Event may be visible in search results (based on visibility setting)',
  'Anyone with the link can access and register',
  'No invitation code or approval required',
] as const

const OPEN_EXPERIENCE = [
  { icon: Search,  line1: 'Event may be discoverable', line2: 'in search results' },
  { icon: Link2,   line1: 'Anyone can open the event', line2: 'page and register'  },
  { icon: Users,   line1: 'Instant access to the',     line2: 'registration form'  },
] as const

function Step3OpenToAllPanel() {
  return (
    <motion.div
      key="open-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="grid sm:grid-cols-2">

        {/* Left: icon + title + benefits + tip */}
        <div className="p-5 sm:border-r sm:border-border">

          {/* Icon + title + badge */}
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <div className="flex size-11 items-center justify-center rounded-full bg-violet-100">
                <Globe className="size-5 text-violet-600" aria-hidden />
              </div>
              <div
                className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full bg-emerald-500"
                aria-hidden
              >
                <Check className="size-2.5 text-white" />
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14.5px] font-bold text-foreground">Open to All</p>
                <span className="rounded-full bg-emerald-50 px-2 py-[2px] text-[12px] font-semibold text-emerald-600">
                  Recommended
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                Anyone can find the event and register without any restrictions.
              </p>
            </div>
          </div>

          {/* Benefits */}
          <ul className="mt-4 space-y-2.5">
            {OPEN_BENEFITS.map(b => (
              <li key={b} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-[14px] shrink-0 text-primary" aria-hidden />
                <span className="text-[14px] text-foreground">{b}</span>
              </li>
            ))}
          </ul>

          {/* Tip */}
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-3.5 py-3">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              This is the best option for public events where you want maximum reach and easy registration.
            </p>
          </div>
        </div>

        {/* Right: what attendees will experience */}
        <div className="p-5">
          <p className="mb-4 text-[13px] font-semibold text-foreground">
            What attendees will experience
          </p>
          <ul className="space-y-4">
            {OPEN_EXPERIENCE.map(item => {
              const Icon = item.icon
              return (
                <li key={item.line1} className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Icon className="size-[17px] text-primary" aria-hidden />
                  </div>
                  <div>
                    <p className="text-[14px] font-medium text-foreground">{item.line1}</p>
                    <p className="text-[12px] text-muted-foreground">{item.line2}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

      </div>
    </motion.div>
  )
}

// --- Step 3 — Invite Code detail panel ---------------------------------------

function generateInviteCode(): string {
  const year  = new Date().getFullYear()
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const extra = Array.from({ length: 2 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `EVENT${year}${extra}`
}

interface InviteCodeDraft {
  code:             string
  confirmCode:      string
  description:      string
  expiresAt:        string   // ISO date string or ''
  maxUses:          string   // numeric string or '' for unlimited
  caseSensitive:    boolean
  oneUsePerEmail:   boolean
  expireAfterStart: boolean
}

const DEFAULT_INVITE_CODE_DRAFT: InviteCodeDraft = {
  code:             '',
  confirmCode:      '',
  description:      '',
  expiresAt:        '',
  maxUses:          '',
  caseSensitive:    true,
  oneUsePerEmail:   false,
  expireAfterStart: false,
}

const INVITE_CODE_BENEFITS = [
  'Access is restricted with a code',
  'Only people with the correct code can register',
  'Event will not appear in search results',
  'No public listing or calendar visibility',
  'No approval required after code verification',
] as const

function Step3InviteCodePanel({
  draft,
  onUpdate,
}: {
  draft:    InviteCodeDraft
  onUpdate: (partial: Partial<InviteCodeDraft>) => void
}) {
  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

  const codeMatches = draft.code.length > 0 && draft.confirmCode.length > 0 && (
    draft.caseSensitive
      ? draft.code === draft.confirmCode
      : draft.code.toLowerCase() === draft.confirmCode.toLowerCase()
  )
  const codeMismatch = draft.confirmCode.length > 0 && !codeMatches

  const handleGenerate = () => {
    const code = generateInviteCode()
    onUpdate({ code, confirmCode: code })
  }

  return (
    <motion.div
      key="invite-code-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="grid sm:grid-cols-2">

        {/* Left: icon + title + benefits + tip */}
        <div className="p-5 sm:border-r sm:border-border">

          {/* Icon + title */}
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <div className="flex size-11 items-center justify-center rounded-xl bg-orange-100">
                <Hash className="size-5 text-orange-500" aria-hidden />
              </div>
              <div
                className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full bg-primary"
                aria-hidden
              >
                <Check className="size-2.5 text-white" />
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14.5px] font-bold text-foreground">
                  Invite Code (Code Required)
                </p>
                <span className="rounded-full bg-emerald-50 px-2 py-[2px] text-[12px] font-semibold text-emerald-600">
                  Recommended
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                People must enter a valid invite code to access and register.
              </p>
            </div>
          </div>

          {/* Benefits */}
          <ul className="mt-4 space-y-2.5">
            {INVITE_CODE_BENEFITS.map(b => (
              <li key={b} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-[14px] shrink-0 text-primary" aria-hidden />
                <span className="text-[14px] text-foreground">{b}</span>
              </li>
            ))}
          </ul>

          {/* Tip */}
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-3.5 py-3">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Great for private events, invite-only sessions, or exclusive programs where you want controlled access.
            </p>
          </div>
        </div>

        {/* Right: settings form */}
        <div className="flex flex-col gap-3 p-5">
          <p className="text-[13px] font-semibold text-foreground">Invite Code Settings</p>

          {/* Invite Code + Generate */}
          <div>
            <label className="mb-1 flex items-center text-[12px] font-medium text-foreground">
              Invite Code
              <span className="ml-0.5 text-[12px] text-red-500" aria-hidden>*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={draft.code}
                onChange={e => onUpdate({ code: e.target.value })}
                placeholder="e.g., EVENT2026"
                className={cn(inputCls, 'flex-1')}
                aria-required
                aria-label="Invite code"
              />
              <button
                type="button"
                onClick={handleGenerate}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0 gap-1.5')}
                aria-label="Generate a random invite code"
              >
                <RefreshCw className="size-3" aria-hidden />
                Generate Code
              </button>
            </div>
          </div>

          {/* Confirm Invite Code */}
          <div>
            <label className="mb-1 flex items-center text-[12px] font-medium text-foreground">
              Confirm Invite Code
              <span className="ml-0.5 text-[12px] text-red-500" aria-hidden>*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={draft.confirmCode}
                onChange={e => onUpdate({ confirmCode: e.target.value })}
                placeholder="Re-enter the code"
                aria-required
                aria-label="Confirm invite code"
                className={cn(
                  inputCls,
                  'pr-9',
                  codeMatches  && 'border-emerald-400 focus:border-emerald-400 focus:ring-emerald-200',
                  codeMismatch && 'border-red-400   focus:border-red-400   focus:ring-red-100',
                )}
              />
              {codeMatches && (
                <CheckCircle2
                  className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-emerald-500"
                  aria-hidden
                />
              )}
              {codeMismatch && (
                <XCircle
                  className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-red-400"
                  aria-hidden
                />
              )}
            </div>
            {codeMismatch && (
              <p className="mt-1 text-[12px] text-red-500" role="alert">Codes do not match</p>
            )}
          </div>

          {/* Code Description */}
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
              Code Description
              <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={draft.description}
                onChange={e => onUpdate({ description: e.target.value.slice(0, 100) })}
                placeholder="e.g., Early bird invitation code"
                className={cn(inputCls, 'pr-14')}
                aria-label="Code description"
              />
              <span className="pointer-events-none absolute right-3 top-2.5 text-[12px] text-muted-foreground">
                {draft.description.length}/100
              </span>
            </div>
          </div>

          {/* Code Expiry + Max Uses */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="mb-1 flex items-center gap-1 text-[12px] font-medium text-foreground">
                Code Expiry
                <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
              </label>
              <div className="relative">
                <input
                  type="date"
                  value={draft.expiresAt}
                  onChange={e => onUpdate({ expiresAt: e.target.value })}
                  min={new Date().toISOString().split('T')[0]}
                  className={cn(
                    inputCls,
                    'cursor-pointer pr-8',
                    !draft.expiresAt && 'text-muted-foreground/60',
                  )}
                  aria-label="Code expiry date"
                />
                <Calendar
                  className="pointer-events-none absolute right-2.5 top-2.5 size-3.5 text-muted-foreground"
                  aria-hidden
                />
              </div>
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-[12px] font-medium text-foreground">
                Max Uses
                <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
              </label>
              <input
                type="number"
                value={draft.maxUses}
                onChange={e => onUpdate({ maxUses: e.target.value })}
                placeholder="Unlimited"
                min={1}
                className={inputCls}
                aria-label="Maximum number of code uses"
              />
            </div>
          </div>

          {/* Checkboxes */}
          <div className="space-y-1.5 pt-0.5">
            <div className="grid grid-cols-2 gap-x-3">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.caseSensitive}
                  onChange={e => onUpdate({ caseSensitive: e.target.checked })}
                  className="size-[15px] cursor-pointer accent-primary"
                />
                <span className="text-[12px] text-foreground">Case sensitive code</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.oneUsePerEmail}
                  onChange={e => onUpdate({ oneUsePerEmail: e.target.checked })}
                  className="size-[15px] cursor-pointer accent-primary"
                />
                <span className="text-[12px] text-foreground">Limit to one use per email</span>
              </label>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={draft.expireAfterStart}
                onChange={e => onUpdate({ expireAfterStart: e.target.checked })}
                className="size-[15px] cursor-pointer accent-primary"
              />
              <span className="text-[12px] text-foreground">Expire after event start time</span>
            </label>
          </div>

        </div>
      </div>
    </motion.div>
  )
}

// --- Step 3 — Approved Contact List detail panel -----------------------------

interface ApprovedContact {
  id:           string
  name:         string
  mobileNumber: string
  email:        string
  memberId:     string
  addedAt:      string  // ISO timestamp
}

const CONTACT_TEMPLATE_CSV =
  'Name,Mobile Number,Email,Member ID\nJane Doe,+919876543210,jane@example.com,MEM001\n'

const PAGE_SIZE = 5
type SortCol = 'name' | 'email' | 'mobileNumber' | 'addedAt'

function generateContactId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function parseCsvText(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase())
  return lines.slice(1).map(line => {
    const values: string[] = []
    let cur = ''
    let inQ = false
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { values.push(cur); cur = '' }
      else { cur += ch }
    }
    values.push(cur)
    return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? '').replace(/^"|"$/g, '').trim()]))
  })
}

function parseContactsFromRows(rows: Record<string, string>[]): ApprovedContact[] {
  const now = new Date().toISOString()
  return rows
    .map(r => ({
      id:           generateContactId(),
      addedAt:      now,
      name:         (r['name']          ?? '').trim(),
      mobileNumber: (r['mobile number'] ?? r['mobile'] ?? r['phone number'] ?? r['phone'] ?? '').trim(),
      email:        (r['email']         ?? '').trim(),
      memberId:     (r['member id']     ?? r['member_id'] ?? r['memberid'] ?? '').trim(),
    }))
    .filter(c => c.mobileNumber.length > 0)
}

function Step3ApprovedContactListPanel({
  contacts,
  onUpdate,
}: {
  contacts: ApprovedContact[]
  onUpdate: (contacts: ApprovedContact[]) => void
}) {
  // -- UI state
  const [showForm,        setShowForm]        = useState(false)
  const [form,            setForm]            = useState({ name: '', mobileNumber: '', email: '', memberId: '' })
  const [mobileErr,       setMobileErr]       = useState('')
  const [search,          setSearch]          = useState('')
  const [showMoreMenu,    setShowMoreMenu]     = useState(false)
  // -- Table state
  const [sortCol,         setSortCol]         = useState<SortCol>('addedAt')
  const [sortDir,         setSortDir]         = useState<'asc' | 'desc'>('desc')
  const [page,            setPage]            = useState(1)
  const [selectedIds,     setSelectedIds]     = useState<Set<string>>(new Set())
  const [editingId,       setEditingId]       = useState<string | null>(null)
  const [editForm,        setEditForm]        = useState({ name: '', mobileNumber: '', email: '', memberId: '' })
  const [editMobileErr,   setEditMobileErr]   = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const csvRef  = useRef<HTMLInputElement>(null)
  const xlsxRef = useRef<HTMLInputElement>(null)

  const inputCls     = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
  const editInputCls = 'h-7 w-full min-w-0 rounded border border-border bg-background px-2 text-[12px] text-foreground placeholder:text-muted-foreground/40 outline-none transition-colors focus:border-primary/60 focus:ring-1 focus:ring-primary/15'

  // -- Derived
  const q        = search.trim().toLowerCase()
  const filtered = q
    ? contacts.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.mobileNumber.includes(q) ||
        c.memberId.toLowerCase().includes(q)
      )
    : contacts

  const getVal = (c: ApprovedContact): string => {
    if (sortCol === 'name')         return c.name
    if (sortCol === 'email')        return c.email
    if (sortCol === 'mobileNumber') return c.mobileNumber
    return c.addedAt
  }

  const sorted      = [...filtered].sort((a, b) => {
    const cmp = getVal(a).localeCompare(getVal(b))
    return sortDir === 'asc' ? cmp : -cmp
  })
  const totalPages  = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const curPage     = Math.min(page, totalPages)
  const paginated   = sorted.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
  const allPageSel  = paginated.length > 0 && paginated.every(c => selectedIds.has(c.id))
  const somePageSel = paginated.some(c => selectedIds.has(c.id)) && !allPageSel
  const bulkCount   = selectedIds.size

  const pageNums: (number | '…')[] = (() => {
    if (totalPages <= 6) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const arr: (number | '…')[] = [1]
    if (curPage > 3) arr.push('…')
    for (let i = Math.max(2, curPage - 1); i <= Math.min(totalPages - 1, curPage + 1); i++) arr.push(i)
    if (curPage < totalPages - 2) arr.push('…')
    arr.push(totalPages)
    return arr
  })()

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return '—' }
  }

  const triggerDownload = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  const exportList = (list: ApprovedContact[]) => {
    if (!list.length) return
    const hdr  = 'Name,Mobile Number,Email,Member ID,Added On'
    const rows = list.map(c =>
      `"${c.name}","${c.mobileNumber}","${c.email}","${c.memberId}","${formatDate(c.addedAt)}"`
    )
    triggerDownload([hdr, ...rows].join('\n'), 'contacts_export.csv')
  }

  // -- Sort
  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
    setPage(1)
  }

  // -- Selection
  const toggleSelectPage = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allPageSel) paginated.forEach(c => next.delete(c.id))
      else paginated.forEach(c => next.add(c.id))
      return next
    })
  }
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // -- Add
  const handleAddSubmit = () => {
    if (!form.mobileNumber.trim()) { setMobileErr('Mobile number is required'); return }
    setMobileErr('')
    onUpdate([...contacts, { id: generateContactId(), addedAt: new Date().toISOString(), ...form }])
    setForm({ name: '', mobileNumber: '', email: '', memberId: '' })
    setShowForm(false)
  }

  // -- Edit
  const startEdit = (c: ApprovedContact) => {
    setEditingId(c.id)
    setEditForm({ name: c.name, mobileNumber: c.mobileNumber, email: c.email, memberId: c.memberId })
    setEditMobileErr('')
    setDeleteConfirmId(null)
  }
  const saveEdit = () => {
    if (!editForm.mobileNumber.trim()) { setEditMobileErr('Required'); return }
    onUpdate(contacts.map(c => c.id === editingId ? { ...c, ...editForm } : c))
    setEditingId(null)
  }
  const cancelEdit = () => { setEditingId(null); setEditMobileErr('') }

  // -- Delete
  const handleDeleteConfirm = (id: string) => {
    onUpdate(contacts.filter(c => c.id !== id))
    setDeleteConfirmId(null)
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
  }

  // -- Bulk
  const handleBulkDelete = () => {
    onUpdate(contacts.filter(c => !selectedIds.has(c.id)))
    setSelectedIds(new Set())
    setPage(1)
  }

  // -- CSV / Excel
  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const imported = parseContactsFromRows(parseCsvText(ev.target?.result as string))
      if (imported.length) onUpdate([...contacts, ...imported])
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleXlsxChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // readSheet returns Row[] (the first worksheet) without requiring a schema.
    // read-excel-file v9 browser entry; safe to tree-shake server-only code.
    const { readSheet } = await import('read-excel-file/browser')
    const rows = await readSheet(file)
    if (rows.length >= 2) {
      const headers = rows[0].map(cell => String(cell ?? '').toLowerCase().trim())
      const data    = rows.slice(1).map(row =>
        Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? '').trim()]))
      )
      const imported = parseContactsFromRows(data)
      if (imported.length) onUpdate([...contacts, ...imported])
    }
    e.target.value = ''
  }

  const handleClearAll = () => {
    onUpdate([]); setSearch(''); setSelectedIds(new Set()); setShowMoreMenu(false); setPage(1)
  }

  // -- Sort icon helper
  const SortIndicator = ({ col }: { col: SortCol }) => (
    sortCol === col
      ? sortDir === 'asc'
        ? <ChevronUp   className="ml-1 inline size-3 text-primary" aria-hidden />
        : <ChevronDown className="ml-1 inline size-3 text-primary" aria-hidden />
      : <ArrowUpDown  className="ml-1 inline size-3 opacity-25" aria-hidden />
  )

  return (
    <motion.div
      key="approved-contact-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >

      {/* -- Panel header -- */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-100">
          <UserCheck className="size-3.5 text-blue-600" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-foreground">Approved Contact List</p>
          <p className="text-[13px] text-muted-foreground">Only contacts on this list can access and register.</p>
        </div>
        {contacts.length > 0 && (
          <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[12px] font-semibold text-blue-600">
            {contacts.length} contact{contacts.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* -- Toolbar -- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
        <button
          type="button"
          onClick={() => { setShowForm(f => !f); setMobileErr(''); setEditingId(null) }}
          className={cn(buttonVariants({ variant: showForm ? 'primary' : 'outline', size: 'sm' }), 'gap-1.5')}
          aria-expanded={showForm}
        >
          <Plus className="size-3.5" aria-hidden /> Add Contact
        </button>

        <button type="button" onClick={() => csvRef.current?.click()}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
          <Upload className="size-3.5" aria-hidden /> Import CSV
        </button>
        <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleCsvChange} />

        <button type="button" onClick={() => xlsxRef.current?.click()}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
          <FileSpreadsheet className="size-3.5" aria-hidden /> Import Excel
        </button>
        <input ref={xlsxRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleXlsxChange} />

        {/* Search */}
        <div className="relative ml-auto flex min-w-[140px] flex-1 sm:max-w-[210px]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground/50" aria-hidden />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search contacts…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-7 text-[14px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          />
          {search && (
            <button type="button" onClick={() => { setSearch(''); setPage(1) }}
              className="absolute right-2 top-2.5 text-muted-foreground/40 hover:text-foreground" aria-label="Clear search">
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>

        {/* More actions */}
        <div className="relative">
          <button type="button" onClick={() => setShowMoreMenu(v => !v)}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1')}
            aria-haspopup="menu" aria-expanded={showMoreMenu}>
            <MoreHorizontal className="size-3.5" aria-hidden />
            More
            <ChevronDown className="size-3" aria-hidden />
          </button>
          {showMoreMenu && (
            <div className="absolute right-0 top-full z-20 mt-1 min-w-[148px] overflow-hidden rounded-lg border border-border bg-card shadow-md">
              <button type="button" onClick={() => { exportList(contacts); setShowMoreMenu(false) }}
                disabled={contacts.length === 0}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] text-foreground hover:bg-muted/40 disabled:opacity-40">
                <Download className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> Export CSV
              </button>
              <div className="h-px bg-border" />
              <button type="button" onClick={handleClearAll} disabled={contacts.length === 0}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-40">
                <Trash2 className="size-3.5 shrink-0" aria-hidden /> Clear All
              </button>
            </div>
          )}
        </div>

        <button type="button" onClick={() => triggerDownload(CONTACT_TEMPLATE_CSV, 'contact_list_template.csv')}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
          <Download className="size-3.5" aria-hidden /> Template
        </button>
      </div>

      {/* -- Bulk action bar -- */}
      <AnimatePresence>
        {bulkCount > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: EASE }}
            className="overflow-hidden border-b border-primary/20 bg-primary/[0.04]"
          >
            <div className="flex items-center gap-3 px-5 py-2">
              <span className="text-[12px] font-semibold text-primary">
                {bulkCount} selected
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => exportList(contacts.filter(c => selectedIds.has(c.id)))}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 gap-1.5 text-[13px]')}>
                  <Download className="size-3" aria-hidden /> Export
                </button>
                <button type="button" onClick={handleBulkDelete}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 gap-1.5 border-red-200 text-[13px] text-red-600 hover:border-red-300 hover:bg-red-50')}>
                  <Trash2 className="size-3" aria-hidden /> Delete
                </button>
                <button type="button" onClick={() => setSelectedIds(new Set())}
                  className="text-[13px] text-muted-foreground hover:text-foreground">
                  Clear
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* -- Collapsible add-contact form -- */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden border-b border-border"
          >
            <div className="grid grid-cols-2 gap-3 bg-muted/[0.03] px-5 py-4 sm:grid-cols-4">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-foreground">Name</label>
                <input type="text" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Full name" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 flex items-center text-[13px] font-medium text-foreground">
                  Mobile Number <span className="ml-0.5 text-[12px] text-red-500" aria-hidden>*</span>
                </label>
                <input type="tel" value={form.mobileNumber}
                  onChange={e => { setForm(f => ({ ...f, mobileNumber: e.target.value })); setMobileErr('') }}
                  placeholder="+919876543210" aria-required
                  className={cn(inputCls, mobileErr && 'border-red-400 focus:border-red-400 focus:ring-red-100')} />
                {mobileErr && <p className="mt-1 text-[12px] text-red-500" role="alert">{mobileErr}</p>}
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1 text-[13px] font-medium text-foreground">
                  Email <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
                </label>
                <input type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="email@example.com" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1 text-[13px] font-medium text-foreground">
                  Member ID <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
                </label>
                <input type="text" value={form.memberId}
                  onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))}
                  placeholder="MEM001" className={inputCls} />
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-border/60 bg-muted/[0.03] px-5 py-3">
              <button type="button" onClick={handleAddSubmit}
                className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}>
                <Check className="size-3.5" aria-hidden /> Add to List
              </button>
              <button type="button"
                onClick={() => { setShowForm(false); setMobileErr(''); setForm({ name: '', mobileNumber: '', email: '', memberId: '' }) }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* -- Content: empty / search-empty / table -- */}
      {contacts.length === 0 ? (

        /* No contacts at all */
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted/40">
            <Users className="size-6 text-muted-foreground/40" aria-hidden />
          </div>
          <div>
            <p className="text-[13.5px] font-semibold text-foreground">No contacts yet</p>
            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-muted-foreground/70">
              Add contacts manually or import from CSV or Excel to build your approved list.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(true)}
              className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}>
              <Plus className="size-3.5" aria-hidden /> Add Contact
            </button>
            <button type="button" onClick={() => csvRef.current?.click()}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
              <Upload className="size-3.5" aria-hidden /> Import CSV
            </button>
          </div>
        </div>

      ) : sorted.length === 0 ? (

        /* Search returns nothing */
        <div className="flex flex-col items-center gap-2 py-9 text-center">
          <Search className="size-5 text-muted-foreground/30" aria-hidden />
          <p className="text-[13px] font-medium text-muted-foreground">
            No results for &ldquo;{search}&rdquo;
          </p>
          <button type="button" onClick={() => setSearch('')}
            className="text-[12px] text-primary hover:underline underline-offset-4">
            Clear search
          </button>
        </div>

      ) : (

        /* Data table */
        <div className="overflow-x-auto">
          <table className="w-full text-left" aria-label="Approved contacts">
            <thead>
              <tr className="border-b border-border/70 bg-muted/[0.04]">
                {/* Select-all */}
                <th className="w-9 pl-5 pr-2 py-2.5">
                  <input
                    type="checkbox"
                    checked={allPageSel}
                    ref={el => { if (el) el.indeterminate = somePageSel }}
                    onChange={toggleSelectPage}
                    className="size-[14px] cursor-pointer accent-primary"
                    aria-label="Select all on this page"
                  />
                </th>
                {/* Row number */}
                <th className="w-8 px-2 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">#</th>
                {/* Sortable columns */}
                {(
                  [
                    { label: 'Name',          col: 'name'         },
                    { label: 'Email',         col: 'email'        },
                    { label: 'Mobile Number', col: 'mobileNumber' },
                    { label: 'Added On',      col: 'addedAt'      },
                  ] as { label: string; col: SortCol }[]
                ).map(({ label, col }) => (
                  <th key={col}
                    onClick={() => handleSort(col)}
                    className="cursor-pointer select-none px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {label}
                    <SortIndicator col={col} />
                  </th>
                ))}
                {/* Actions */}
                <th className="w-[90px] px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {paginated.map((c, i) => {
                const isEditing  = editingId === c.id
                const isDeleting = deleteConfirmId === c.id
                const isSelected = selectedIds.has(c.id)
                const rowNum     = (curPage - 1) * PAGE_SIZE + i + 1

                /* -- Inline-edit row -- */
                if (isEditing) {
                  return (
                    <tr key={c.id} className="border-b border-primary/20 bg-primary/[0.025]">
                      <td className="pl-5 pr-2 py-2" />
                      <td className="px-2 py-2 text-[12px] tabular-nums text-muted-foreground/50">{rowNum}</td>
                      <td className="px-3 py-2">
                        <input type="text" value={editForm.name}
                          onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          placeholder="Name" className={editInputCls} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="email" value={editForm.email}
                          onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                          placeholder="Email" className={editInputCls} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="tel" value={editForm.mobileNumber}
                          onChange={e => { setEditForm(f => ({ ...f, mobileNumber: e.target.value })); setEditMobileErr('') }}
                          placeholder="Mobile" className={cn(editInputCls, editMobileErr && 'border-red-400')} />
                        {editMobileErr && <p className="mt-0.5 text-[12px] text-red-500">{editMobileErr}</p>}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">{formatDate(c.addedAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={saveEdit}
                            className="flex items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-emerald-600 hover:bg-emerald-50">
                            <Check className="size-3" aria-hidden /> Save
                          </button>
                          <button type="button" onClick={cancelEdit}
                            className="flex items-center gap-1 rounded px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted/40">
                            <X className="size-3" aria-hidden /> Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                }

                /* -- Normal row -- */
                return (
                  <tr key={c.id} className={cn(
                    'group border-b border-border/40 transition-colors last:border-0',
                    isSelected  ? 'bg-primary/[0.025]' :
                    isDeleting  ? 'bg-red-50/60'        :
                                  'hover:bg-muted/[0.04]',
                  )}>
                    <td className="pl-5 pr-2 py-2.5">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(c.id)}
                        className="size-[14px] cursor-pointer accent-primary" />
                    </td>
                    <td className="px-2 py-2.5 text-[12px] tabular-nums text-muted-foreground/55">{rowNum}</td>
                    <td className="max-w-[130px] px-3 py-2.5">
                      <span className="block truncate text-[14px] font-medium text-foreground">
                        {c.name || <span className="text-muted-foreground/35">—</span>}
                      </span>
                    </td>
                    <td className="max-w-[150px] px-3 py-2.5">
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {c.email || <span className="text-muted-foreground/35">—</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-foreground whitespace-nowrap">{c.mobileNumber}</td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground whitespace-nowrap">{formatDate(c.addedAt)}</td>
                    <td className="px-3 py-2.5">
                      {isDeleting ? (
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => handleDeleteConfirm(c.id)}
                            className="rounded bg-red-500 px-2 py-0.5 text-[12px] font-semibold text-white hover:bg-red-600">
                            Confirm
                          </button>
                          <button type="button" onClick={() => setDeleteConfirmId(null)}
                            className="rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/40">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button type="button" onClick={() => startEdit(c)}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-primary/10 hover:text-primary"
                            aria-label={`Edit ${c.name || c.mobileNumber}`}>
                            <Pencil className="size-3.5" aria-hidden />
                          </button>
                          <button type="button" onClick={() => setDeleteConfirmId(c.id)}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-red-50 hover:text-red-500"
                            aria-label={`Delete ${c.name || c.mobileNumber}`}>
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

      )}

      {/* -- Pagination -- */}
      {contacts.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border/50 px-5 py-2.5">
          <p className="text-[13px] text-muted-foreground">
            {(curPage - 1) * PAGE_SIZE + 1}–{Math.min(curPage * PAGE_SIZE, sorted.length)} of {sorted.length}
          </p>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={curPage === 1}
              className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted/40 disabled:opacity-40"
              aria-label="Previous page">
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            {pageNums.map((n, idx) =>
              n === '…' ? (
                <span key={`e${idx}`} className="w-7 text-center text-[12px] text-muted-foreground/50">…</span>
              ) : (
                <button key={n} type="button" onClick={() => setPage(n as number)}
                  aria-label={`Page ${n}`} aria-current={curPage === n ? 'page' : undefined}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md text-[12px] font-medium transition-colors',
                    curPage === n
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted/40',
                  )}>
                  {n}
                </button>
              )
            )}
            <button type="button" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={curPage === totalPages}
              className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted/40 disabled:opacity-40"
              aria-label="Next page">
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {/* -- Validation notice -- */}
      <div className="flex items-start gap-2.5 border-t border-border/60 bg-amber-50/40 px-5 py-3">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="text-[13px] font-medium text-foreground">Validation at registration</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            Mobile number is the primary match. Email and Member ID are optional secondary fields.
            If not found:{' '}
            <span className="font-medium text-foreground/80">
              &ldquo;Your contact information is not approved for this event.&rdquo;
            </span>
          </p>
        </div>
      </div>

    </motion.div>
  )
}

// --- Step 3 — Registration Confirmation section -------------------------------

interface ConfirmationOption {
  id:          ConfirmationMode
  title:       string
  badge:       string
  badgeColor:  string
  badgeBg:     string
  description: string
  icon:        LucideIcon
  iconBg:      string
  iconColor:   string
}

const CONFIRMATION_OPTIONS: ConfirmationOption[] = [
  {
    id:          'auto',
    title:       'Auto Confirm',
    badge:       'Default',
    badgeColor:  'text-emerald-600',
    badgeBg:     'bg-emerald-50',
    description: 'Registrations are confirmed immediately after successful submission and payment (if applicable).',
    icon:        Zap,
    iconBg:      'bg-emerald-100',
    iconColor:   'text-emerald-600',
  },
  {
    id:          'manual',
    title:       'Manual Approval',
    badge:       'Requires review',
    badgeColor:  'text-amber-600',
    badgeBg:     'bg-amber-50',
    description: 'Registrations will remain pending until you or your team reviews and approves them.',
    icon:        Clock,
    iconBg:      'bg-amber-100',
    iconColor:   'text-amber-600',
  },
]

function RegistrationConfirmationSection({
  mode,
  onChange,
}: {
  mode:     ConfirmationMode
  onChange: (m: ConfirmationMode) => void
}) {
  return (
    <div className="mt-1">
      {/* Section header */}
      <div className="mb-3 flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <CheckCircle2 className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[14px] font-bold text-foreground">Registration Confirmation</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Choose how registrations will be confirmed.
          </p>
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONFIRMATION_OPTIONS.map(opt => {
          const Icon     = opt.icon
          const selected = mode === opt.id
          return (
            <motion.button
              key={opt.id}
              type="button"
              onClick={() => onChange(opt.id)}
              whileTap={{ scale: 0.985 }}
              aria-pressed={selected}
              aria-label={`Select ${opt.title}`}
              className={cn(
                'group relative flex cursor-pointer items-start gap-3 rounded-xl border-[1.5px] bg-card px-4 py-3.5 text-left shadow-sm transition-all duration-150',
                selected
                  ? 'border-primary bg-primary/[0.02] shadow-md ring-1 ring-primary/10'
                  : 'border-border hover:border-primary/35 hover:bg-muted/[0.03] hover:shadow',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-transform duration-150 group-hover:scale-[1.04]',
                  opt.iconBg,
                )}
                aria-hidden
              >
                <Icon className={cn('size-4', opt.iconColor)} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-bold text-foreground">{opt.title}</p>
                  <span className={cn(
                    'rounded-full px-2 py-[2px] text-[12px] font-semibold',
                    opt.badgeBg, opt.badgeColor,
                  )}>
                    {opt.badge}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  {opt.description}
                </p>
              </div>

              <div className="mt-0.5 shrink-0">
                <RadioIndicator selected={selected} />
              </div>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

// --- State types --------------------------------------------------------------

interface Step1State { eventType: string | null; subtype: string | null; customSubtype: string; campaignType: CampaignType | null }
interface Step2State { visibility: VisibilityId | null }
interface Step3State { accessControl: { type: AccessControlId } | null }

// --- StepViewProps ------------------------------------------------------------

interface StepViewProps {
  currentStep:     number
  completedValues: (string | undefined)[]
  onNext:          (label?: string, data?: unknown) => void
  onBack:          () => void
  onSaveDraft?:    (data?: unknown) => void
  initialData?:    Record<string, unknown> | null
  onGoToStep?:     (step: number, fieldHint?: string) => void
  focusHint?:      string
  wizardSteps?:    WizardStep[]
}

// --- Campaign type intercept components ---------------------------------------

function CampaignTypeSelector({
  value,
  onChange,
}: {
  value:    CampaignType | null
  onChange: (ct: CampaignType) => void
}) {
  const options: Array<{
    id:          CampaignType
    label:       string
    description: string
    comingSoon?: boolean
  }> = [
    {
      id:          'donation_only',
      label:       'Donation Only',
      description: 'Pure fundraising campaign with no tickets or event registration',
    },
    {
      id:          'event_plus_donation',
      label:       'Event + Donation',
      description: 'Ticketed event with an optional donation component',
    },
    {
      id:          'ticketed_fundraiser',
      label:       'Ticketed Fundraiser',
      description: 'Charity event with paid tickets (gala, benefit dinner, charity run)',
      comingSoon:  true,
    },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <p className="mb-3 text-[14px] font-semibold text-foreground">
        How do you want to raise funds?
      </p>
      <div className="space-y-2.5">
        {options.map(opt => (
          <button
            key={opt.id}
            type="button"
            disabled={opt.comingSoon}
            onClick={() => !opt.comingSoon && onChange(opt.id)}
            className={cn(
              'relative flex w-full items-start gap-3 rounded-xl border-[1.5px] px-4 py-3 text-left transition-all duration-150',
              value === opt.id
                ? 'border-primary bg-primary/[0.03] shadow-sm'
                : opt.comingSoon
                ? 'cursor-not-allowed border-border bg-muted/20 opacity-60'
                : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]',
            )}
          >
            <div className={cn('mt-0.5 flex size-[16px] shrink-0 items-center justify-center rounded-full border-2', value === opt.id ? 'border-primary bg-primary' : 'border-border')}>
              {value === opt.id && <div className="size-[7px] rounded-full bg-white" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-foreground">{opt.label}</span>
                {opt.comingSoon && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{opt.description}</p>
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  )
}

function DonationSubtypeSelector({
  subtype,
  onSubtype,
}: {
  subtype:   DonationCampaignSubtype | null
  onSubtype: (id: string) => void
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="mb-3 text-[14px] font-semibold text-foreground">
        What is your cause?
      </p>
      <div className="flex flex-wrap gap-2">
        {DONATION_CAMPAIGN_SUBTYPES.map(opt => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onSubtype(opt.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all duration-150',
              subtype === opt.id
                ? 'border-primary bg-primary/[0.07] text-primary'
                : 'border-border bg-card text-foreground/70 hover:border-primary/30',
            )}
          >
            {subtype === opt.id && <Check className="size-[12px]" />}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// --- Step 1 view --------------------------------------------------------------

function Step1View({ currentStep, completedValues, onNext, onSaveDraft, initialData }: StepViewProps) {
  const [step1, setStep1] = useState<Step1State>({
    eventType:    (initialData?.eventType         as string | null)       ?? null,
    subtype:      (initialData?.eventSubtype       as string | null)       ?? null,
    customSubtype:(initialData?.customEventSubtype as string)              ?? '',
    campaignType: (initialData?.campaignType       as CampaignType | null) ?? null,
  })

  const selectedType    = step1.eventType
  const selectedSubtype = step1.subtype
  const customSubtype   = step1.customSubtype
  const campaignType    = step1.campaignType
  const isCustomType    = selectedType === 'custom'
  const isFundraising   = selectedType === 'fundraising'
  const isOtherSubtype  = selectedSubtype === 'other'

  const hasValidSubtype =
    !selectedType ? false
    : isCustomType ? true  // custom event can proceed without a subtype
    // event_plus_donation is a ticketed event — no cause-category subtype required
    : (isFundraising && campaignType === 'event_plus_donation') ? true
    : selectedSubtype !== null && (!isOtherSubtype || customSubtype.trim().length > 0)

  // Fundraising events require a campaign type selection before proceeding
  const canProceed = selectedType !== null && hasValidSubtype
    && (!isFundraising || campaignType !== null)

  const subtypeSectionRef = useRef<HTMLDivElement>(null)

  const handleSelectType = (id: string) =>
    setStep1(prev => ({
      eventType:    id,
      subtype:      id !== prev.eventType ? null : prev.subtype,
      customSubtype: id !== prev.eventType ? ''  : prev.customSubtype,
      campaignType:  id !== prev.eventType ? null : prev.campaignType,
    }))

  useEffect(() => {
    if (!selectedType) return
    const timer = setTimeout(() => {
      const el        = subtypeSectionRef.current
      const scroller  = document.getElementById('main-content')
      if (!el || !scroller) return

      const MARGIN    = 24
      const elRect        = el.getBoundingClientRect()
      const scrollerRect  = scroller.getBoundingClientRect()
      const visibleBottom = scrollerRect.bottom - MARGIN

      const bottomOverflow = elRect.bottom - visibleBottom
      if (bottomOverflow <= 0) return                         // already fully visible

      // Cap scroll so the section title never scrolls above the visible top
      const maxScroll = Math.max(0, elRect.top - scrollerRect.top - 16)
      scroller.scrollBy({ top: Math.min(bottomOverflow, maxScroll), behavior: 'smooth' })
    }, 340)
    return () => clearTimeout(timer)
  }, [selectedType])

  const buildData = () => ({
    eventType:    selectedType,
    subtype:      selectedSubtype,
    customSubtype: (isOtherSubtype || isCustomType) ? customSubtype.trim() : '',
    campaignType:  isFundraising ? campaignType : null,
  })

  const handleNext = () => {
    if (!canProceed) return
    const name = EVENT_TYPES.find(et => et.id === selectedType)?.name ?? 'Custom Event'
    onNext(name, buildData())
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      <Link
        href={ROUTES.DASHBOARD_EVENTS}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Event Category
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Choose the category that best represents your event.
        </p>
      </div>

      <div
        className="mt-5 grid flex-1 items-start gap-5 sm:mt-6 lg:grid-cols-[1fr_296px]"
        aria-label="Event type selection"
      >
        {/* Left: cards grid + secondary selector */}
        <div className="flex flex-col gap-4">
          <div
            role="group"
            aria-label="Event types"
            className="grid grid-cols-1 gap-2.5"
          >
            {EVENT_TYPES.map(et => (
              <EventTypeCard
                key={et.id}
                type={et}
                selected={selectedType === et.id}
                onSelect={handleSelectType}
                recommended={getTemplate(et.id)?.recommended}
              />
            ))}
          </div>

          {/* Mobile inline preview — shows below cards when a template is selected */}
          <div className="lg:hidden">
            <AnimatePresence mode="wait">
              {selectedType && getTemplate(selectedType) && (
                <motion.div
                  key={`mobile-preview-${selectedType}`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <TemplatePreviewPanel selectedTypeId={selectedType} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Secondary selector — subtype or campaign-type intercept */}
          <AnimatePresence mode="wait">
            {selectedType && (
              <div ref={subtypeSectionRef} className="space-y-4">
                {isFundraising ? (
                  <>
                    {/* Campaign type selector — replaces legacy fundraising subtypes */}
                    <CampaignTypeSelector
                      value={campaignType}
                      onChange={ct =>
                        setStep1(prev => ({ ...prev, campaignType: ct, subtype: null }))
                      }
                    />
                    {/* Cause category selector — shown only for Donation Only campaigns */}
                    <AnimatePresence>
                      {campaignType === 'donation_only' && (
                        <motion.div
                          key="donation-subtypes"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.25, ease: EASE }}
                          className="overflow-hidden"
                        >
                          <DonationSubtypeSelector
                            subtype={selectedSubtype as DonationCampaignSubtype | null}
                            onSubtype={id =>
                              setStep1(prev => ({ ...prev, subtype: id }))
                            }
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                ) : (
                  <SubtypeSelector
                    key={selectedType}
                    eventTypeId={selectedType}
                    subtype={selectedSubtype}
                    customSubtype={customSubtype}
                    onSubtype={id =>
                      setStep1(prev => ({
                        ...prev,
                        subtype:      id,
                        customSubtype: id !== 'other' ? '' : prev.customSubtype,
                      }))
                    }
                    onCustomSubtype={v => setStep1(prev => ({ ...prev, customSubtype: v }))}
                  />
                )}
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* Desktop preview panel — sticky right column */}
        <div className="hidden lg:block">
          <TemplatePreviewPanel selectedTypeId={selectedType} />
        </div>
      </div>

      <WizardFooter
        cancelHref={ROUTES.DASHBOARD_EVENTS}
        backLabel="Cancel"
        onSaveDraft={onSaveDraft ? () => onSaveDraft(buildData()) : undefined}
        onNext={handleNext}
        isNextDisabled={!canProceed}
        stepContext={`Step ${currentStep + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[currentStep]?.name ?? ''}`}
      />
    </motion.div>
  )
}

// --- Step 2 view --------------------------------------------------------------

function Step2View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData }: StepViewProps) {
  const [step2, setStep2] = useState<Step2State>({
    visibility: (initialData?.visibility as VisibilityId | null) ?? null,
  })

  const selectedVisibility = step2.visibility
  const canProceed         = selectedVisibility !== null

  const handleSelect = (id: VisibilityId) => setStep2({ visibility: id })
  const handleNext   = () => {
    if (!canProceed) return
    onNext(
      selectedVisibility === 'public' ? 'Public Event' : 'Private Event',
      selectedVisibility,
    )
  }

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

      <Stepper currentStep={currentStep} completedValues={completedValues} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Choose Visibility
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Decide who can find and register for your event.
        </p>
      </div>

      <div className="mt-5 grid flex-1 items-start gap-5 lg:grid-cols-[1fr_256px]">
        <div
          role="group"
          aria-label="Choose visibility"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          {VISIBILITY_OPTIONS.map(option => (
            <VisibilityCard
              key={option.id}
              option={option}
              selected={selectedVisibility === option.id}
              onSelect={handleSelect}
            />
          ))}
        </div>

        <Step2HelperPanel />
      </div>

      <WizardFooter
        onBack={onBack}
        onSaveDraft={onSaveDraft ? () => onSaveDraft(step2.visibility) : undefined}
        onNext={handleNext}
        isNextDisabled={!canProceed}
        stepContext={`Step ${currentStep + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[currentStep]?.name ?? ''}`}
      />
    </motion.div>
  )
}

// --- Step 3 view --------------------------------------------------------------

function Step3View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData }: StepViewProps) {
  // Cast the saved access-control snapshot (may be null on first visit)
  const savedAC = initialData as {
    type?:             AccessControlId | null
    confirmationMode?: ConfirmationMode
    inviteCode?:       Partial<InviteCodeDraft> | null
    approvedContacts?: ApprovedContact[]
  } | null

  const [step3, setStep3] = useState<Step3State>({
    accessControl: savedAC?.type ? { type: savedAC.type } : null,
  })
  // Invite Code form draft — persists across type switches, restored from draft
  const [inviteCodeDraft, setInviteCodeDraft] = useState<InviteCodeDraft>(
    savedAC?.inviteCode
      ? { ...DEFAULT_INVITE_CODE_DRAFT, ...savedAC.inviteCode }
      : DEFAULT_INVITE_CODE_DRAFT,
  )
  // Approved contacts list — restored from draft
  const [approvedContacts, setApprovedContacts] = useState<ApprovedContact[]>(
    (savedAC?.approvedContacts as ApprovedContact[] | undefined) ?? [],
  )
  // Registration confirmation mode — restored from draft, defaults to auto
  const [confirmationMode, setConfirmationMode] = useState<ConfirmationMode>(
    savedAC?.confirmationMode ?? 'auto',
  )

  const handleUpdateInviteCode = (partial: Partial<InviteCodeDraft>) =>
    setInviteCodeDraft(prev => ({ ...prev, ...partial }))

  const selectedAccess  = step3.accessControl?.type ?? null
  const canProceed      = selectedAccess !== null && (
    selectedAccess !== 'approved_contacts' || approvedContacts.length > 0
  )
  const selectedOption  = ACCESS_CONTROL_OPTIONS.find(o => o.id === selectedAccess) ?? null
  const visibilityLabel = completedValues[1] ?? ''

  const handleSelect = (id: AccessControlId) => setStep3({ accessControl: { type: id } })

  const handleNext = () => {
    if (!canProceed) return
    onNext(selectedOption?.name, {
      type:             selectedAccess,
      confirmationMode,
      inviteCode:       selectedAccess === 'invite_code' ? inviteCodeDraft : null,
      approvedContacts: selectedAccess === 'approved_contacts' ? approvedContacts : [],
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >

      {/* -- Back link -- */}
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      {/* -- Stepper -- */}
      <Stepper currentStep={currentStep} completedValues={completedValues} />

      {/* -- Title -- */}
      <div className="mt-5">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Access Control
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Choose how people can access and register for your event.
        </p>
      </div>

      {/* -- Content: cards + summary panel -- */}
      <div className="mt-4 grid flex-1 items-start gap-4 lg:grid-cols-[1fr_264px]">

        {/* Left column: card grid + info strip */}
        <div className="flex flex-col gap-3">
          <div
            role="group"
            aria-label="Access control options"
            className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          >
            {ACCESS_CONTROL_OPTIONS.map(option => (
              <AccessControlCard
                key={option.id}
                option={option}
                selected={selectedAccess === option.id}
                onSelect={handleSelect}
              />
            ))}
          </div>

          {/* Selected-option detail panel */}
          <AnimatePresence>
            {selectedAccess === 'open' && <Step3OpenToAllPanel />}
            {selectedAccess === 'invite_code' && (
              <Step3InviteCodePanel
                draft={inviteCodeDraft}
                onUpdate={handleUpdateInviteCode}
              />
            )}
            {selectedAccess === 'approved_contacts' && (
              <Step3ApprovedContactListPanel
                contacts={approvedContacts}
                onUpdate={setApprovedContacts}
              />
            )}
          </AnimatePresence>

          {/* Generic strip — shown when nothing is selected */}
          {!selectedAccess && (
            <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/[0.04] px-4 py-2.5">
              <Lightbulb className="size-3.5 shrink-0 text-amber-500" aria-hidden />
              <p className="text-[12px] leading-snug text-muted-foreground">
                You can change the access control settings anytime from Event Settings after your event is created.
              </p>
            </div>
          )}

          {/* -- Section 2: Registration Confirmation (always visible) -- */}
          <RegistrationConfirmationSection
            mode={confirmationMode}
            onChange={setConfirmationMode}
          />
        </div>

        {/* Right column: summary panel */}
        <Step3SummaryPanel
          selectedOption={selectedOption}
          visibilityLabel={visibilityLabel}
          confirmationMode={confirmationMode}
          approvedContactsCount={selectedAccess === 'approved_contacts' ? approvedContacts.length : undefined}
        />
      </div>

      <WizardFooter
        onBack={onBack}
        onSaveDraft={onSaveDraft ? () => onSaveDraft({
          type:             selectedAccess,
          confirmationMode,
          inviteCode:       selectedAccess === 'invite_code' ? inviteCodeDraft : null,
          approvedContacts: selectedAccess === 'approved_contacts' ? approvedContacts : [],
        }) : undefined}
        onNext={handleNext}
        isNextDisabled={!canProceed}
        stepContext={`Step ${currentStep + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[currentStep]?.name ?? ''}`}
      />

    </motion.div>
  )
}

// --- Step 4: Passes & Pricing ------------------------------------------------

type EventPricingType = 'paid' | 'free'

type EventPass = EventPassFull

interface EventPricingDraft {
  eventType:               EventPricingType
  feeModel:                FeeModel
  estimatedRegistrations:  number            // used only for simulation when unlimited passes exist
  passes:                  EventPass[]
  registrationOpenDate:    string
  // Early bird is entirely pass-specific: pricing.passes[].earlyBirdEndDate.
  // The former event-level earlyBirdEndDate was removed (LS3.2) — no consumer
  // read it. Legacy drafts are migrated into the passes on load (see Step4View).
  registrationEndDate:     string
  showRemainingSeats:      boolean
  whatsappEnabled:         boolean
  smsEnabled:              boolean
  certEnabled:             boolean
  advancedSettings: {
    taxes:     unknown[]
    fees:      unknown[]
    coupons:   unknown[]
    discounts: unknown[]
  }
}

const PASS_COLORS: { bg: string; color: string; dot: string }[] = [
  { bg: 'bg-violet-100',  color: 'text-violet-600',  dot: 'bg-violet-500'  },
  { bg: 'bg-blue-100',    color: 'text-blue-600',    dot: 'bg-blue-500'    },
  { bg: 'bg-emerald-100', color: 'text-emerald-600', dot: 'bg-emerald-500' },
  { bg: 'bg-orange-100',  color: 'text-orange-500',  dot: 'bg-orange-500'  },
  { bg: 'bg-rose-100',    color: 'text-rose-600',    dot: 'bg-rose-500'    },
  { bg: 'bg-purple-100',  color: 'text-purple-600',  dot: 'bg-purple-500'  },
  { bg: 'bg-cyan-100',    color: 'text-cyan-600',    dot: 'bg-cyan-500'    },
]

function generatePassId(): string {
  return 'pass_' + Math.random().toString(36).slice(2, 10)
}

const INR_FORMAT = new Intl.NumberFormat('en-IN', {
  style:                 'currency',
  currency:              'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})
const formatINR = (n: number): string => INR_FORMAT.format(n)

// --- Fee model types + calculator ---------------------------------------------

type FeeModel = 'attendee_pays' | 'organizer_absorbs'

interface FeeBreakdown {
  ticketPrice:  number
  platformFee:  number
  gatewayFee:   number
  gstOnFees:    number
  totalFees:    number
  attendeePays: number
  organizerGets: number
}

// Display-only fee rates for the wizard preview, sourced from the runtime fee config
// (useFeesConfig) — never hardcoded. Percentages are whole numbers (e.g. 2, 18). The
// authoritative charge is always computed server-side via resolveFeeConfig.
interface FeeRates { platformPercent: number; gatewayPercent: number; gstPercent: number }

function calcFees(ticketPrice: number, model: FeeModel, rates: FeeRates): FeeBreakdown {
  const pFee  = Math.round(ticketPrice * (rates.platformPercent / 100) * 100) / 100
  const gFee  = Math.round(ticketPrice * (rates.gatewayPercent  / 100) * 100) / 100
  const gst   = Math.round((pFee + gFee) * (rates.gstPercent / 100) * 100) / 100
  const total = Math.round((pFee + gFee + gst)  * 100) / 100
  if (model === 'attendee_pays') {
    return { ticketPrice, platformFee: pFee, gatewayFee: gFee, gstOnFees: gst, totalFees: total, attendeePays: Math.round((ticketPrice + total) * 100) / 100, organizerGets: ticketPrice }
  }
  return { ticketPrice, platformFee: pFee, gatewayFee: gFee, gstOnFees: gst, totalFees: total, attendeePays: ticketPrice, organizerGets: Math.round((ticketPrice - total) * 100) / 100 }
}

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
function RegTypeCard({
  selected, onClick, icon: Icon, title, subtitle, description, examples, dividerClass,
}: {
  selected:     boolean
  onClick:      () => void
  icon:         LucideIcon
  title:        string
  subtitle:     string
  description:  string
  examples:     string[]
  dividerClass: string
}) {
  const [infoOpen, setInfoOpen]   = useState(false)
  const [coords, setCoords]       = useState({ top: 0, left: 0 })
  const iconBtnRef                = useRef<HTMLButtonElement>(null)
  const popoverDivRef             = useRef<HTMLDivElement>(null)

  const openInfo = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!infoOpen && iconBtnRef.current) {
      const r   = iconBtnRef.current.getBoundingClientRect()
      const top = r.bottom + window.scrollY + 6
      // clamp left so popover (208px wide) never overflows the right viewport edge
      const left = Math.min(r.left + window.scrollX, window.innerWidth - 216)
      setCoords({ top, left })
    }
    setInfoOpen(v => !v)
  }

  useEffect(() => {
    if (!infoOpen) return
    const close = (e: MouseEvent) => {
      if (
        iconBtnRef.current?.contains(e.target as Node) ||
        popoverDivRef.current?.contains(e.target as Node)
      ) return
      setInfoOpen(false)
    }
    const dismiss = () => setInfoOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', dismiss, { passive: true })
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [infoOpen])

  return (
    <>
      {/* Fixed popover — position:fixed bypasses any ancestor overflow:hidden */}
      <AnimatePresence>
        {infoOpen && (
          <motion.div
            ref={popoverDivRef}
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.97 }}
            transition={{ duration: 0.14 }}
            style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 9999 }}
            className="w-52 rounded-xl border border-border bg-card p-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Best suited for</p>
            <ul className="flex flex-col gap-2">
              {examples.map(ex => (
                <li key={ex} className="flex items-center gap-2 text-[13px] text-foreground">
                  <span className="size-1.5 shrink-0 rounded-full bg-primary/50" aria-hidden />
                  {ex}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        whileHover={{ y: selected ? 0 : -2 }}
        whileTap={{ scale: 0.998 }}
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
        className={cn(
          'relative cursor-pointer flex-col p-6 text-left transition-all duration-200 sm:p-7',
          dividerClass,
          selected
            ? 'bg-primary/[0.04] shadow-md ring-2 ring-inset ring-primary/20'
            : 'bg-card hover:shadow-lg',
        )}
      >
        {selected && (
          <span className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />
        )}

        {/* Title row */}
        <div className="mb-3 flex items-center gap-3">
          <div className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors',
            selected ? 'bg-primary/10' : 'bg-muted/50',
          )}>
            <Icon className={cn('size-5', selected ? 'text-primary' : 'text-muted-foreground/60')} aria-hidden />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5">
              <p className="text-[16px] font-bold text-foreground">{title}</p>
              <button
                ref={iconBtnRef}
                type="button"
                onClick={openInfo}
                aria-label={`Examples for ${title}`}
                className="flex items-center justify-center p-0.5 text-muted-foreground transition-colors hover:text-primary"
              >
                <Info className="size-4" aria-hidden />
              </button>
            </div>
            <p className={cn('text-[12px] font-semibold', selected ? 'text-primary' : 'text-muted-foreground/60')}>{subtitle}</p>
          </div>

        <div className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
          selected ? 'border-primary bg-primary' : 'border-border bg-background',
        )}>
          {selected && <Check className="size-3 text-primary-foreground" aria-hidden />}
        </div>
      </div>

        {/* Description */}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </motion.div>
    </>
  )
}

// Section 1: Registration Type — simple free / paid selector
function EventTypeSelectorSection({
  value,
  onChange,
}: {
  value:    EventPricingType
  onChange: (v: EventPricingType) => void
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <Ticket className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[15px] font-bold tracking-tight text-foreground">Registration Type</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Choose whether attendees will register for free or pay during registration.
          </p>
        </div>
      </div>

      {/* Two selection cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        <RegTypeCard
          selected={value === 'free'}
          onClick={() => onChange('free')}
          icon={Heart}
          title="Free Registration"
          subtitle="No payment required"
          description="Attendees can register without making any payment."
          examples={['Community Programs', 'Awareness Campaigns', 'NGO Events', 'School Functions', 'Free Workshops']}
          dividerClass="border-b border-border/60 sm:border-b-0 sm:border-r"
        />
        <RegTypeCard
          selected={value === 'paid'}
          onClick={() => onChange('paid')}
          icon={IndianRupee}
          title="Paid Registration"
          subtitle="Online payment at checkout"
          description="Attendees must complete payment during registration."
          examples={['Marathons', 'Conferences', 'Training Programs', 'Exhibitions', 'Fundraising Events']}
          dividerClass=""
        />
      </div>
    </div>
  )
}

function PassesSection({
  passes,
  isFreeEvent,
  onUpdate,
  onAddNew,
  onEdit,
}: {
  passes:      EventPass[]
  isFreeEvent: boolean
  onUpdate:    (passes: EventPass[]) => void
  onAddNew:    () => void
  onEdit:      (pass: EventPass) => void
}) {
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const toggleStatus = (id: string) =>
    onUpdate(passes.map(p =>
      p.id === id ? { ...p, status: p.status === 'active' ? 'inactive' : 'active' } : p
    ))

  const handleDuplicate = (pass: EventPass) => {
    const copy: EventPass = {
      ...pass,
      id:               generatePassId(),
      name:             `${pass.name} (Copy)`,
      status:           'inactive',
      benefits:         [...pass.benefits],
      customBenefits:   [...pass.customBenefits],
      raceDetails:      pass.raceDetails ? { ...pass.raceDetails } : null,
      advancedSettings: { ...pass.advancedSettings },
    }
    onUpdate([...passes, copy])
  }

  const handleDeleteConfirm = (id: string) => {
    onUpdate(passes.filter(p => p.id !== id))
    setDeleteConfirmId(null)
  }

  return (
    <div>
      {/* Table or empty state */}
      {passes.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border bg-muted/[0.03] py-14 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted/40">
            <Ticket className="size-6 text-muted-foreground/40" aria-hidden />
          </div>
          <div>
            <p className="text-[13.5px] font-semibold text-foreground">No passes created yet</p>
            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-muted-foreground/70">
              Create your first pass to start accepting registrations.
            </p>
          </div>
          <button
            type="button"
            onClick={onAddNew}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-[#bf1868]"
          >
            <Plus className="size-4" aria-hidden />
            Add First Pass
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left" aria-label="Ticket passes">
              <thead>
                <tr className="border-b border-border/70 bg-muted/[0.04]">
                  <th className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Pass Name
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Price {!isFreeEvent && '(₹)'}
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Qty / Seats
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Early Bird (₹)
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sales End
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                  <th className="w-[88px] px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {passes.map((pass, i) => {
                  const clr        = PASS_COLORS[i % PASS_COLORS.length]
                  const isDeleting = deleteConfirmId === pass.id
                  return (
                    <tr
                      key={pass.id}
                      className={cn(
                        'group border-b border-border/40 transition-colors last:border-0',
                        isDeleting ? 'bg-red-50/60' : 'hover:bg-muted/[0.04]',
                      )}
                    >
                      {/* Pass name + description */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', clr.bg)}>
                            <Ticket className={cn('size-3.5', clr.color)} aria-hidden />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[14px] font-semibold leading-tight text-foreground">
                              {pass.name}
                            </p>
                            <p className="mt-0.5 max-w-[180px] truncate text-[12px] leading-snug text-muted-foreground">
                              {pass.description}
                            </p>
                          </div>
                        </div>
                      </td>
                      {/* Price */}
                      <td className="px-3 py-3">
                        {isFreeEvent ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-[2px] text-[12px] font-semibold text-emerald-600">
                            Free
                          </span>
                        ) : (
                          <span className="text-[13px] font-bold text-foreground">{formatINR(pass.price)}</span>
                        )}
                      </td>
                      {/* Quantity */}
                      <td className="px-3 py-3 text-[14px] text-foreground">
                        {pass.quantity !== null
                          ? pass.quantity.toLocaleString('en-IN')
                          : <span className="text-muted-foreground">Unlimited</span>
                        }
                      </td>
                      {/* Early bird price */}
                      <td className="px-3 py-3">
                        {pass.earlyBirdEnabled && pass.earlyBirdPrice !== null ? (
                          <span className="text-[14px] font-medium text-primary">
                            {formatINR(pass.earlyBirdPrice)}
                          </span>
                        ) : (
                          <span className="text-[12px] text-muted-foreground/40">—</span>
                        )}
                      </td>
                      {/* Sales end date */}
                      <td className="px-3 py-3 text-[12px] text-muted-foreground">
                        {pass.salesEndDate
                          ? new Date(pass.salesEndDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                          : <span className="text-muted-foreground/40">—</span>
                        }
                      </td>
                      {/* Status toggle */}
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => toggleStatus(pass.id)}
                          aria-label={`${pass.status === 'active' ? 'Deactivate' : 'Activate'} ${pass.name}`}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors',
                            pass.status === 'active'
                              ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                              : 'bg-muted text-muted-foreground hover:bg-muted/70',
                          )}
                        >
                          <span className={cn(
                            'size-1.5 rounded-full',
                            pass.status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                          )} />
                          {pass.status === 'active' ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                      {/* Row actions */}
                      <td className="px-3 py-3">
                        {isDeleting ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleDeleteConfirm(pass.id)}
                              className="rounded bg-red-500 px-2 py-0.5 text-[12px] font-semibold text-white hover:bg-red-600"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmId(null)}
                              className="rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/40"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => onEdit(pass)}
                              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-primary/10 hover:text-primary"
                              aria-label={`Edit ${pass.name}`}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDuplicate(pass)}
                              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-muted/60 hover:text-foreground"
                              aria-label={`Duplicate ${pass.name}`}
                            >
                              <Copy className="size-3.5" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmId(pass.id)}
                              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-red-50 hover:text-red-500"
                              aria-label={`Delete ${pass.name}`}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Secondary add link — only shown when table already has entries */}
      {passes.length > 0 && (
        <button
          type="button"
          onClick={onAddNew}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Plus className="size-3.5" aria-hidden />
          Add another pass
        </button>
      )}
    </div>
  )
}

// Section 4: Registration Schedule — timeline-style card
function RegistrationPeriodSection({
  draft,
  onUpdate,
}: {
  draft:    EventPricingDraft
  onUpdate: (partial: Partial<EventPricingDraft>) => void
}) {
  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

  const milestones = [
    {
      key:     'open' as const,
      icon:    Zap,
      label:   'Registration Opens',
      hint:    'When attendees can start registering',
      optional: false,
      value:   draft.registrationOpenDate,
      onChange:(v: string) => onUpdate({ registrationOpenDate: v }),
      dotCls:  'bg-primary',
      iconCls: 'bg-primary/10 text-primary',
    },
    // Early Bird Ends is intentionally NOT here — it is a pass-level field set in
    // the pass editor (Pricing section), not an event-wide schedule milestone.
    {
      key:     'close' as const,
      icon:    Lock,
      label:   'Registration Closes',
      hint:    'Last day attendees can register',
      optional: false,
      value:   draft.registrationEndDate,
      onChange:(v: string) => onUpdate({ registrationEndDate: v }),
      dotCls:  'bg-rose-400',
      iconCls: 'bg-rose-50 text-rose-500',
    },
  ] as const

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <p className="text-[15px] font-bold tracking-tight text-foreground">Registration Schedule</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Control when your event is open for registration.
        </p>
      </div>

      {/* Timeline */}
      <div className="px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-0">
          {milestones.map(({ key, icon: Icon, label, hint, optional, value, onChange, dotCls, iconCls }, i, arr) => (
            <div key={key} className="flex items-start gap-4">
              {/* Dot + connector */}
              <div className="flex flex-col items-center">
                <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', iconCls)}>
                  <Icon className="size-4" aria-hidden />
                </div>
                {i < arr.length - 1 && (
                  <div className="my-1.5 w-px flex-1 bg-border/60" style={{ minHeight: '28px' }} />
                )}
              </div>

              {/* Content */}
              <div className={cn('min-w-0 flex-1', i < arr.length - 1 ? 'pb-5' : '')}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <label className="text-[13px] font-semibold text-foreground">{label}</label>
                  {optional && (
                    <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
                      Optional
                    </span>
                  )}
                  {value && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[12px] font-semibold text-primary">
                      {new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>
                <input
                  type="date"
                  value={value}
                  onChange={e => onChange(e.target.value)}
                  className={cn(inputCls, 'max-w-[220px]')}
                  aria-label={label}
                />
                <p className="mt-1.5 text-[13px] text-muted-foreground">{hint}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Show remaining seats toggle */}
        <div className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-muted/[0.04] px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/50">
              <Users className="size-4 text-muted-foreground" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">Show remaining seats</p>
              <p className="text-[13px] text-muted-foreground">Encourages early registration by showing available capacity</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.showRemainingSeats}
            onClick={() => onUpdate({ showRemainingSeats: !draft.showRemainingSeats })}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              draft.showRemainingSeats ? 'bg-primary' : 'bg-muted-foreground/25',
            )}
          >
            <span className={cn(
              'inline-block size-[20px] rounded-full bg-white shadow-sm transition-transform duration-200',
              draft.showRemainingSeats ? 'translate-x-5' : 'translate-x-0',
            )} />
          </button>
        </div>
      </div>
    </div>
  )
}

function AdvancedSettingsSection({
  isOpen,
  onToggle,
}: {
  isOpen:   boolean
  onToggle: () => void
}) {
  const ITEMS = [
    {
      icon:  Hash,
      label: 'Taxes',
      desc:  'Configure GST and applicable tax rates',
      badge: '0 configured',
    },
    {
      icon:  IndianRupee,
      label: 'Convenience Fees',
      desc:  'Platform and payment gateway fees',
      badge: '0 configured',
    },
    {
      icon:  Tag,
      label: 'Coupons & Promo Codes',
      desc:  'Discount codes for attendees',
      badge: '0 active',
    },
    {
      icon:  TrendingUp,
      label: 'Group Discounts',
      desc:  'Volume discounts for group registrations',
      badge: '0 configured',
    },
  ]

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm transition-colors hover:bg-muted/[0.03]"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2.5">
          <Settings2 className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Advanced Settings</p>
          <span className="rounded-full bg-muted/60 px-2 py-[2px] text-[12px] font-medium text-muted-foreground">
            Optional
          </span>
        </div>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-180')}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2">
              {ITEMS.map(item => {
                const Icon = item.icon
                return (
                  <button
                    key={item.label}
                    type="button"
                    className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-sm transition-colors hover:border-border/80 hover:bg-muted/[0.04]"
                  >
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
                      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold text-foreground">{item.label}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{item.desc}</p>
                    </div>
                    <span className="mt-0.5 shrink-0 rounded-full bg-muted/50 px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
                      {item.badge}
                    </span>
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

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
  const apFees = calcFees(samplePrice, 'attendee_pays', rates)
  const oaFees = calcFees(samplePrice, 'organizer_absorbs', rates)

  const OPTIONS = [
    {
      id:      'attendee_pays' as FeeModel,
      label:   'Attendee Pays Fees',
      badge:   'Recommended',
      badgeCls:'bg-emerald-100 text-emerald-700',
      desc:    'Fees are added on top of your ticket price. You receive the full ticket value.',
      fees:    apFees,
      summaryNote: 'You receive the full amount',
      summaryCls:  'text-emerald-700',
    },
    {
      id:      'organizer_absorbs' as FeeModel,
      label:   'Organizer Absorbs Fees',
      badge:   null as string | null,
      badgeCls:'',
      desc:    'Attendees pay only the ticket price. Platform fees are deducted from your payout.',
      fees:    oaFees,
      summaryNote: 'Fees deducted from your payout',
      summaryCls:  'text-amber-700',
    },
  ] as const

  return (
    <div className="border-t border-border/60 px-5 pt-5 sm:px-6">
      <p className="mb-1 text-[13px] font-semibold text-foreground">Fee Collection Method</p>
      <p className="mb-4 text-[12px] text-muted-foreground">
        Choose who pays RegisterDesk platform charges — based on a {formatINR(samplePrice)} ticket.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OPTIONS.map(opt => {
          const selected = feeModel === opt.id
          return (
            <motion.div
              key={opt.id}
              role="button"
              tabIndex={0}
              whileTap={{ scale: 0.985 }}
              onClick={() => onChange(opt.id)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onChange(opt.id)
                }
              }}
              aria-pressed={selected}
              className={cn(
                'group relative flex cursor-pointer flex-col rounded-xl border-[1.5px] bg-card p-4 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
                selected
                  ? 'border-primary bg-primary/[0.02] ring-1 ring-primary/10'
                  : 'border-border hover:border-primary/30 hover:shadow-sm',
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

              {/* Embedded example with breakdown popovers */}
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

function Step4SummaryPanel({ pricing }: { pricing: EventPricingDraft }) {
  const activePasses     = pricing.passes.filter(p => p.status === 'active')
  const paidActivePasses = activePasses.filter(p => pricing.eventType === 'paid' && p.price > 0)
  const freePasses       = activePasses.filter(p => pricing.eventType === 'free' || p.price === 0)
  const hasUnlimited     = pricing.passes.some(p => p.unlimited)
  const totalSeats       = hasUnlimited
    ? null
    : pricing.passes.reduce((s, p) => s + (p.quantity ?? 0), 0)

  return (
    <aside className="flex flex-col gap-3 lg:sticky lg:top-5">

      {/* Pricing Summary */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <p className="text-[14px] font-semibold text-foreground">Pricing Summary</p>
        </div>
        <div className="flex flex-col gap-0 divide-y divide-border/40 px-4 py-1">
          {([
            { label: 'Total Passes',  val: String(pricing.passes.length) },
            { label: 'Active Passes', val: String(activePasses.length)   },
            { label: 'Paid Passes',   val: String(paidActivePasses.length), hidden: pricing.eventType !== 'paid' },
            { label: 'Free Passes',   val: String(freePasses.length),       hidden: paidActivePasses.length === 0 && pricing.eventType === 'paid' },
            {
              label: 'Total Capacity',
              val:   hasUnlimited
                ? 'Unlimited'
                : totalSeats != null && totalSeats > 0
                ? totalSeats.toLocaleString('en-IN')
                : '—',
              valCls: hasUnlimited ? 'text-amber-600' : '',
            },
          ] as Array<{ label: string; val: string; valCls?: string; hidden?: boolean }>)
            .filter(r => !r.hidden)
            .map(({ label, val, valCls }) => (
              <div key={label} className="flex items-center justify-between py-2.5">
                <span className="text-[12px] text-muted-foreground">{label}</span>
                <span className={cn('text-[12px] font-semibold', valCls ?? 'text-foreground')}>{val}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Event Preview */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Eye className="size-3.5 text-muted-foreground" aria-hidden />
            <p className="text-[14px] font-semibold text-foreground">Event Preview</p>
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">How passes appear to attendees</p>
        </div>
        <div className="px-4 py-3">
          <div className="overflow-hidden rounded-lg border border-border/60">
            {/* Mini event header */}
            <div className="bg-gradient-to-br from-primary/[0.08] to-primary/[0.04] px-3 py-3">
              <p className="text-[12px] font-semibold text-foreground">Your Event Name</p>
              <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Calendar className="size-3" aria-hidden />
                <span>Date TBD · Venue TBD</span>
              </div>
            </div>

            {/* Pass list preview */}
            {pricing.passes.length > 0 ? (
              <div className="divide-y divide-border/40">
                {pricing.passes.slice(0, 3).map((pass, i) => (
                  <div key={pass.id} className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={cn('size-2 rounded-full', PASS_COLORS[i % PASS_COLORS.length].dot)} />
                      <span className="max-w-[110px] truncate text-[13px] font-medium text-foreground">
                        {pass.name}
                      </span>
                    </div>
                    <span className="text-[13px] font-bold text-primary">
                      {pricing.eventType === 'free' ? 'Free' : formatINR(pass.price)}
                    </span>
                  </div>
                ))}
                {pricing.passes.length > 3 && (
                  <p className="px-3 py-1.5 text-center text-[12px] text-muted-foreground">
                    +{pricing.passes.length - 3} more pass{pricing.passes.length - 3 !== 1 ? 'es' : ''}
                  </p>
                )}
              </div>
            ) : (
              <div className="px-3 py-5 text-center">
                <p className="text-[13px] text-muted-foreground/60">No passes added yet</p>
              </div>
            )}

            {/* Register CTA preview */}
            <div className="border-t border-border/40 px-3 py-2.5">
              <div className="rounded-lg bg-primary/10 py-2 text-center">
                <p className="flex items-center gap-1 text-[13px] font-bold text-primary">
                  Register Now <ArrowRight className="size-3" aria-hidden />
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Need help */}
      <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5">
          <Headphones className="size-3.5 shrink-0 text-foreground" aria-hidden />
          <p className="text-[12px] font-semibold text-foreground">Need help with pricing?</p>
        </div>
        <p className="mb-2.5 text-[12px] leading-relaxed text-muted-foreground">
          Learn about ticket types, early bird pricing, and revenue best practices.
        </p>
        {/* GA-7 S1: pricing guide not yet published — action hidden until the guide exists. */}
      </div>

    </aside>
  )
}

// --- Step 4: RegisterDesk Services & Pricing section -------------------------

const OPTIONAL_SERVICES = [
  { label: 'Email Notifications', badge: 'Included',  badgeCls: 'bg-emerald-100 text-emerald-700',                     desc: 'Confirmations & reminders' },
  { label: 'WhatsApp',           badge: 'Optional',  badgeCls: 'bg-amber-100 text-amber-700',    cost: '₹0.10/msg', desc: 'Usage-based add-on'       },
  { label: 'SMS',                badge: 'Optional',  badgeCls: 'bg-amber-100 text-amber-700',    cost: '₹0.15/msg', desc: 'Usage-based add-on'       },
  { label: 'Certificates',       badge: 'Optional',  badgeCls: 'bg-blue-100 text-blue-700',                           desc: 'Digital certificate generation' },
] as const

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
  }

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
      rate:     '₹0.10 per delivered message',
      rateNote: isFreeEvent ? 'Pre-paid credits required' : 'Deducted at settlement',
      example:  '100 attendees × 2 messages ≈ ₹20',
    },
    {
      key:      'smsEnabled',
      Icon:     MoreHorizontal,
      label:    'SMS Notifications',
      always:   false,
      badge:    'Optional',
      badgeCls: 'bg-amber-100 text-amber-700',
      desc:     isFreeEvent
        ? 'Recharge credits before sending messages'
        : 'Charges deducted from settlement amount',
      rate:     '₹0.15 per delivered message',
      rateNote: isFreeEvent ? 'Pre-paid credits required' : 'Deducted at settlement',
      example:  '100 attendees × 2 messages ≈ ₹30',
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
          const isOn   = svc.always || !!values[svc.key as keyof CommAddonValues]
          const canTog = !svc.always

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

function Step4View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData }: StepViewProps) {
  const eventTypeId  = (initialData?.eventTypeId  as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype as string | null) ?? null

  const [pricing, setPricing] = useState<EventPricingDraft>(() => {
    const savedRaw = initialData?.pricing as (EventPricingDraft & { earlyBirdEndDate?: unknown }) | null
    if (savedRaw) {
      // LS3.2 migration: the early-bird end date used to live at the event level
      // (pricing.earlyBirdEndDate). It now belongs only to the pass
      // (pricing.passes[].earlyBirdEndDate). Backfill any legacy value into
      // early-bird-enabled passes that don't yet have their own date, then drop
      // the legacy field so there is exactly one source of truth. No data loss.
      const { earlyBirdEndDate: legacyEbEnd, ...saved } = savedRaw
      const legacy = typeof legacyEbEnd === 'string' ? legacyEbEnd.trim() : ''
      const passes = Array.isArray(saved.passes)
        ? saved.passes.map(p =>
            legacy && p.earlyBirdEnabled && !p.earlyBirdEndDate
              ? { ...p, earlyBirdEndDate: legacy }
              : p,
          )
        : saved.passes
      return {
        ...saved,
        passes,
        feeModel:               saved.feeModel               ?? 'attendee_pays',
        estimatedRegistrations: saved.estimatedRegistrations ?? 100,
        whatsappEnabled:        saved.whatsappEnabled        ?? false,
        smsEnabled:             saved.smsEnabled             ?? false,
        certEnabled:            saved.certEnabled            ?? false,
      }
    }
    return {
      eventType:              'paid',
      feeModel:               'attendee_pays',
      estimatedRegistrations: 100,
      passes:                 [],
      registrationOpenDate:   '',
      registrationEndDate:    '',
      showRemainingSeats:     true,
      whatsappEnabled:        false,
      smsEnabled:             false,
      certEnabled:            false,
      advancedSettings:       { taxes: [], fees: [], coupons: [], discounts: [] },
    }
  })
  const [advancedOpen,  setAdvancedOpen]  = useState(false)
  const [addPassOpen,   setAddPassOpen]   = useState(false)
  const [editingPass,   setEditingPass]   = useState<EventPass | null>(null)

  const updatePricing = (partial: Partial<EventPricingDraft>) =>
    setPricing(prev => ({ ...prev, ...partial }))

  const handleSavePass = (saved: EventPass) => {
    if (editingPass) {
      updatePricing({ passes: pricing.passes.map(p => p.id === saved.id ? saved : p) })
    } else {
      updatePricing({ passes: [...pricing.passes, saved] })
    }
    setEditingPass(null)
  }

  const handleEditPass = (pass: EventPass) => {
    setEditingPass(pass)
    setAddPassOpen(true)
  }

  const handleAddNew = () => {
    setEditingPass(null)
    setAddPassOpen(true)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >

      {/* -- Back link -- */}
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      {/* -- Stepper -- */}
      <Stepper currentStep={currentStep} completedValues={completedValues} />

      {/* -- Title -- */}
      <div className="mt-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Passes &amp; Pricing
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Configure your plan, ticket types, and registration schedule.
        </p>
      </div>

      {/* -- Main content -- */}
      <div className="mt-4 grid flex-1 items-start gap-5 lg:grid-cols-[1fr_280px]">

        {/* Left column — min-w-0 prevents the table from stretching the grid */}
        <div className="flex min-w-0 flex-col gap-5">

          {/* SECTION 1: RegisterDesk Plan */}
          <EventTypeSelectorSection
            value={pricing.eventType}
            onChange={v => updatePricing({ eventType: v })}
          />

          {/* SECTION 2: Ticket Types & Pricing */}
          {(() => {
            const hasUnlimitedPass = pricing.passes.some(p => p.unlimited)
            const totalCapacity    = hasUnlimitedPass
              ? null
              : pricing.passes.reduce((s, p) => s + (p.quantity ?? 0), 0)
            return (
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            {/* Section header */}
            <div className="border-b border-border px-5 py-4 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
                    <Ticket className="size-4 text-primary" aria-hidden />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[15px] font-bold tracking-tight text-foreground">Ticket Types &amp; Pricing</p>
                      {hasUnlimitedPass ? (
                        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[12px] font-semibold text-amber-700">
                          Unlimited Capacity
                        </span>
                      ) : totalCapacity != null && totalCapacity > 0 ? (
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[12px] font-semibold text-muted-foreground">
                          {totalCapacity.toLocaleString('en-IN')} Attendees
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      Create ticket categories with different pricing and limits.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleAddNew}
                  className={cn(
                    buttonVariants({ variant: 'outline' }),
                    'shrink-0 gap-1.5 border-primary/30 text-primary hover:border-primary/60 hover:bg-primary/[0.03] text-[12px]',
                  )}
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add Pass
                </button>
              </div>
            </div>

            {/* Passes table */}
            <div className="px-5 py-5 sm:px-6">
              <PassesSection
                passes={pricing.passes}
                isFreeEvent={pricing.eventType === 'free'}
                onUpdate={passes => updatePricing({ passes })}
                onAddNew={handleAddNew}
                onEdit={handleEditPass}
              />
            </div>

            {/* Spacer at bottom when section has content */}
            <div className="h-5" />
          </div>
            )
          })()}

          {/* SECTION 3: Registration Schedule */}
          <RegistrationPeriodSection
            draft={pricing}
            onUpdate={updatePricing}
          />

          {/* Advanced Settings */}
          <AdvancedSettingsSection
            isOpen={advancedOpen}
            onToggle={() => setAdvancedOpen(v => !v)}
          />

        </div>

        {/* Right column: summary panel */}
        <Step4SummaryPanel pricing={pricing} />

      </div>

      {pricing.passes.length === 0 && (
        <p className="mt-4 text-center text-[13px] font-medium text-amber-600">
          At least one pass is required before continuing.
        </p>
      )}

      <WizardFooter
        onBack={onBack}
        onSaveDraft={() => onSaveDraft?.(pricing)}
        onNext={() => onNext('Passes & Pricing', pricing)}
        isNextDisabled={pricing.passes.length === 0}
        stepContext={`Step ${currentStep + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[currentStep]?.name ?? ''}`}
      />

      {/* Add / Edit Pass editor overlay */}
      <AddPassEditor
        isOpen={addPassOpen}
        onClose={() => { setAddPassOpen(false); setEditingPass(null) }}
        onSave={handleSavePass}
        editingPass={editingPass}
        eventTypeId={eventTypeId}
        eventSubtype={eventSubtype}
        isFreeEvent={pricing.eventType === 'free'}
      />

    </motion.div>
  )
}

// --- Step 5 view — Registration Form -----------------------------------------

function Step5View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData }: StepViewProps) {
  const eventTypeId  = (initialData?.eventTypeId  as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype as string | null) ?? null

  const rawForm    = initialData?.registrationForm
  const accessCtrl = initialData?.accessControl as { confirmationMode?: string } | null
  const [form, setForm] = useState<RegistrationFormDraft>(() => {
    if (rawForm != null) return rawForm as unknown as RegistrationFormDraft
    const blank = makeBlankFormDraft()
    if (accessCtrl?.confirmationMode === 'manual') {
      blank.registrationRules = { ...blank.registrationRules, approvalMode: 'manual' }
      blank.settings          = { ...blank.settings, requireApproval: true }
    }
    return blank
  })

  // Extract pass summaries from Step 4 pricing data for pass-linked field visibility.
  const passes: PassSummary[] = (() => {
    const pricing = initialData?.pricing as { passes?: EventPassFull[] } | null | undefined
    return (pricing?.passes ?? [])
      .filter(p => p.name.trim().length > 0)
      .map(p => ({ id: p.id, name: p.name }))
  })()

  // A form is ready to proceed when a template is chosen OR at least one field exists.
  const canProceed   = form.template.length > 0 || form.fields.length > 0
  const [step5Error, setStep5Error] = useState<string | null>(null)

  const handleNext = () => {
    if (!canProceed) {
      setStep5Error('Select a template or add at least one field before continuing.')
      return
    }
    setStep5Error(null)
    onNext('Registration Form', form)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      {/* -- Back link -- */}
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      {/* -- Stepper -- */}
      <Stepper currentStep={currentStep} completedValues={completedValues} />

      {/* -- Title -- */}
      <div className="mt-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Registration Form
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Select a template and customise your attendee registration form.
        </p>
      </div>

      {/* -- Builder -- */}
      <div className="mt-4 flex-1">
        <RegistrationFormBuilder
          form={form}
          onChange={f => { setForm(f); if (step5Error) setStep5Error(null) }}
          eventTypeId={eventTypeId}
          eventSubtype={eventSubtype}
          passes={passes}
          syncedApprovalMode={
            accessCtrl?.confirmationMode === 'manual' || accessCtrl?.confirmationMode === 'auto'
              ? (accessCtrl.confirmationMode as 'auto' | 'manual')
              : null
          }
        />
      </div>

      {/* -- Validation banner -- */}
      <AnimatePresence>
        {step5Error && (
          <motion.div
            key="step5-error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/60 px-3 py-2.5 text-[13px] text-amber-800"
            role="alert"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            {step5Error}
          </motion.div>
        )}
      </AnimatePresence>

      <WizardFooter
        onBack={onBack}
        onSaveDraft={() => onSaveDraft?.(form)}
        onNext={handleNext}
        stepContext={`Step ${currentStep + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[currentStep]?.name ?? ''}`}
      />
    </motion.div>
  )
}

// --- Step 6 view — Event Details & Communication -----------------------------

function Step6View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData, focusHint }: StepViewProps) {
  const eventTypeId  = (initialData?.eventTypeId  as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype as string | null) ?? null
  const rawForm      = initialData?.eventDetails
  const draftId      = (initialData?.draftId as string | null) ?? null
  const uid          = auth.currentUser?.uid ?? null
  const uploadContext = uid && draftId ? { uid, draftId } : undefined

  const pricingPasses = (() => {
    const pricing = initialData?.pricing as { passes?: EventPassFull[] } | null | undefined
    return (pricing?.passes ?? [])
      .filter((p: EventPassFull) => p.name.trim().length > 0)
      .map((p: EventPassFull) => ({ id: p.id, name: p.name, price: p.price, type: p.type as 'paid'|'free' }))
  })()

  const [form, setForm] = useState<EventDetailsDraft>(() =>
    // normalizeEventDetailsDraft deep-merges Firestore data with blank defaults,
    // ensuring no nested sub-object is ever undefined regardless of schema drift.
    rawForm != null ? normalizeEventDetailsDraft(rawForm) : makeBlankEventDetailsDraft()
  )

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className="flex flex-col">
      <Link href={ROUTES.DASHBOARD} className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
        <ArrowLeft className="size-4" aria-hidden />Back to Dashboard
      </Link>
      <Stepper currentStep={currentStep} completedValues={completedValues} />
      <div className="mt-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">Event Details &amp; Communication</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Configure your event page, venue, schedule, and attendee communication.</p>
      </div>
      <div className="mt-4">
        <EventDetailsBuilder
          form={form}
          onChange={setForm}
          eventTypeId={eventTypeId}
          eventSubtype={eventSubtype}
          pricingPasses={pricingPasses}
          uploadContext={uploadContext}
          focusHint={focusHint}
        />
      </div>
      <WizardFooter
        onBack={onBack}
        onSaveDraft={() => onSaveDraft?.(form)}
        onNext={() => onNext('Event Details', form)}
        stepContext={`Step ${currentStep + 1} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[currentStep]?.name ?? ''}`}
      />
    </motion.div>
  )
}

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
  const fees = calcFees(basePrice, feeModel, feeRatesFrom(feesCfg))

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

// --- Step 7 view — Review & Publish ------------------------------------------


interface StepCheck {
  label:    string
  passed:   boolean
  required: boolean
  detail?:  string
}

interface StepSummary {
  index:  number
  name:   string
  icon:   LucideIcon
  earned: number
  max:    number
  status: 'complete' | 'partial' | 'missing'
  value?: string
  checks: StepCheck[]
}

interface ReadinessReport {
  score:        number
  steps:        StepSummary[]
  // Mandatory publish requirements — the SAME shared source the server uses.
  // Drives both the Action Required list and canPublish (payment gate).
  requirements: PublishRequirement[]
  blockers:     string[]
  warnings:     string[]
  canPublish:   boolean
}

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
            Choose how platform fees will be handled for this event.
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
  const reviewLicenseTier: EventLicenseTier = isEventLicenseTier(initialData?.licenseTier)
    ? initialData.licenseTier
    : 'starter'

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
  const [localFeeModel,  setLocalFeeModel]  = useState<FeeModel>(() =>
    (pricingData?.feeModel as FeeModel | undefined) ?? 'attendee_pays')
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

  const handleConfirmPublish = useCallback(async () => {
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
        body: JSON.stringify({ draftId }),
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
  }, [publishState, draftId, onNext, showToast])

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
  const licenseCatalog = useLicenseCatalog()
  const licenseDef     = licenseCatalog[reviewLicenseTier]
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

      <Stepper currentStep={currentStep} completedValues={completedValues} />

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
            onConfirm={handleConfirmPublish}
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
  selectedTier:    EventLicenseTier
  onSelectLicense: (t: EventLicenseTier) => void
}) {
  const [tier, setTier] = useState<EventLicenseTier>(selectedTier)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const licenseCatalog = useLicenseCatalog()

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

  const select = (t: EventLicenseTier) => { setTier(t); onSelectLicense(t) }
  const handleNext = () => { onSelectLicense(tier); onNext(`License: ${licenseCatalog[tier].name}`, tier) }

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
  const { draft, isLoading, createDraft, updateDraft } = useDraft()

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
    [currentStep, completedValues, createDraft, updateDraft, isEventPlusDonation, draft?.id, pending],
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

  const sharedProps = { completedValues, onNext: goNext, onBack: goBack }

  // Selected Event License tier (F2.1) — defaults to Starter until the organizer chooses.
  const selectedLicense: EventLicenseTier = isEventLicenseTier(draft?.licenseTier)
    ? draft.licenseTier
    : 'starter'
  const onSelectLicense = (t: EventLicenseTier) => { void updateDraft({ licenseTier: t }) }

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
          initialData={{ pricing: draft?.pricing ?? null, eventTypeId: draft?.eventType ?? null, eventSubtype: draft?.eventSubtype ?? null }}
        />
      )}
      {currentStep === 4 && (
        <Step5View
          currentStep={4}
          {...sharedProps}
          onSaveDraft={data => saveDraft(4, data)}
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
