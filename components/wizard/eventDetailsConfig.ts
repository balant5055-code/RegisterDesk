// Config-driven data model, factories, dynamic section config, and health calculation
// for Step 6: Event Details & Communication.

// ─── Union types ──────────────────────────────────────────────────────────────

export type VenueType        = 'physical' | 'online' | 'hybrid'
export type OnlinePlatform   = 'zoom' | 'google_meet' | 'ms_teams' | 'webex' | 'youtube_live' | 'custom'
export type CommChannel      = 'email' | 'whatsapp' | 'sms'
export type SessionType      = 'keynote' | 'panel' | 'workshop' | 'networking' | 'break' | 'session' | 'custom'
export type SponsorTier      = 'title' | 'gold' | 'silver' | 'bronze' | 'partner' | 'media'
export type RecordSourceType = 'new' | 'existing_library' | 'imported_event'
export type ReminderTiming   = '7d' | '3d' | '1d' | '2h' | 'custom'
export type MediaSource      = 'upload' | 'url'

export interface MediaAsset {
  source:            MediaSource
  value:             string   // data URL (upload) or external URL (url)
  originalFileName?: string
  /**
   * RD-GALLERY-01 — how a GALLERY image was added. An upload is stored with `source: 'url'` (its
   * storage URL), so this is what tells it apart from a pasted link for the separate 6-upload /
   * 20-URL limits. Optional: older entries have none and are classified by their address
   * (lib/events/galleryLimits).
   */
  origin?:           'upload' | 'url'
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface EventInfo {
  name:      string
  tagline:   string
  shortDesc: string
  fullDesc:  string
  language:  string
  dressCode: string
}

export interface MediaConfig {
  logo:             MediaAsset
  coverBanner:      MediaAsset
  // Banner crop state — persisted so the crop modal can restore position on re-edit.
  // Pixel offsets are at the 288 px-wide crop preview scale; scale is 1.0–4.0.
  bannerPositionX:  number
  bannerPositionY:  number
  bannerScale:      number
  galleryImages:    MediaAsset[]
  promoVideoUrl:    string
}

export interface VenueMaps {
  layoutImageUrl:  string
  parkingMapUrl:   string
  entryGateMapUrl: string
}

export interface PhysicalVenueConfig {
  name:         string
  addressLine1: string
  addressLine2: string
  city:         string
  state:        string
  country:      string
  pincode:      string
  mapsLink:     string
  instructions: string
  maps:         VenueMaps
}

export interface OnlineVenueConfig {
  platform:                OnlinePlatform
  platformCustomName:      string
  meetingUrl:              string
  meetingId:               string
  passcode:                string
  revealAfterRegistration: boolean
  joinInstructions:        string
}

export interface VenueConfig {
  type:     VenueType
  physical: PhysicalVenueConfig
  online:   OnlineVenueConfig
}

export interface AgendaSession {
  id:          string
  date:        string    // ISO date
  startTime:   string    // HH:MM 24h
  endTime:     string    // HH:MM
  title:       string
  description: string
  type:        SessionType
  speakerIds:  string[]
  location:    string
  track:       string
  isBreak:     boolean
  order:       number
}

export interface EventSchedule {
  timezone:      string
  startDate:     string
  startTime:     string
  endDate:       string
  endTime:       string
  doorsOpenTime: string
  agenda:        AgendaSession[]
}

export interface OrganizerSocial {
  facebook:  string
  instagram: string
  linkedin:  string
  youtube:   string
  twitter:   string
  hashtags:  string[]
}

export interface OrganizerInfo {
  name:    string
  email:   string
  phone:   string
  website: string
  logoUrl: string
  social:  OrganizerSocial
  // Optional trust/profile fields — rendered by OrganizerShowcase only when present.
  tagline?:      string
  bio?:          string
  verified?:     boolean
  foundedYear?:  number
  eventsHosted?: number
}

export interface ReminderRule {
  id:            string
  enabled:       boolean
  timing:        ReminderTiming
  customHours?:  number
  channels:      CommChannel[]
}

export interface CommunicationConfig {
  confirmation: {
    channels:         CommChannel[]
    calendarInvite:   boolean
    generateQrTicket: boolean
  }
  reminders: ReminderRule[]
}

export interface RefundWindow {
  fullRefundDaysBefore:    number | null
  partialRefundDaysBefore: number | null
  partialRefundPercent:    number
  noRefundDaysBefore:      number | null
  useExternalPolicyUrl:    boolean
}

export interface SupportConfig {
  supportEmail:     string
  supportPhone:     string
  faqUrl:           string
  termsUrl:         string
  refundPolicyUrl:  string
  privacyPolicyUrl: string
  refundWindow:     RefundWindow
}

export interface SeoConfig {
  urlSlug:         string
  metaTitle:       string
  metaDescription: string
  shareImageUrl:   string
  keywords:        string[]
  utmSource:       string
  utmMedium:       string
  utmCampaign:     string
}

export interface PublicPageSettings {
  showOrganizerInfo: boolean
  showSpeakers:      boolean
  showSponsors:      boolean
  showVenueMap:      boolean
  showAgenda:        boolean
  showGallery:       boolean
  showSocialLinks:   boolean
  showAttendeeCount: boolean
}

export interface IntegrationsConfig {
  webhookUrl:        string
  zapierWebhookUrl:  string
  googleAnalyticsId: string
  metaPixelId:       string
}

export interface ApplicationsCfgEntry {
  enabled:     boolean
  closingDate: string
  message:     string
}

export interface ApplicationsConfig {
  speaker: ApplicationsCfgEntry
  sponsor: ApplicationsCfgEntry
}

export interface Speaker {
  id:            string
  name:          string
  title:         string
  company:       string
  bio:           string
  photoUrl:      string
  social:        { linkedin: string; twitter: string }
  sourceType:    RecordSourceType
  libraryId?:    string
  sourceEventId?:string
  order:         number
}

export interface Sponsor {
  id:            string
  name:          string
  logoUrl:       string
  website:       string
  tier:          SponsorTier
  sourceType:    RecordSourceType
  libraryId?:    string
  sourceEventId?:string
  order:         number
  // Optional public-page fields — rendered by SponsorsShowcase only when present.
  description?:  string
  displayOrder?: number
  enabled?:      boolean
  featured?:     boolean
  themeColor?:   string
  category?:     string
  location?:     string
  since?:        string | number
  tags?:         string[]
  industry?:     string
  country?:      string
  socials?:      { label?: string; url: string }[]
  brandGuidelines?: string
}

export interface ConferenceTrack {
  id:    string
  name:  string
  color: string
}

export interface ConferenceDetails {
  speakers:  Speaker[]
  /** @deprecated Migrate to EventDetailsDraft.sponsors; kept for backward-compat reads. */
  sponsors:  Sponsor[]
  tracks:    ConferenceTrack[]
  hallLayout:string
}

export interface RaceCategory {
  id:              string
  name:            string
  distance:        string
  maxParticipants: number | null
}

export interface SportsRunningDetails {
  routeMapUrl:        string
  reportingTime:      string
  kitCollectionInfo:  string
  kitCollectionDate:  string
  bagDepositInfo:     string
  medicalSupportInfo: string
  hydrationPoints:    string
  startLineInfo:      string
  rulesUrl:           string
  // Sports MVP additions
  requireWaiver:  boolean
  waiverText:     string
  raceCategories: RaceCategory[]
  // v2 label overrides — allow organiser-specific terminology without code changes
  disciplineLabel?:      string
  ctaLabel?:             string
  categoryLabel?:        string
  sessionLabel?:         string
  participantLabel?:     string
  countdownLabel?:       string
  reportingTimeLabel?:   string
  scheduleEyebrow?:      string
  scheduleSubtitle?:     string
  routeEyebrow?:         string
  routeSectionTitle?:    string
  routeSectionSubtitle?: string
  startLineLabel?:       string
  hydrationLabel?:       string
  faqItems?:             { question: string; answer: string }[]
  faqSectionTitle?:      string
  faqSectionSubtitle?:   string
}

export interface TeamSportDetails {
  groundInfo:    string
  matchFormat:   string
  teamSize:      number | null
  matchDuration: string
  rulesUrl:      string
  overs?:        number | null
  squadSize?:    number | null
  courtInfo?:    string
  // RD-WAIVER-01 — the participation waiver, as on SportsRunningDetails. Every sports format
  // can require one (lib/registrations/waiver.ts resolves it from these two fields).
  requireWaiver: boolean
  waiverText:    string
}

export interface WorkshopDetails {
  trainers:          Speaker[]
  prerequisites:     string
  learningOutcomes:  string[]
  materialsIncluded: string
  softwareRequired:  string
  batchSize:         number | null
  hasCertificate:    boolean
}

export interface MeetupFounderDetails {
  startupShowcaseEnabled: boolean
  pitchSessionEnabled:    boolean
  pitchFormat:            string
  investorConnectEnabled: boolean
}

export interface MeetupCorporateDetails {
  guestSpeakers:    string[]
  networkingAgenda: string
}

export interface MeetupAlumniDetails {
  institution:       string
  batchYears:        string
  reunionActivities: string
}

export interface CulturalHighlight {
  id:    string
  label: string
  desc:  string
}

export interface CulturalZone {
  id:   string
  name: string
  desc: string
}

export interface CulturalDetails {
  artists:         Speaker[]
  programSchedule: string
  entryRules:      string
  ageRestriction:  string
  highlights:      CulturalHighlight[]
  experienceZones: CulturalZone[]
}

export interface PastWinner {
  id:           string
  year:         string
  category:     string
  winner:       string
  organisation: string
}

export interface AwardsDetails {
  categories:      { id: string; name: string; description: string }[]
  nominationRules: string
  judgingProcess:  string
  ceremonyFormat:  string
  judges:          Speaker[]
  pastWinners:     PastWinner[]
}

export interface FundraisingDetails {
  beneficiaryInfo:  string
  fundUsage:        string
  donationGoal:     number | null
  ngoPartner:       string
  taxExemptionInfo: string
}

export interface ExhibitorEntry {
  id:          string
  name:        string
  logoUrl:     string
  website:     string
  description: string
  boothNumber: string
  order:       number
}

export interface ExhibitionCategory {
  id:    string
  label: string
  desc:  string
}

export interface ExhibitionDetails {
  boothInfoUrl:         string
  floorPlanUrl:         string
  visitorInstructions:  string
  parkingInfo:          string
  exhibitors:           ExhibitorEntry[]
  exhibitionCategories: ExhibitionCategory[]
}

export interface CommunityDetails {
  causeInfo:             string
  volunteerInstructions: string
  campaignInfo:          string
  impactGoal:            string
}

export type TypeDetails =
  | ConferenceDetails | SportsRunningDetails | TeamSportDetails
  | WorkshopDetails   | MeetupFounderDetails | MeetupCorporateDetails
  | MeetupAlumniDetails | CulturalDetails    | AwardsDetails
  | FundraisingDetails  | ExhibitionDetails  | CommunityDetails
  | null

// ─── Experience ("What Awaits You") ─────────────────────────────────────────────
// Template-agnostic list of what an attendee receives. Read by every template's
// shared ExperienceSection. Only `id`, `title` and `enabled` are required; every
// other field renders only when the organiser provides it. Future-proofed with
// optional fields so the section can grow without a schema migration.
export interface ExperienceItem {
  id:            string
  title:         string
  enabled:       boolean
  description?:  string
  icon?:         string        // key from the curated set (unknown/blank → no icon)
  image?:        string        // when present, replaces the icon with imagery
  category?:     string        // enables auto-grouping
  displayOrder?: number
  priority?:     number
  highlight?:    string        // short tag, e.g. "Included"
  // Future-proof optional fields — never rendered unless present.
  themeColor?:   string
  badge?:        string
  gallery?:      string[]
  video?:        string
  cta?:          string
  link?:         string
}

// ─── Event Journey (timeline) ───────────────────────────────────────────────────
// Template-agnostic "what happens on event day" list, read by the shared
// JourneySection. Only `id`, `title`, `enabled` are required; everything else
// renders only when the organiser provides it.
export interface TimelineItem {
  id:            string
  title:         string
  enabled:       boolean
  time?:         string        // "09:00"
  endTime?:      string
  date?:         string        // "2027-01-01"
  day?:          number | string
  description?:  string
  location?:     string
  speaker?:      string
  category?:     string        // optional sub-grouping within a day
  icon?:         string        // curated key; unknown/blank → plain node
  image?:        string
  highlight?:    string
  status?:       'done' | 'live' | 'upcoming' | string
  displayOrder?: number
  // Future-proof optional fields — never rendered unless present.
  themeColor?:   string
  badge?:        string
  link?:         string
  cta?:          string
  duration?:     string
  important?:    boolean
  attachments?:  { label?: string; url: string }[]
}

// ─── Gallery (proof) ─────────────────────────────────────────────────────────────
// Template-agnostic media list read by the shared GalleryShowcase. Only `id`, `url`
// and `enabled` are required; everything else renders only when present. Supports
// images plus self-hosted / YouTube / Vimeo video (auto-detected).
export interface GalleryItem {
  id:            string
  url:           string
  enabled:       boolean
  type?:         'image' | 'video' | 'drone' | 'poster' | 'banner' | 'reel'
  thumbnail?:    string
  title?:        string
  description?:  string
  category?:     string
  photographer?: string
  date?:         string
  featured?:     boolean
  displayOrder?: number
  aspect?:       string
  // Future-proof optional fields — never rendered unless present.
  alt?:          string
  copyright?:    string
  license?:      string
  location?:     string
  tags?:         string[]
  featuredOrder?: number
}

// ─── FAQ ─────────────────────────────────────────────────────────────────────────
// Template-agnostic Q&A read by the shared FAQShowcase. Only id/question/answer/
// enabled are required; everything else renders only when present.
export interface FaqItem {
  id:           string
  question:     string
  answer:       string
  enabled:      boolean
  category?:    string
  displayOrder?:number
  featured?:    boolean
  attachments?: { label?: string; url: string }[]
  links?:       { label?: string; url: string }[]
  // Future-proof optional fields — never rendered unless present.
  icon?:        string
  priority?:    number
  audience?:    string
  updatedAt?:   string
  relatedFaqs?: string[]
}

export interface EventDetailsDraft {
  info:          EventInfo
  media:         MediaConfig
  venue:         VenueConfig
  schedule:      EventSchedule
  organizer:     OrganizerInfo
  sponsors:      Sponsor[]
  communication: CommunicationConfig
  support:       SupportConfig
  seo:           SeoConfig
  publicPage:    PublicPageSettings
  integrations:  IntegrationsConfig
  applications:  ApplicationsConfig
  typeDetails:   TypeDetails
  experience?:   ExperienceItem[]
  timeline?:     TimelineItem[]
  gallery?:      GalleryItem[]
  faq?:          FaqItem[]
}

// ─── ID generators ────────────────────────────────────────────────────────────

export const makeSessionId      = (): string => 'ses_' + Math.random().toString(36).slice(2, 10)
export const makeSpeakerId      = (): string => 'spk_' + Math.random().toString(36).slice(2, 10)
export const makeSponsorId      = (): string => 'spo_' + Math.random().toString(36).slice(2, 10)
export const makeTrackId        = (): string => 'trk_' + Math.random().toString(36).slice(2, 10)
export const makeReminderId     = (): string => 'rem_' + Math.random().toString(36).slice(2, 10)
export const makeAwardCatId     = (): string => 'awc_' + Math.random().toString(36).slice(2, 10)
export const makePastWinnerId   = (): string => 'pw_'  + Math.random().toString(36).slice(2, 10)
export const makeExhibitorId    = (): string => 'exh_' + Math.random().toString(36).slice(2, 10)
export const makeHighlightId    = (): string => 'hl_'  + Math.random().toString(36).slice(2, 10)
export const makeZoneId         = (): string => 'zn_'  + Math.random().toString(36).slice(2, 10)
export const makeExhibitionCatId= (): string => 'exc_' + Math.random().toString(36).slice(2, 10)

// ─── UI label maps ────────────────────────────────────────────────────────────

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  keynote:    'Keynote',
  panel:      'Panel',
  workshop:   'Workshop',
  networking: 'Networking',
  break:      'Break',
  session:    'Session',
  custom:     'Custom',
}

export const SPONSOR_TIER_LABELS: Record<SponsorTier, string> = {
  title:   'Title Sponsor',
  gold:    'Gold',
  silver:  'Silver',
  bronze:  'Bronze',
  partner: 'Partner',
  media:   'Media Partner',
}

export const ONLINE_PLATFORM_LABELS: Record<OnlinePlatform, string> = {
  zoom:         'Zoom',
  google_meet:  'Google Meet',
  ms_teams:     'Microsoft Teams',
  webex:        'Webex',
  youtube_live: 'YouTube Live',
  custom:       'Custom Platform',
}

export const LANGUAGE_OPTIONS = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'Hindi' },
  { id: 'ta', label: 'Tamil' },
  { id: 'te', label: 'Telugu' },
  { id: 'kn', label: 'Kannada' },
  { id: 'mr', label: 'Marathi' },
  { id: 'bn', label: 'Bengali' },
  { id: 'gu', label: 'Gujarati' },
  { id: 'ml', label: 'Malayalam' },
  { id: 'pa', label: 'Punjabi' },
  { id: 'other', label: 'Other' },
]

export const TIMEZONE_OPTIONS = [
  { id: 'Asia/Kolkata',      label: 'IST — India Standard Time (UTC+5:30)' },
  { id: 'Asia/Colombo',      label: 'SLST — Sri Lanka (UTC+5:30)' },
  { id: 'Asia/Dhaka',        label: 'BST — Bangladesh (UTC+6)' },
  { id: 'Asia/Karachi',      label: 'PKT — Pakistan (UTC+5)' },
  { id: 'Asia/Dubai',        label: 'GST — Gulf Standard Time (UTC+4)' },
  { id: 'Asia/Singapore',    label: 'SGT — Singapore (UTC+8)' },
  { id: 'Asia/Kuala_Lumpur', label: 'MYT — Malaysia (UTC+8)' },
  { id: 'Asia/Bangkok',      label: 'ICT — Indochina (UTC+7)' },
  { id: 'Asia/Tokyo',        label: 'JST — Japan (UTC+9)' },
  { id: 'Asia/Shanghai',     label: 'CST — China (UTC+8)' },
  { id: 'Europe/London',     label: 'GMT/BST — London (UTC+0/+1)' },
  { id: 'Europe/Paris',      label: 'CET/CEST — Central Europe (UTC+1/+2)' },
  { id: 'America/New_York',  label: 'ET — Eastern US (UTC-5/-4)' },
  { id: 'America/Chicago',   label: 'CT — Central US (UTC-6/-5)' },
  { id: 'America/Los_Angeles','label': 'PT — Pacific US (UTC-8/-7)' },
  { id: 'Australia/Sydney',  label: 'AEST — Sydney (UTC+10/+11)' },
  { id: 'UTC',               label: 'UTC — Coordinated Universal Time' },
]

// ─── Blank factories ──────────────────────────────────────────────────────────

export function makeBlankSpeaker(): Speaker {
  return {
    id: makeSpeakerId(), name: '', title: '', company: '', bio: '',
    photoUrl: '', social: { linkedin: '', twitter: '' },
    sourceType: 'new', order: 0,
  }
}

export function makeBlankSponsor(): Sponsor {
  return {
    id: makeSponsorId(), name: '', logoUrl: '', website: '',
    tier: 'gold', sourceType: 'new', order: 0,
  }
}

export function makeBlankSession(date: string, order: number): AgendaSession {
  return {
    id: makeSessionId(), date, startTime: '09:00', endTime: '10:00',
    title: '', description: '', type: 'session', speakerIds: [],
    location: '', track: '', isBreak: false, order,
  }
}

function makeReminder(timing: ReminderTiming, channels: CommChannel[] = ['email']): ReminderRule {
  return { id: makeReminderId(), enabled: true, timing, channels }
}

export function makeBlankEventDetailsDraft(): EventDetailsDraft {
  return {
    info: { name: '', tagline: '', shortDesc: '', fullDesc: '', language: 'en', dressCode: '' },
    media: {
      logo:            { source: 'url', value: '' },
      coverBanner:     { source: 'url', value: '' },
      bannerPositionX: 0,
      bannerPositionY: 0,
      bannerScale:     1,
      galleryImages:   [],
      promoVideoUrl:   '',
    },
    venue: {
      type: 'physical',
      physical: {
        name: '', addressLine1: '', addressLine2: '', city: '',
        state: '', country: 'India', pincode: '', mapsLink: '',
        instructions: '', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' },
      },
      online: {
        platform: 'zoom', platformCustomName: '', meetingUrl: '',
        meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '',
      },
    },
    schedule: {
      timezone: 'Asia/Kolkata', startDate: '', startTime: '09:00',
      endDate: '', endTime: '18:00', doorsOpenTime: '',
      agenda: [],
    },
    organizer: {
      name: '', email: '', phone: '', website: '', logoUrl: '',
      social: { facebook: '', instagram: '', linkedin: '', youtube: '', twitter: '', hashtags: [] },
    },
    sponsors: [],
    communication: {
      confirmation: { channels: ['email'], calendarInvite: true, generateQrTicket: true },
      reminders: [
        makeReminder('7d'),
        makeReminder('3d', ['email', 'whatsapp']),
        makeReminder('1d', ['email', 'whatsapp']),
        makeReminder('2h', ['whatsapp']),
      ],
    },
    support: {
      supportEmail: '', supportPhone: '', faqUrl: '',
      termsUrl: '', refundPolicyUrl: '', privacyPolicyUrl: '',
      refundWindow: {
        fullRefundDaysBefore: null, partialRefundDaysBefore: null,
        partialRefundPercent: 50, noRefundDaysBefore: null, useExternalPolicyUrl: true,
      },
    },
    seo: {
      urlSlug: '', metaTitle: '', metaDescription: '', shareImageUrl: '',
      keywords: [], utmSource: '', utmMedium: '', utmCampaign: '',
    },
    publicPage: {
      showOrganizerInfo: true, showSpeakers: true, showSponsors: true,
      showVenueMap: true, showAgenda: true, showGallery: true,
      showSocialLinks: true, showAttendeeCount: false,
    },
    integrations: { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    applications: {
      speaker: { enabled: false, closingDate: '', message: '' },
      sponsor: { enabled: false, closingDate: '', message: '' },
    },
    typeDetails: null,
  }
}

// ─── Runtime normalizer ───────────────────────────────────────────────────────
// Firestore can return partial documents (schema drift, partial saves, old drafts).
// This helper deep-merges any unknown input with blank defaults so every nested
// object is guaranteed to exist before downstream code accesses it.

function safeObj<T extends object>(base: T, override: unknown): T {
  if (override == null || typeof override !== 'object') return base
  return { ...base, ...(override as Partial<T>) } as T
}

/**
 * Returns a fully-populated `EventDetailsDraft` by deep-merging `raw` (which
 * may be null, partial, or from an older schema) with `makeBlankEventDetailsDraft()`
 * defaults.  Every nested sub-object (`info`, `venue.physical`, `organizer.social`,
 * `communication.confirmation`, etc.) is individually normalized so that callers
 * can safely access `d.info.name`, `d.venue.type`, etc. without null checks.
 */
export function normalizeEventDetailsDraft(raw: unknown): EventDetailsDraft {
  const b = makeBlankEventDetailsDraft()
  if (raw == null || typeof raw !== 'object') return b

  const p = raw as Partial<EventDetailsDraft>

  return {
    info:     safeObj(b.info,     p.info),
    media: {
      ...safeObj(b.media, p.media),
      logo:        safeObj(b.media.logo,        p.media?.logo),
      coverBanner: safeObj(b.media.coverBanner, p.media?.coverBanner),
    } as MediaConfig,
    venue: {
      ...safeObj(b.venue, p.venue),
      physical: safeObj(b.venue.physical, p.venue?.physical),
      online:   safeObj(b.venue.online,   p.venue?.online),
    } as VenueConfig,
    schedule:  safeObj(b.schedule,  p.schedule),
    organizer: {
      ...safeObj(b.organizer, p.organizer),
      social: safeObj(b.organizer.social, p.organizer?.social),
    } as OrganizerInfo,
    sponsors: Array.isArray(p.sponsors) ? p.sponsors : b.sponsors,
    communication: {
      ...safeObj(b.communication, p.communication),
      confirmation: safeObj(b.communication.confirmation, p.communication?.confirmation),
    } as CommunicationConfig,
    support: {
      ...safeObj(b.support, p.support),
      refundWindow: safeObj(b.support.refundWindow, p.support?.refundWindow),
    } as SupportConfig,
    seo:          safeObj(b.seo,          p.seo),
    publicPage:   safeObj(b.publicPage,   p.publicPage),
    integrations: safeObj(b.integrations, p.integrations),
    applications: {
      speaker: safeObj(b.applications.speaker, p.applications?.speaker),
      sponsor: safeObj(b.applications.sponsor, p.applications?.sponsor),
    } as ApplicationsConfig,
    typeDetails:  p.typeDetails !== undefined ? p.typeDetails : null,
  }
}

// ─── Dynamic Tab 6 config ─────────────────────────────────────────────────────

export type DynamicSectionType =
  | 'conference' | 'sports_running' | 'sports_cycling'
  | 'sports_team' | 'sports_generic' | 'workshop'
  | 'meetup_founder' | 'meetup_corporate' | 'meetup_alumni'
  | 'cultural' | 'awards' | 'fundraising' | 'exhibition' | 'community'

export interface Tab6Config {
  tabTitle:    string
  sectionType: DynamicSectionType
}

const TEAM_SPORT_SUBTYPES = new Set([
  'hockey', 'basketball', 'volleyball', 'football', 'soccer',
  'cricket', 'tennis', 'badminton',
])

export function getTab6Config(
  eventType?: string | null,
  eventSubtype?: string | null,
): Tab6Config | null {
  if (!eventType || eventType === 'custom') return null
  switch (eventType) {
    case 'conference':
      return { tabTitle: 'Conference Details', sectionType: 'conference' }
    case 'exhibition':
      return { tabTitle: 'Expo Details', sectionType: 'exhibition' }
    case 'sports': {
      const sub = eventSubtype ?? ''
      if (['running', 'marathon', 'run'].includes(sub))
        return { tabTitle: 'Running Details', sectionType: 'sports_running' }
      if (sub === 'cycling')
        return { tabTitle: 'Cycling Details', sectionType: 'sports_cycling' }
      if (TEAM_SPORT_SUBTYPES.has(sub))
        return { tabTitle: 'Match Details', sectionType: 'sports_team' }
      return { tabTitle: 'Sports Details', sectionType: 'sports_generic' }
    }
    case 'workshop':
      return { tabTitle: 'Workshop Details', sectionType: 'workshop' }
    case 'meetup':
      if (eventSubtype === 'founder')   return { tabTitle: 'Founder Details',   sectionType: 'meetup_founder'   }
      if (eventSubtype === 'corporate') return { tabTitle: 'Corporate Details',  sectionType: 'meetup_corporate' }
      if (eventSubtype === 'alumni')    return { tabTitle: 'Alumni Details',     sectionType: 'meetup_alumni'    }
      return null
    case 'community':   return { tabTitle: 'Community Details',   sectionType: 'community'   }
    case 'cultural':    return { tabTitle: 'Event Details',       sectionType: 'cultural'    }
    case 'awards':      return { tabTitle: 'Awards Details',      sectionType: 'awards'      }
    case 'fundraising': return { tabTitle: 'Fundraising Details', sectionType: 'fundraising' }
    default:            return null
  }
}

export function makeBlankTypeDetails(sectionType: DynamicSectionType): TypeDetails {
  switch (sectionType) {
    case 'conference':
      return { speakers: [], sponsors: [], tracks: [], hallLayout: '' }
    case 'sports_running':
      return {
        routeMapUrl: '', reportingTime: '', kitCollectionInfo: '', kitCollectionDate: '',
        bagDepositInfo: '', medicalSupportInfo: '', hydrationPoints: '', startLineInfo: '', rulesUrl: '',
        requireWaiver: false, waiverText: '', raceCategories: [],
      }
    case 'sports_cycling':
    case 'sports_team':
    case 'sports_generic':
      return { groundInfo: '', matchFormat: '', teamSize: null, matchDuration: '', rulesUrl: '', requireWaiver: false, waiverText: '' }
    case 'workshop':
      return { trainers: [], prerequisites: '', learningOutcomes: [], materialsIncluded: '', softwareRequired: '', batchSize: null, hasCertificate: false }
    case 'meetup_founder':
      return { startupShowcaseEnabled: false, pitchSessionEnabled: false, pitchFormat: '', investorConnectEnabled: false }
    case 'meetup_corporate':
      return { guestSpeakers: [], networkingAgenda: '' }
    case 'meetup_alumni':
      return { institution: '', batchYears: '', reunionActivities: '' }
    case 'cultural':
      return { artists: [], programSchedule: '', entryRules: '', ageRestriction: '', highlights: [], experienceZones: [] }
    case 'awards':
      return { categories: [], nominationRules: '', judgingProcess: '', ceremonyFormat: '', judges: [], pastWinners: [] }
    case 'fundraising':
      return { beneficiaryInfo: '', fundUsage: '', donationGoal: null, ngoPartner: '', taxExemptionInfo: '' }
    case 'exhibition':
      return { boothInfoUrl: '', floorPlanUrl: '', visitorInstructions: '', parkingInfo: '', exhibitors: [], exhibitionCategories: [] }
    case 'community':
      return { causeInfo: '', volunteerInstructions: '', campaignInfo: '', impactGoal: '' }
  }
}

// ─── URL slug utility ─────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

// ─── Step health calculation ──────────────────────────────────────────────────

export interface StepHealth {
  score:    number      // 0–100
  blockers: string[]
  warnings: string[]
}

/**
 * RD-WIZARD-HEALTH — one Details finding, anchored to the field it is about.
 *
 * `field` is the DOM id of the input (see DETAILS_FIELD_TAB) so Step Health can open the right
 * tab, scroll to the field and show this message next to it. `message` is the exact string
 * calcStepHealth has always returned, so nothing an organizer reads changes.
 */
export interface DetailsHealthItem {
  field:    string
  label:    string
  message:  string
  severity: 'blocker' | 'warning'
}

/** Which Details tab each anchored field lives on (the builder opens it before focusing). */
export const DETAILS_FIELD_TAB: Readonly<Record<string, 'details' | 'venue' | 'organizer' | 'comms' | 'seo' | 'type'>> = {
  'rd-event-name':            'details',
  'rd-short-desc':            'details',
  'rd-event-description':     'details',
  'rd-cover-banner':          'details',
  'rd-venue-type':            'venue',
  'rd-venue-name':            'venue',
  'rd-meeting-url':           'venue',
  'rd-start-date':            'venue',
  'rd-start-time':            'venue',
  'rd-end-date':              'venue',
  'rd-end-time':              'venue',
  'rd-organizer-name':        'organizer',
  'rd-organizer-email':       'organizer',
  'rd-organizer-phone':       'organizer',
  'rd-support-email':         'organizer',
  'rd-confirmation-channels': 'comms',
  'rd-event-slug':            'seo',
  'rd-meta-description':      'seo',
  'rd-waiver-text':           'type',
}

/**
 * The Details step's findings, each anchored to its field. THE rule set behind calcStepHealth
 * (which is derived from this, unchanged) — RD-CE-FIX M7: a blocker here BLOCKS the step's
 * Continue, so the list is exactly what the server refuses at publish (publishRequirements
 * criticals + lib/events/eventValueRules); everything the server accepts is a warning.
 */
export function detailsHealthItems(input: EventDetailsDraft): DetailsHealthItem[] {
  // Normalize at the entry point: guarantees every nested sub-object
  // (info, venue, organizer, seo, …) is populated even when Firestore
  // returned a partial document or an old-schema draft.
  const d = normalizeEventDetailsDraft(input)
  const out: DetailsHealthItem[] = []
  const block = (field: string, label: string, message: string) => out.push({ field, label, message, severity: 'blocker' })
  const warn  = (field: string, label: string, message: string) => out.push({ field, label, message, severity: 'warning' })

  // ── Blockers (required) ──
  if (!(d.info.name.trim().length > 0)) block('rd-event-name', 'Event name', 'Event name is required')

  if (d.schedule.startDate) {
    if (!d.schedule.startTime) warn('rd-start-time', 'Start time', 'Add a start time so attendees know when to arrive')
  } else {
    block('rd-start-date', 'Start date', 'Event start date is required')
  }

  if (d.schedule.endDate) {
    if (d.schedule.startDate) {
      const start = new Date(`${d.schedule.startDate}T${d.schedule.startTime || '00:00'}`)
      const end   = new Date(`${d.schedule.endDate}T${d.schedule.endTime || '23:59'}`)
      if (end < start) block('rd-end-date', 'End date', 'Event end must be after event start')
    }
    if (!d.schedule.endTime) warn('rd-end-time', 'End time', 'Add an end time')
  } else {
    warn('rd-end-date', 'End date', 'Add an end date and time')
  }

  const vt = d.venue.type
  if (vt === 'physical' || vt === 'hybrid') {
    if (!d.venue.physical.name.trim()) block('rd-venue-name', 'Venue name', 'Venue name is required for physical events')
  }
  if (vt === 'online' || vt === 'hybrid') {
    const url = d.venue.online.meetingUrl.trim()
    if (!url) warn('rd-meeting-url', 'Meeting link', 'Add the meeting link before the event starts')
    else if (!/^https?:\/\/\S+$/i.test(url)) block('rd-meeting-url', 'Meeting link', 'The meeting link must start with http:// or https://')
  }

  if (!d.organizer.name.trim())  block('rd-organizer-name', 'Organizer name', 'Organizer name is required')
  if (!d.organizer.email.trim()) block('rd-organizer-email', 'Organizer email', 'Organizer email is required')

  // The public URL is generated (and normalised) at publish, so a missing or unusual slug is a warning.
  if (!(d.seo.urlSlug.trim() && /^[a-z0-9-]+$/.test(d.seo.urlSlug.trim()))) {
    warn('rd-event-slug', 'URL slug', 'Set a URL slug (lowercase letters, numbers, hyphens) — otherwise one is generated')
  }

  // ── Warnings (recommended) ──
  if (!d.info.shortDesc.trim())              warn('rd-short-desc', 'Short description', 'Short description improves search visibility')
  if (!d.media.coverBanner.value.trim())     warn('rd-cover-banner', 'Cover banner', 'Cover banner makes your event page stand out')
  if (!((d.communication.confirmation.channels?.length ?? 0) > 0)) {
    warn('rd-confirmation-channels', 'Confirmation channel', "No confirmation channel configured — attendees won't be notified")
  }
  if (!d.support.supportEmail.trim())        warn('rd-support-email', 'Support email', 'Support email helps attendees reach you')
  if (!d.seo.metaDescription.trim())         warn('rd-meta-description', 'Meta description', 'Meta description improves click-through from search')

  return out
}

export function calcStepHealth(input: EventDetailsDraft): StepHealth {
  const d = normalizeEventDetailsDraft(input)
  const items = detailsHealthItems(d)
  const has = (field: string, severity: 'blocker' | 'warning') => items.some(i => i.field === field && i.severity === severity)
  let score = 0

  if (d.info.name.trim().length > 0) score += 10
  if (d.schedule.startDate) score += 8
  if (d.schedule.endDate) score += 4
  if (!has('rd-venue-name', 'blocker') && !items.some(i => i.field === 'rd-meeting-url')) score += 12
  if (d.organizer.name.trim()) score += 6
  if (d.organizer.email.trim()) score += 6
  if (d.seo.urlSlug.trim() && /^[a-z0-9-]+$/.test(d.seo.urlSlug.trim())) score += 8
  if (d.info.shortDesc.trim()) score += 8
  if (d.media.coverBanner.value.trim()) score += 10
  if ((d.communication.confirmation.channels?.length ?? 0) > 0) score += 8
  if (d.seo.metaDescription.trim()) score += 4

  // ── Bonus ──
  if (d.info.fullDesc.trim())             score += 4
  if (d.media.logo.value.trim())           score += 2
  if (d.organizer.social.instagram.trim()
   || d.organizer.social.linkedin.trim())  score += 2

  return {
    score:    Math.min(100, Math.max(0, score)),
    blockers: items.filter(i => i.severity === 'blocker').map(i => i.message),
    warnings: items.filter(i => i.severity === 'warning').map(i => i.message),
  }
}

// ─── Event date utilities ─────────────────────────────────────────────────────

/** Returns an array of ISO date strings for every day from startDate to endDate inclusive. */
export function getEventDays(startDate: string, endDate: string): string[] {
  if (!startDate || !endDate) return startDate ? [startDate] : []
  const days: string[] = []
  const cur = new Date(startDate)
  const end = new Date(endDate)
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0])
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

/** Formats an ISO date string to a human-readable label like "Day 1 — Mon 14 Jun 2026". */
export function formatDayLabel(isoDate: string, dayIndex: number): string {
  if (!isoDate) return `Day ${dayIndex + 1}`
  try {
    const d = new Date(isoDate)
    const dow = d.toLocaleDateString('en-US', { weekday: 'short' })
    const day = d.getDate()
    const mon = d.toLocaleDateString('en-US', { month: 'short' })
    const yr  = d.getFullYear()
    return `Day ${dayIndex + 1} — ${dow} ${day} ${mon} ${yr}`
  } catch {
    return `Day ${dayIndex + 1}`
  }
}

/** Formats HH:MM to 12-hour display like "9:00 AM". */
export function fmtTime(t: string): string {
  if (!t) return ''
  const [hh, mm] = t.split(':').map(Number)
  const suffix = hh! >= 12 ? 'PM' : 'AM'
  const h      = hh! % 12 || 12
  return `${h}:${String(mm).padStart(2, '0')} ${suffix}`
}
