// Config-driven data model, factories, dynamic section config, and health calculation
// for Step 6: Event Details & Communication.

// ─── Union types ──────────────────────────────────────────────────────────────

export type EventStatus =
  | 'draft' | 'published' | 'private' | 'postponed'
  | 'cancelled' | 'sold_out' | 'archived'

export type VenueType        = 'physical' | 'online' | 'hybrid'
export type OnlinePlatform   = 'zoom' | 'google_meet' | 'ms_teams' | 'webex' | 'youtube_live' | 'custom'
export type CommChannel      = 'email' | 'whatsapp' | 'sms'
export type SessionType      = 'keynote' | 'panel' | 'workshop' | 'networking' | 'break' | 'session' | 'custom'
export type SponsorTier      = 'title' | 'gold' | 'silver' | 'bronze' | 'partner' | 'media'
export type RecordSourceType = 'new' | 'existing_library' | 'imported_event'
export type ReminderTiming   = '7d' | '3d' | '1d' | '2h' | 'custom'
export type EventPageTheme   = 'default' | 'professional' | 'modern' | 'minimal' | 'vibrant'
export type MediaSource      = 'upload' | 'url'

export interface MediaAsset {
  source:            MediaSource
  value:             string   // data URL (upload) or external URL (url)
  originalFileName?: string
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface StatusConfig {
  status:                          EventStatus
  postponedDate:                   string
  postponedMessage:                string
  cancellationMessage:             string
  notifyRegistrantsOnStatusChange: boolean
}

export interface EventInfo {
  name:      string
  tagline:   string
  shortDesc: string
  fullDesc:  string
  language:  string
  dressCode: string
}

export interface MediaConfig {
  logo:          MediaAsset
  coverBanner:   MediaAsset
  primaryColor:  string
  theme:         EventPageTheme
  galleryImages: MediaAsset[]
  promoVideoUrl: string
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
}

export interface MessageTemplate {
  subject:  string
  body:     string
  isCustom: boolean
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
  templates: {
    confirmationEmail:    MessageTemplate
    confirmationWhatsApp: MessageTemplate
    confirmationSms:      MessageTemplate
    reminderEmail:        MessageTemplate
    reminderWhatsApp:     MessageTemplate
  }
  certificate: {
    enabled:  boolean
    template: 'default' | 'custom'
  }
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
}

export interface ConferenceTrack {
  id:    string
  name:  string
  color: string
}

export interface ConferenceDetails {
  speakers:  Speaker[]
  sponsors:  Sponsor[]
  tracks:    ConferenceTrack[]
  hallLayout:string
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
}

export interface WorkshopDetails {
  trainers:          Speaker[]
  prerequisites:     string
  learningOutcomes:  string[]
  materialsIncluded: string
  softwareRequired:  string
  batchSize:         number | null
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

export interface CulturalDetails {
  artists:         Speaker[]
  programSchedule: string
  entryRules:      string
  ageRestriction:  string
}

export interface AwardsDetails {
  categories:      { id: string; name: string; description: string }[]
  nominationRules: string
  judgingProcess:  string
  ceremonyFormat:  string
}

export interface FundraisingDetails {
  beneficiaryInfo:  string
  fundUsage:        string
  donationGoal:     number | null
  ngoPartner:       string
  taxExemptionInfo: string
}

export interface ExhibitionDetails {
  boothInfoUrl:        string
  floorPlanUrl:        string
  visitorInstructions: string
  parkingInfo:         string
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

export interface EventDetailsDraft {
  status:        StatusConfig
  info:          EventInfo
  media:         MediaConfig
  venue:         VenueConfig
  schedule:      EventSchedule
  organizer:     OrganizerInfo
  communication: CommunicationConfig
  support:       SupportConfig
  seo:           SeoConfig
  publicPage:    PublicPageSettings
  integrations:  IntegrationsConfig
  typeDetails:   TypeDetails
}

// ─── ID generators ────────────────────────────────────────────────────────────

export const makeSessionId  = (): string => 'ses_' + Math.random().toString(36).slice(2, 10)
export const makeSpeakerId  = (): string => 'spk_' + Math.random().toString(36).slice(2, 10)
export const makeSponsorId  = (): string => 'spo_' + Math.random().toString(36).slice(2, 10)
export const makeTrackId    = (): string => 'trk_' + Math.random().toString(36).slice(2, 10)
export const makeReminderId = (): string => 'rem_' + Math.random().toString(36).slice(2, 10)
export const makeAwardCatId = (): string => 'awc_' + Math.random().toString(36).slice(2, 10)

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

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft:     'Draft',
  published: 'Published',
  private:   'Private',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
  sold_out:  'Sold Out',
  archived:  'Archived',
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

const BLANK_TEMPLATE: MessageTemplate = { subject: '', body: '', isCustom: false }

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
    status: {
      status: 'draft',
      postponedDate: '', postponedMessage: '', cancellationMessage: '',
      notifyRegistrantsOnStatusChange: true,
    },
    info: { name: '', tagline: '', shortDesc: '', fullDesc: '', language: 'en', dressCode: '' },
    media: {
      logo:          { source: 'url', value: '' },
      coverBanner:   { source: 'url', value: '' },
      primaryColor:  '#6366f1',
      theme:         'default',
      galleryImages: [],
      promoVideoUrl: '',
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
    communication: {
      confirmation: { channels: ['email'], calendarInvite: true, generateQrTicket: true },
      reminders: [
        makeReminder('7d'),
        makeReminder('3d', ['email', 'whatsapp']),
        makeReminder('1d', ['email', 'whatsapp']),
        makeReminder('2h', ['whatsapp']),
      ],
      templates: {
        confirmationEmail:    BLANK_TEMPLATE,
        confirmationWhatsApp: BLANK_TEMPLATE,
        confirmationSms:      BLANK_TEMPLATE,
        reminderEmail:        BLANK_TEMPLATE,
        reminderWhatsApp:     BLANK_TEMPLATE,
      },
      certificate: { enabled: false, template: 'default' },
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
    status:   safeObj(b.status,   p.status),
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
    communication: {
      ...safeObj(b.communication, p.communication),
      confirmation: safeObj(b.communication.confirmation, p.communication?.confirmation),
      templates:    safeObj(b.communication.templates,    p.communication?.templates),
    } as CommunicationConfig,
    support: {
      ...safeObj(b.support, p.support),
      refundWindow: safeObj(b.support.refundWindow, p.support?.refundWindow),
    } as SupportConfig,
    seo:          safeObj(b.seo,          p.seo),
    publicPage:   safeObj(b.publicPage,   p.publicPage),
    integrations: safeObj(b.integrations, p.integrations),
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
      }
    case 'sports_cycling':
    case 'sports_team':
    case 'sports_generic':
      return { groundInfo: '', matchFormat: '', teamSize: null, matchDuration: '', rulesUrl: '' }
    case 'workshop':
      return { trainers: [], prerequisites: '', learningOutcomes: [], materialsIncluded: '', softwareRequired: '', batchSize: null }
    case 'meetup_founder':
      return { startupShowcaseEnabled: false, pitchSessionEnabled: false, pitchFormat: '', investorConnectEnabled: false }
    case 'meetup_corporate':
      return { guestSpeakers: [], networkingAgenda: '' }
    case 'meetup_alumni':
      return { institution: '', batchYears: '', reunionActivities: '' }
    case 'cultural':
      return { artists: [], programSchedule: '', entryRules: '', ageRestriction: '' }
    case 'awards':
      return { categories: [], nominationRules: '', judgingProcess: '', ceremonyFormat: '' }
    case 'fundraising':
      return { beneficiaryInfo: '', fundUsage: '', donationGoal: null, ngoPartner: '', taxExemptionInfo: '' }
    case 'exhibition':
      return { boothInfoUrl: '', floorPlanUrl: '', visitorInstructions: '', parkingInfo: '' }
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

export function calcStepHealth(input: EventDetailsDraft): StepHealth {
  // Normalize at the entry point: guarantees every nested sub-object
  // (info, venue, organizer, seo, …) is populated even when Firestore
  // returned a partial document or an old-schema draft.
  const d = normalizeEventDetailsDraft(input)

  const blockers: string[] = []
  const warnings: string[] = []
  let score = 0

  // ── Blockers (required) ──
  if (d.info.name.trim().length >= 3) {
    score += 10
  } else {
    blockers.push('Event name is required (min 3 characters)')
  }

  if (d.schedule.startDate && d.schedule.startTime) {
    score += 8
  } else {
    blockers.push('Event start date and time are required')
  }

  if (d.schedule.endDate && d.schedule.endTime) {
    score += 4
    if (d.schedule.startDate && d.schedule.endDate) {
      const start = new Date(`${d.schedule.startDate}T${d.schedule.startTime || '00:00'}`)
      const end   = new Date(`${d.schedule.endDate}T${d.schedule.endTime || '00:00'}`)
      if (end <= start) blockers.push('Event end must be after event start')
    }
  } else {
    blockers.push('Event end date and time are required')
  }

  const vt = d.venue.type
  let venueOk = true
  if (vt === 'physical' || vt === 'hybrid') {
    if (!d.venue.physical.name.trim()) { blockers.push('Venue name is required for physical events'); venueOk = false }
  }
  if (vt === 'online' || vt === 'hybrid') {
    if (!d.venue.online.meetingUrl.trim()) { blockers.push('Meeting URL is required for online events'); venueOk = false }
  }
  if (venueOk) score += 12

  if (d.organizer.name.trim()) score += 6
  else blockers.push('Organizer name is required')

  if (d.organizer.email.trim()) score += 6
  else blockers.push('Organizer email is required')

  if (d.seo.urlSlug.trim() && /^[a-z0-9-]+$/.test(d.seo.urlSlug.trim())) {
    score += 8
  } else {
    blockers.push('A valid URL slug is required (lowercase letters, numbers, hyphens)')
  }

  // ── Warnings (recommended) ──
  if (d.info.shortDesc.trim()) {
    score += 8
  } else {
    warnings.push('Short description improves search visibility')
  }

  if (d.media.coverBanner.value.trim()) {
    score += 10
  } else {
    warnings.push('Cover banner makes your event page stand out')
  }

  if ((d.communication.confirmation.channels?.length ?? 0) > 0) {
    score += 8
  } else {
    warnings.push("No confirmation channel configured — attendees won't be notified")
  }

  if (!d.support.supportEmail.trim()) {
    warnings.push('Support email helps attendees reach you')
  }

  if (d.seo.metaDescription.trim()) score += 4
  else warnings.push('Meta description improves click-through from search')

  // ── Bonus ──
  if (d.info.fullDesc.trim())              score += 4
  if (d.status.status !== 'draft')         score += 4
  if (d.media.logo.value.trim())            score += 2
  if (d.organizer.social.instagram.trim()
   || d.organizer.social.linkedin.trim())  score += 2

  return { score: Math.min(100, Math.max(0, score)), blockers, warnings }
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
