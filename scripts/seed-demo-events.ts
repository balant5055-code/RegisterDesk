#!/usr/bin/env node
/**
 * scripts/seed-demo-events.ts
 *
 * Seeds 10 premium demo events directly into Firestore.
 * Run:  npm run seed:demo
 *
 * Collections written:
 *   events/{slug}
 *   registrationCounters/{slug}
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_KEY in .env.local (base64-encoded service account JSON).
 */

// ── 1. Load .env.local ────────────────────────────────────────────────────────

import fs   from 'node:fs'
import path from 'node:path'

const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const val = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!process.env[key]) process.env[key] = val
  }
}

// ── 2. Firebase Admin ─────────────────────────────────────────────────────────

import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp }       from 'firebase-admin/firestore'

;(function initAdmin() {
  if (getApps().length > 0) return
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!encoded) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT_KEY is not set in .env.local')
    process.exit(1)
  }
  const sa = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
  initializeApp({ credential: cert(sa) })
})()

const db  = getFirestore()
const NOW = Timestamp.now()

// ── 3. Micro-helpers ──────────────────────────────────────────────────────────

let _seq = 0
const uid = (): string => `sd_${(++_seq).toString(36).padStart(4, '0')}_${Math.random().toString(36).slice(2, 7)}`

const img  = (url: string)  => ({ source: 'url', value: url })
const link = (url: string)  => url

const spk = (name: string, title: string, company: string, bio: string, photo: string) => ({
  id: uid(), name, title, company, bio, photoUrl: photo,
  social: { linkedin: '', twitter: '' }, sourceType: 'new', order: 0,
})

const spo = (name: string, logo: string, website: string, tier: string) => ({
  id: uid(), name, logoUrl: logo, website, tier, sourceType: 'new', order: 0,
})

const pass = (
  id:       string,
  name:     string,
  price:    number,
  benefits: string[],
  qty:      number | null = null,
  desc      = '',
) => ({
  id, name, description: desc, price, quantity: qty,
  unlimited: qty === null, status: 'active', visibility: 'public', benefits,
})

const ses = (
  date:   string,
  start:  string,
  end:    string,
  title:  string,
  type:   string,
  desc    = '',
  isBreak = false,
) => ({
  id: uid(), date, startTime: start, endTime: end,
  title, description: desc, type, speakerIds: [],
  location: '', track: '', isBreak, order: 0,
})

function baseOrg(
  name:    string,
  email:   string,
  phone:   string,
  website: string,
  logo:    string,
  social:  Record<string, unknown> = {},
) {
  return {
    name, email, phone, website, logoUrl: logo,
    social: { facebook: '', instagram: '', linkedin: '', youtube: '', twitter: '', hashtags: [], ...social },
  }
}

function basePublicPage(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    showOrganizerInfo: true, showSpeakers: true, showSponsors: true,
    showVenueMap: true, showAgenda: true, showGallery: true,
    showSocialLinks: true, showAttendeeCount: true,
    ...overrides,
  }
}

function baseSupport(email: string, phone: string, faqUrl = '', termsUrl = '') {
  return {
    supportEmail: email, supportPhone: phone, faqUrl, termsUrl,
    refundPolicyUrl: '', privacyPolicyUrl: '',
    refundWindow: {
      fullRefundDaysBefore: 7, partialRefundDaysBefore: null,
      partialRefundPercent: 50, noRefundDaysBefore: 2, useExternalPolicyUrl: false,
    },
  }
}

function baseSeo(slug: string, title: string, desc: string, keywords: string[] = []) {
  return { urlSlug: slug, metaTitle: title, metaDescription: desc, shareImageUrl: '', keywords, utmSource: '', utmMedium: '', utmCampaign: '' }
}

function baseComm() {
  return {
    confirmation: { channels: ['email'], calendarInvite: true, generateQrTicket: true },
    reminders: [
      { id: uid(), enabled: true, timing: '7d', channels: ['email'] },
      { id: uid(), enabled: true, timing: '1d', channels: ['email', 'whatsapp'] },
      { id: uid(), enabled: true, timing: '2h', channels: ['whatsapp'] },
    ],
    templates: {
      confirmationEmail:    { subject: '', body: '', isCustom: false },
      confirmationWhatsApp: { subject: '', body: '', isCustom: false },
      confirmationSms:      { subject: '', body: '', isCustom: false },
      reminderEmail:        { subject: '', body: '', isCustom: false },
      reminderWhatsApp:     { subject: '', body: '', isCustom: false },
    },
    certificate: { enabled: false, template: 'default' },
  }
}

function baseForm(template: string, extraFields: Record<string, unknown>[] = []) {
  const core = [
    { id: uid(), label: 'Full Name',     type: 'text',   required: true,  visible: true, placeholder: '', helperText: '', options: [], validation: {}, section: 'basic', conditionalLogic: null, passVisibility: 'all' },
    { id: uid(), label: 'Email Address', type: 'email',  required: true,  visible: true, placeholder: '', helperText: '', options: [], validation: {}, section: 'basic', conditionalLogic: null, passVisibility: 'all' },
    { id: uid(), label: 'Mobile Number', type: 'mobile', required: true,  visible: true, placeholder: '', helperText: '', options: [], validation: {}, section: 'basic', conditionalLogic: null, passVisibility: 'all' },
    ...extraFields,
  ]
  return {
    template,
    sections: [{ id: uid(), title: 'Registration Details', description: '', order: 0, fields: core }],
    fields: core,
    settings: { allowGuestRegistration: false, requireApproval: false, requireLogin: false, allowFileUpload: false, oneRegistrationPerEmail: true, oneRegistrationPerMobile: false },
    registrationRules: {
      registrationMode: 'individual', limitPerEmail: true, limitPerMobile: false, maxRegistrations: null, duplicatePolicy: 'block', approvalMode: 'auto', approvalMessage: '', pendingMessage: '',
      waitlistEnabled: false, waitlistMode: 'auto', waitlistCapacity: null, requireLogin: false, allowGuestRegistration: false, requireEmailVerification: false, requireMobileVerification: false,
      allowFileUpload: false, teamSettings: { minTeamSize: null, maxTeamSize: null, captainRequired: false, teamNameRequired: true },
      afterRegistration: 'success_page', redirectUrl: '', successMessage: '', confirmationMessage: '',
    },
    conditionalRules: [],
  }
}

function publishedEventDoc(
  slug:        string,
  eventType:   string,
  eventSubtype:string,
  isFree:      boolean,
  passes:      Record<string, unknown>[],
  eventDetails:Record<string, unknown>,
  regCount:    number,
) {
  return {
    slug,
    uid:         'seed_demo_organizer_001',
    draftId:     `seed_draft_${slug}`,
    eventType,
    eventSubtype,
    visibility:  'public',
    pricing: {
      eventType: isFree ? 'free' : 'paid',
      passes,
      registrationOpenDate: '',
      registrationEndDate:  '',
    },
    eventDetails,
    planType:      isFree ? 'free_event'  : 'paid_event',
    capacityPlan:  isFree ? 'pack_1000'   : 'unlimited',
    totalCapacity: isFree ? 1000          : null,
    registrationForm: eventDetails.registrationForm ?? null,
    accessControl:    null,
    lifecycleStatus:  'published',
    publishedAt:      NOW,
    updatedAt:        NOW,
  }
}

// ── 4. Event data ─────────────────────────────────────────────────────────────

interface SeedEvent {
  slug:          string
  doc:           Record<string, unknown>
  registrations: number
  passCounts:    Record<string, number>
}

function buildEvents(): SeedEvent[] {

  // ── Photos ────────────────────────────────────────────────────────────────

  // Unsplash CDN — stable photo IDs, no API key needed for direct URLs
  const CONF_BANNER    = 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=1400&q=85&auto=format&fit=crop'
  const MARA_BANNER    = 'https://images.unsplash.com/photo-1542626991-cbc4e32524cc?w=1400&q=85&auto=format&fit=crop'
  const WORK_BANNER    = 'https://images.unsplash.com/photo-1531482615713-2afd69097998?w=1400&q=85&auto=format&fit=crop'
  const MEET_BANNER    = 'https://images.unsplash.com/photo-1556761175-4b46a572b786?w=1400&q=85&auto=format&fit=crop'
  const COMM_BANNER    = 'https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=1400&q=85&auto=format&fit=crop'
  const NGO_BANNER     = 'https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=1400&q=85&auto=format&fit=crop'
  const CHARITY_BANNER = 'https://images.unsplash.com/photo-1461897104016-0b3b00cc81ee?w=1400&q=85&auto=format&fit=crop'
  const EXPO_BANNER    = 'https://images.unsplash.com/photo-1587825140708-dfaf72ae4b04?w=1400&q=85&auto=format&fit=crop'
  const CULT_BANNER    = 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=1400&q=85&auto=format&fit=crop'
  const AWARD_BANNER   = 'https://images.unsplash.com/photo-1511578314322-379afb476865?w=1400&q=85&auto=format&fit=crop'

  // Speaker / Trainer portraits
  const SPK_1 = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&q=80&auto=format&fit=crop&face'
  const SPK_2 = 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&q=80&auto=format&fit=crop&face'
  const SPK_3 = 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&q=80&auto=format&fit=crop&face'
  const SPK_4 = 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&q=80&auto=format&fit=crop&face'
  const SPK_5 = 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&q=80&auto=format&fit=crop&face'
  const SPK_6 = 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&q=80&auto=format&fit=crop&face'

  // Gallery filler photos
  const CONF_G1 = 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=800&q=80&auto=format&fit=crop'
  const CONF_G2 = 'https://images.unsplash.com/photo-1515187029135-18ee286d815b?w=800&q=80&auto=format&fit=crop'
  const CONF_G3 = 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=800&q=80&auto=format&fit=crop'
  const MARA_G1 = 'https://images.unsplash.com/photo-1452626038306-9aae5e071dd3?w=800&q=80&auto=format&fit=crop'
  const MARA_G2 = 'https://images.unsplash.com/photo-1571008887538-b36bb32f4571?w=800&q=80&auto=format&fit=crop'
  const MARA_G3 = 'https://images.unsplash.com/photo-1486218119243-13301543a6d3?w=800&q=80&auto=format&fit=crop'
  const WORK_G1 = 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=800&q=80&auto=format&fit=crop'
  const WORK_G2 = 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=800&q=80&auto=format&fit=crop'
  const COMM_G1 = 'https://images.unsplash.com/photo-1593113598332-cd288d649433?w=800&q=80&auto=format&fit=crop'
  const COMM_G2 = 'https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=800&q=80&auto=format&fit=crop'
  const EXPO_G1 = 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?w=800&q=80&auto=format&fit=crop'
  const EXPO_G2 = 'https://images.unsplash.com/photo-1464047736614-af63643285bf?w=800&q=80&auto=format&fit=crop'
  const CULT_G1 = 'https://images.unsplash.com/photo-1547153760-18fc86324498?w=800&q=80&auto=format&fit=crop'
  const CULT_G2 = 'https://images.unsplash.com/photo-1510915228340-29c85a43dcfe?w=800&q=80&auto=format&fit=crop'
  const AWARD_G1 = 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?w=800&q=80&auto=format&fit=crop'

  // Sponsor logo placeholders
  const spoLogo = (label: string, color = '4f46e5') =>
    `https://placehold.co/200x80/${color}/ffffff?text=${encodeURIComponent(label)}`

  // Org logo placeholders
  const orgLogo = (label: string) =>
    `https://placehold.co/120x120/1e1b4b/ffffff?text=${encodeURIComponent(label)}`

  // ── EVENT 1: Bengaluru Tech Summit 2026 ────────────────────────────────────

  const P1_DEL  = 'p1_del'
  const P1_WORK = 'p1_wrk'
  const P1_VIP  = 'p1_vip'

  const ev1Passes = [
    pass(P1_DEL,  'Delegate Pass',  2499, ['All Sessions', 'Lunch Included', 'Delegate Kit', 'Networking Lounge', 'Participation Certificate']),
    pass(P1_WORK, 'Workshop Add-on', 4999, ['All Sessions', 'Workshop Access', 'Lunch Included', 'Delegate Kit', 'Speaker Meet & Greet', 'Networking Lounge', 'Participation Certificate']),
    pass(P1_VIP,  'VIP Pass',       9999, ['All Sessions', 'Workshop Access', 'Gala Dinner', 'VIP Lounge', 'Speaker Meet & Greet', 'Front Row Seating', 'Conference Bag'], 50),
  ]

  const ev1Speakers = [
    spk('Arjun Sharma',   'CTO', 'TechCorp India', 'Arjun leads engineering at TechCorp India and is a renowned speaker on distributed systems and cloud-native architecture. He has over 18 years of experience building large-scale platforms.', SPK_1),
    spk('Priya Nair',     'VP of Engineering', 'FinTech Solutions', 'Priya is a pioneering voice in fintech engineering, specialising in payment infrastructure and API design. She has spoken at 30+ global conferences.', SPK_2),
    spk('Rahul Krishnan', 'AI Research Lead', 'DeepThought Labs', 'Rahul\'s research on large language models and responsible AI has been published in NeurIPS and ICML. He champions open-source AI development across India.', SPK_3),
    spk('Meera Joshi',    'Founder & CEO', 'CloudBase Technologies', 'Serial entrepreneur Meera has built and exited three SaaS companies. She now advises startups on DevOps culture and platform engineering.', SPK_4),
  ]

  const ev1Sponsors = [
    spo('Microsoft Azure',     spoLogo('Azure',    '0078d4'), 'https://azure.microsoft.com', 'title'),
    spo('AWS India',           spoLogo('AWS',      'ff9900'), 'https://aws.amazon.com',      'gold'),
    spo('JetBrains',           spoLogo('JetBrains','21D789'), 'https://jetbrains.com',       'silver'),
    spo('The Economic Times',  spoLogo('ET Tech',  'e8522b'), 'https://economictimes.com',   'media'),
  ]

  const ev1Agenda = [
    ses('2026-09-15', '08:30', '09:00', 'Registration & Breakfast', 'networking', 'Collect your badge, pick up your delegate kit, and grab breakfast.', false),
    ses('2026-09-15', '09:00', '09:30', 'Opening Keynote: The Future of Cloud-Native India', 'keynote', 'Arjun Sharma on where Indian engineering is headed in the next five years.'),
    ses('2026-09-15', '09:30', '10:30', 'Panel: Building Resilient APIs at Scale', 'panel', 'Four senior engineers discuss microservices, chaos engineering, and SLO-driven development.'),
    ses('2026-09-15', '10:30', '10:50', 'Tea Break', 'break', '', true),
    ses('2026-09-15', '10:50', '11:50', 'AI in Production: Real-World Lessons', 'session', 'Rahul Krishnan shares learnings from deploying large models in constrained environments.'),
    ses('2026-09-15', '11:50', '13:00', 'Networking Lunch', 'networking', '', true),
    ses('2026-09-15', '13:00', '14:00', 'Fintech Engineering: Payments at 10M TPS', 'session', 'Deep-dive into India\'s UPI infrastructure and the engineering challenges behind real-time settlement.'),
    ses('2026-09-15', '14:00', '16:00', 'Workshop: Building with LLMs — from PoC to Production', 'workshop', 'Hands-on session. Bring your laptop.'),
    ses('2026-09-15', '16:00', '17:00', 'Startup Pitch Showcase', 'session', 'Six early-stage startups pitch to a panel of VCs and angel investors.'),
    ses('2026-09-15', '17:00', '19:00', 'Evening Networking & Cocktails', 'networking', '', false),
    ses('2026-09-16', '09:00', '10:00', 'DevOps in 2026: Platform Engineering is the New DevOps', 'keynote'),
    ses('2026-09-16', '10:00', '11:00', 'Fireside: Meera Joshi on Building & Selling a Startup', 'session'),
    ses('2026-09-16', '11:00', '11:20', 'Coffee Break', 'break', '', true),
    ses('2026-09-16', '11:20', '12:20', 'Security by Default: Zero Trust Architecture', 'session'),
    ses('2026-09-16', '12:20', '13:30', 'Networking Lunch', 'networking', '', true),
    ses('2026-09-16', '13:30', '15:30', 'Workshop: Kubernetes at Scale — Advanced Patterns', 'workshop', 'Intermediate-to-advanced session. Familiarity with Kubernetes required.'),
    ses('2026-09-16', '15:30', '16:00', 'Closing Keynote & Awards', 'keynote'),
  ]

  const ev1Details = {
    info:    { name: 'Bengaluru Tech Summit 2026', tagline: 'Where India\'s engineering leaders connect, learn, and build the future.', shortDesc: 'Two-day technology conference bringing together 1,000+ engineers, founders, and CTOs in Bengaluru.', fullDesc: 'Bengaluru Tech Summit 2026 is South Asia\'s premier technology conference for senior engineers, engineering leaders, and technology founders. Over two action-packed days at the Bangalore International Exhibition Centre, you\'ll hear from the best minds in cloud, AI, fintech, and developer tooling.\n\nThe summit features four keynote addresses, two full-day workshop tracks, a startup pitch competition, and structured networking sessions designed to forge meaningful professional connections.\n\nWhether you\'re scaling a platform to millions of users, leading a team of 50 engineers, or building the next unicorn from a Bengaluru garage — BTS 2026 has a programme built for you.', language: 'en', dressCode: 'Business casual' },
    media:   { logo: img(orgLogo('BTS')), coverBanner: img(CONF_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(CONF_G1), img(CONF_G2), img(CONF_G3)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'Bangalore International Exhibition Centre', addressLine1: 'Tumkur Road, Madavara', addressLine2: '', city: 'Bengaluru', state: 'Karnataka', country: 'India', pincode: '562123', mapsLink: link('https://maps.google.com/?q=Bangalore+International+Exhibition+Centre'), instructions: 'Metro: Reach Peenya station and take the dedicated shuttle. Parking available at P3 and P4 zones (pay-and-park). Venue gates open at 8:00 AM on both days.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-09-15', startTime: '08:30', endDate: '2026-09-16', endTime: '16:00', doorsOpenTime: '08:00', agenda: ev1Agenda },
    organizer: baseOrg('TechConf India Pvt Ltd', 'hello@bengalurutechsummit.in', '+91 98765 43210', 'https://bengalurutechsummit.in', orgLogo('BTS'), { instagram: 'https://instagram.com/btechsummit', linkedin: 'https://linkedin.com/company/bengaluru-tech-summit', twitter: 'https://twitter.com/btechsummit', hashtags: ['#BTS2026', '#BengaluruTechSummit'] }),
    communication: baseComm(),
    support:       baseSupport('support@bengalurutechsummit.in', '+91 80 4567 8901', 'https://bengalurutechsummit.in/faq', 'https://bengalurutechsummit.in/terms'),
    seo:           baseSeo('bengaluru-tech-summit-2026', 'Bengaluru Tech Summit 2026 — India\'s Premier Engineering Conference', 'Join 1,000+ engineers, CTOs and founders at the Bengaluru Tech Summit 2026. Two days of keynotes, workshops, and networking.', ['tech conference', 'bengaluru', 'engineering', 'cloud', 'AI', 'startup', 'developer conference']),
    publicPage:    basePublicPage(),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { speakers: ev1Speakers, sponsors: ev1Sponsors, tracks: [{ id: uid(), name: 'Cloud & DevOps', color: '#4f46e5' }, { id: uid(), name: 'AI & ML', color: '#06b6d4' }, { id: uid(), name: 'Fintech', color: '#10b981' }], hallLayout: '' },
  }

  // ── EVENT 2: Mumbai Marathon 2027 ─────────────────────────────────────────

  const P2_5K   = 'p2_5k'
  const P2_10K  = 'p2_10k'
  const P2_HALF = 'p2_half'
  const P2_FULL = 'p2_full'

  const ev2Passes = [
    pass(P2_5K,   '5K Fun Run',           799,  ['Bib Included', 'Event T-Shirt', 'Finisher Medal', 'E-Certificate', 'Refreshments']),
    pass(P2_10K,  '10K Run',              1299, ['Bib Included', 'Timing Chip Included', 'Event T-Shirt', 'Finisher Medal', 'E-Certificate', 'Water Stations', 'Medical Support', 'Refreshments']),
    pass(P2_HALF, 'Half Marathon (21K)',  1899, ['Bib Included', 'Timing Chip Included', 'Event T-Shirt', 'Finisher Medal', 'E-Certificate', 'Race Kit', 'Water Stations', 'Medical Support', 'Refreshments']),
    pass(P2_FULL, 'Full Marathon (42K)',  2499, ['Bib Included', 'Timing Chip Included', 'Event T-Shirt', 'Finisher Medal', 'Trophy Eligibility', 'E-Certificate', 'Race Kit', 'Water Stations', 'Medical Support', 'Priority Bib Collection'], 3000, 'Full 42.195 km AIMS-certified course through Mumbai\'s iconic seafront.'),
  ]

  const ev2Details = {
    info:    { name: 'Mumbai Marathon 2027', tagline: 'Run the City of Dreams — 42K of Mumbai\'s Most Iconic Routes.', shortDesc: 'AIMS-certified full marathon through Mumbai\'s iconic seafront, covering MMRDA, Bandra-Worli Sea Link, and Marine Drive.', fullDesc: 'Mumbai Marathon 2027 returns to the City of Dreams with the most scenic running course in South Asia. Starting at MMRDA Grounds in BKC, the AIMS-certified 42.195 km route takes runners along the Bandra–Worli Sea Link, past Haji Ali, down Marine Drive, and back — a route unlike any other in the world.\n\nWith categories for every level — from first-time 5K runners to sub-3-hour marathoners — Mumbai Marathon 2027 is your chance to be part of India\'s most celebrated annual run.\n\nAll finishers receive an official timing chip result, a custom medal, and a race t-shirt. A state-of-the-art race village at BKC will feature bag deposit, medical teams, live entertainment, and a finisher\'s area with post-race nutrition.', language: 'en', dressCode: 'Athletic wear. No jeans or formal shoes.' },
    media:   { logo: img(orgLogo('MM27')), coverBanner: img(MARA_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(MARA_G1), img(MARA_G2), img(MARA_G3)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'MMRDA Grounds, BKC', addressLine1: 'Bandra Kurla Complex, Bandra East', addressLine2: '', city: 'Mumbai', state: 'Maharashtra', country: 'India', pincode: '400051', mapsLink: link('https://maps.google.com/?q=MMRDA+Grounds+BKC+Mumbai'), instructions: 'Reach the race village by 5:00 AM. Bag deposit opens at 4:30 AM. Nearest Metro: BKC Station (Line 2A). No vehicular entry after 4:30 AM on race day.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2027-01-17', startTime: '06:00', endDate: '2027-01-17', endTime: '14:00', doorsOpenTime: '04:30', agenda: [
      ses('2027-01-17', '04:30', '05:30', 'Bag Deposit & Bib Collection',  'session', 'Collect your bib if not pre-collected. Bag deposit closes at 5:30 AM.'),
      ses('2027-01-17', '05:30', '06:00', 'Warm-up & Assembly at Start Line', 'session'),
      ses('2027-01-17', '06:00', '06:30', 'Wave 1 Start — Full Marathon (Elite & Sub-4h)', 'keynote'),
      ses('2027-01-17', '06:30', '07:00', 'Wave 2 — Half Marathon & 10K', 'session'),
      ses('2027-01-17', '07:30', '08:00', 'Wave 3 — 5K Fun Run', 'session'),
      ses('2027-01-17', '09:00', '13:00', 'Finisher Zone Open & Post-Race Village', 'networking', 'Live music, food stalls, massage stations, and hydration zone.'),
    ] },
    organizer: baseOrg('Mumbai Marathon Association', 'info@mumbaimarathon.in', '+91 22 6789 0123', 'https://mumbaimarathon.in', orgLogo('MMA'), { instagram: 'https://instagram.com/mumbaimarathon', twitter: 'https://twitter.com/mumbaimarathon', hashtags: ['#MumbaiMarathon2027', '#RunMumbai'] }),
    communication: baseComm(),
    support:       baseSupport('support@mumbaimarathon.in', '+91 22 6789 0124', 'https://mumbaimarathon.in/faq', 'https://mumbaimarathon.in/terms'),
    seo:           baseSeo('mumbai-marathon-2027', 'Mumbai Marathon 2027 — Run the City of Dreams', 'Register for Mumbai Marathon 2027. 5K, 10K, Half and Full Marathon on Mumbai\'s iconic seafront route.', ['mumbai marathon', 'marathon 2027', 'running', '42k', 'half marathon', 'AIMS certified']),
    publicPage:    basePublicPage({ showSpeakers: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { routeMapUrl: '', reportingTime: '04:30', kitCollectionInfo: 'Kit collection is available at BKC Expo on 15–16 Jan 2027. On race day, limited bib collection at MMRDA from 4:30 AM.', kitCollectionDate: '2027-01-15', bagDepositInfo: 'Bag deposit opens at 4:30 AM at MMRDA. Use the supplied race bag with your bib number attached. Collect immediately after finishing.', medicalSupportInfo: 'Certified sports medicine doctors, physiotherapists, and ambulances positioned every 5K along the route. Race village medical tent open throughout.', hydrationPoints: 'Every 2.5 km along the course. Electrolyte drinks at 10K, 21K, 30K, and 37K.', startLineInfo: 'All waves start at MMRDA Gate 5. VIP Start Zone for Elite and sub-3:30 runners — separate corral with priority placement.', rulesUrl: 'https://mumbaimarathon.in/rules' },
  }

  // ── EVENT 3: Full Stack Developer Bootcamp ─────────────────────────────────

  const P3_GEN  = 'p3_gen'
  const P3_EARL = 'p3_early'

  const ev3Passes = [
    pass(P3_EARL, 'Early Bird',   4499, ['Workshop Access', 'Study Material', 'Practical Labs', 'Completion Certificate', 'Community Access', 'Discussion Group'], 20, 'Save ₹1,500! Ends 15 July 2026.'),
    pass(P3_GEN,  'Standard',     5999, ['Workshop Access', 'Study Material', 'Practical Labs', 'Completion Certificate', 'Community Access', 'Discussion Group', 'Recording Access']),
  ]

  const ev3Trainers = [
    spk('Vikram Mehta',    'Senior Full Stack Architect', 'IndiaTech Consulting', '12 years building full-stack applications in React, Node.js, and PostgreSQL. Vikram has trained 3,000+ developers across India and the UAE.', SPK_6),
    spk('Shalini Reddy',   'DevOps & Cloud Engineer', 'CloudFirst India', 'Specialises in CI/CD pipelines, Docker, and Kubernetes. Shalini has led DevOps transformations at three Bengaluru unicorns.', SPK_2),
  ]

  const ev3Details = {
    info:    { name: 'Full Stack Developer Bootcamp', tagline: 'Three days of hands-on, production-grade full-stack engineering.', shortDesc: 'An intensive 3-day bootcamp covering React, Node.js, PostgreSQL, Docker, and CI/CD — taught by practising engineers.', fullDesc: 'This is not a tutorial. This is a simulation of real-world engineering.\n\nOver three immersive days at T-Hub Hyderabad, you will design, build, and deploy a full-stack application from scratch — using the same tools, architecture patterns, and delivery pipelines used by top product companies.\n\nDay 1: Frontend with React 19 & Next.js 14 — component design, state management, server actions\nDay 2: Backend with Node.js, tRPC, and PostgreSQL — API design, authentication, database modelling\nDay 3: DevOps with Docker, GitHub Actions, and AWS EC2 — containerisation, CI/CD, monitoring\n\nBatch size is limited to 30. Every participant leaves with a deployed, live application and a completion certificate.', language: 'en', dressCode: 'Casual. Bring your laptop.' },
    media:   { logo: img(orgLogo('FSDB')), coverBanner: img(WORK_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(WORK_G1), img(WORK_G2)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'T-Hub Phase 2, IIIT Hyderabad Campus', addressLine1: '20, IIIT Rd, Gachibowli', addressLine2: '', city: 'Hyderabad', state: 'Telangana', country: 'India', pincode: '500032', mapsLink: link('https://maps.google.com/?q=T-Hub+Hyderabad'), instructions: 'Nearest metro: Raidurg Station (Blue Line), 8 min auto. T-Hub gates open at 8:30 AM. Show your registration QR at the security desk.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-08-01', startTime: '09:00', endDate: '2026-08-03', endTime: '17:30', doorsOpenTime: '08:30', agenda: [
      ses('2026-08-01', '09:00', '09:30', 'Welcome & Orientation',                          'session'),
      ses('2026-08-01', '09:30', '13:00', 'Day 1 AM: React 19 — Foundations & Patterns',    'workshop', 'Components, hooks, server/client boundary, and design systems.'),
      ses('2026-08-01', '13:00', '14:00', 'Lunch',                                          'break', '', true),
      ses('2026-08-01', '14:00', '17:30', 'Day 1 PM: Next.js App Router & Server Actions',  'workshop', 'File-based routing, data fetching, server actions, and deployment to Vercel.'),
      ses('2026-08-02', '09:00', '13:00', 'Day 2 AM: Node.js API & Database Design',        'workshop', 'REST vs tRPC, auth with JWTs, PostgreSQL schema design, and Prisma ORM.'),
      ses('2026-08-02', '13:00', '14:00', 'Lunch',                                          'break', '', true),
      ses('2026-08-02', '14:00', '17:30', 'Day 2 PM: Build Your Backend',                   'labs', 'Participants build their own authenticated API end-to-end.'),
      ses('2026-08-03', '09:00', '13:00', 'Day 3 AM: Docker & CI/CD with GitHub Actions',   'workshop', 'Containerise your app, write a pipeline, and push to production.'),
      ses('2026-08-03', '13:00', '14:00', 'Lunch',                                          'break', '', true),
      ses('2026-08-03', '14:00', '17:00', 'Day 3 PM: Deploy to AWS EC2 & Monitoring',       'labs'),
      ses('2026-08-03', '17:00', '17:30', 'Demo Day & Certificate Ceremony',                'keynote'),
    ] },
    organizer: baseOrg('DevForward Academy', 'bootcamp@devforward.in', '+91 40 6543 2100', 'https://devforward.in', orgLogo('DF'), { instagram: 'https://instagram.com/devforwardacademy', linkedin: 'https://linkedin.com/company/devforward-academy' }),
    communication: baseComm(),
    support:       baseSupport('support@devforward.in', '+91 40 6543 2101', 'https://devforward.in/faq'),
    seo:           baseSeo('full-stack-dev-bootcamp-2026', 'Full Stack Developer Bootcamp 2026 — Hyderabad', 'Intensive 3-day full-stack bootcamp in Hyderabad. React, Node.js, PostgreSQL, Docker, CI/CD. Limited to 30 seats.', ['full stack bootcamp', 'react workshop', 'node js', 'hyderabad developer training', 'web development']),
    publicPage:    basePublicPage(),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { trainers: ev3Trainers, prerequisites: 'Comfortable with HTML, CSS, and basic JavaScript. No prior React or Node.js experience required.', learningOutcomes: ['Build a production-ready full-stack application', 'Understand server-side rendering and the React 19 App Router model', 'Design and implement a relational database schema', 'Write and ship a CI/CD pipeline to a cloud server', 'Use Docker for containerisation and reproducible deployments'], materialsIncluded: 'Printed cheat sheets, GitHub repository with all labs, 6-month access to recorded sessions, alumni Slack community', softwareRequired: 'VS Code (latest), Node.js 20+, Docker Desktop, Git, Chrome browser', batchSize: 30 },
  }

  // ── EVENT 4: India Startup Founders Conclave ───────────────────────────────

  const P4_FREE = 'p4_free'

  const ev4Passes = [
    pass(P4_FREE, 'Founder Pass', 0, ['Networking Access', 'Panel Discussion Access', 'Startup Showcase', 'Refreshments'], 300, 'Free for verified founders, co-founders, and early-stage team members.'),
  ]

  const ev4Details = {
    info:    { name: 'India Startup Founders Conclave 2026', tagline: 'The room where Indian founders meet, share, and grow together.', shortDesc: 'A curated half-day event connecting 300 founders, co-founders, and early-stage operators across sectors.', fullDesc: 'India Startup Founders Conclave is not another startup conference — there are no investors on stage, no pitch decks, and no corporate sponsors at this event.\n\nThis is a founder-first gathering: 300 seats reserved exclusively for founders and co-founders of startups at idea stage through Series A. We remove the noise and create the space for honest, peer-to-peer conversations about what it actually takes to build a company in India.\n\nExpect: real-talk panels from founders who have shipped, scaled, and failed. Structured matchmaking sessions. A startup showcase wall where founders can display their products. And a networking dinner to end the day.\n\nAttendance is verified. Every RSVP is reviewed within 24 hours.', language: 'en', dressCode: 'Smart casual' },
    media:   { logo: img(orgLogo('ISFC')), coverBanner: img(MEET_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: '91springboard Koramangala', addressLine1: '4th Floor, 7 27th Cross Rd, Sector 2, HSR Layout', addressLine2: 'Koramangala, Bengaluru', city: 'Bengaluru', state: 'Karnataka', country: 'India', pincode: '560034', mapsLink: link('https://maps.google.com/?q=91springboard+Koramangala+Bengaluru'), instructions: 'Enter from 27th Cross Road. Elevator to 4th floor. Registration desk at the entrance. Parking available in the building basement — first 2 hours free.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-07-26', startTime: '13:00', endDate: '2026-07-26', endTime: '20:00', doorsOpenTime: '12:30', agenda: [
      ses('2026-07-26', '12:30', '13:00', 'Check-in & Networking',              'networking'),
      ses('2026-07-26', '13:00', '13:15', 'Welcome Address',                    'keynote'),
      ses('2026-07-26', '13:15', '14:15', 'Panel: Zero to ₹10 Cr ARR — What Actually Works', 'panel', 'Four founders share unfiltered stories of finding their first 100 customers.'),
      ses('2026-07-26', '14:15', '15:15', 'Structured Networking Rounds',       'networking', '5 rounds of 10-minute one-on-one conversations using a curated matchmaking format.'),
      ses('2026-07-26', '15:15', '15:30', 'Tea Break',                          'break', '', true),
      ses('2026-07-26', '15:30', '16:30', 'Startup Showcase Walk',              'session', 'Browse 20 products built by fellow founders. Discuss, critique, and connect.'),
      ses('2026-07-26', '16:30', '17:30', 'Panel: Hiring Your First 10 Engineers', 'panel'),
      ses('2026-07-26', '17:30', '18:00', 'Open Forum & Q&A',                   'session'),
      ses('2026-07-26', '18:00', '20:00', 'Founder Dinner & Open Bar',          'networking'),
    ] },
    organizer: baseOrg('FounderCircle India', 'hello@foundercircle.in', '+91 80 4321 0987', 'https://foundercircle.in', orgLogo('FC'), { instagram: 'https://instagram.com/foundercirclein', twitter: 'https://twitter.com/foundercirclein', linkedin: 'https://linkedin.com/company/foundercircle-india', hashtags: ['#FounderCircle', '#ISFC2026'] }),
    communication: baseComm(),
    support:       baseSupport('support@foundercircle.in', '+91 80 4321 0987'),
    seo:           baseSeo('india-startup-founders-conclave-2026', 'India Startup Founders Conclave 2026 — Bengaluru', 'Curated founder-only event in Bengaluru for 300 startup founders. Panels, networking, startup showcase. Free to attend.', ['startup founders', 'bengaluru founders meetup', 'startup networking', 'founder conclave']),
    publicPage:    basePublicPage({ showSpeakers: false, showSponsors: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { startupShowcaseEnabled: true, pitchSessionEnabled: false, pitchFormat: '', investorConnectEnabled: false },
  }

  // ── EVENT 5: Clean Coast Community Drive ──────────────────────────────────

  const P5_VOL  = 'p5_vol'
  const P5_SUPP = 'p5_supp'

  const ev5Passes = [
    pass(P5_VOL,  'Volunteer',  0, ['Event Entry', 'Volunteer Certificate', 'Awareness Kit', 'Event Badge', 'Refreshments', 'T-Shirt'], 500, 'Join us as an active volunteer — bring your spirit and good shoes.'),
    pass(P5_SUPP, 'Supporter',  0, ['Event Entry', 'Supporter Access', 'Awareness Kit', 'Event Badge', 'Refreshments'], null, 'Attend and show your support without the physical volunteering tasks.'),
  ]

  const ev5Details = {
    info:    { name: 'Clean Coast — Juhu Beach Drive 2026', tagline: 'One morning. One beach. A thousand changemakers.', shortDesc: 'A large-scale community beach clean-up drive at Juhu, Mumbai — open to all citizens passionate about our oceans.', fullDesc: 'Mumbai\'s coastline is one of the world\'s most iconic — and most pressured. Every year, thousands of tonnes of plastic and waste wash up on our shores. Clean Coast is our collective answer.\n\nJoin us on the morning of 28 September 2026 at Juhu Beach for a 4-hour community clean-up drive. All equipment is provided — gloves, biodegradable bags, litter pickers, and collection bins. Volunteers are grouped into teams of 15, each led by a trained coordinator.\n\nAfter the clean-up, join us for a community breakfast on the beach, an awareness session on ocean plastics and circular economy, and the unveiling of our annual Ocean Impact Report.\n\nThis event is free, family-friendly, and open to all age groups. Children above 6 are welcome with a parent or guardian.', language: 'en', dressCode: 'Old clothes you don\'t mind getting sandy. Closed-toe shoes. We provide gloves.' },
    media:   { logo: img(orgLogo('CC')), coverBanner: img(COMM_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(COMM_G1), img(COMM_G2)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'Juhu Beach — Northern End', addressLine1: 'Near Silver Beach Club, Juhu Tara Road', addressLine2: '', city: 'Mumbai', state: 'Maharashtra', country: 'India', pincode: '400049', mapsLink: link('https://maps.google.com/?q=Juhu+Beach+Mumbai'), instructions: 'Look for the Clean Coast tent near the Silver Beach Club end of Juhu Beach. Volunteers, please arrive by 7:15 AM for team briefing.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-09-28', startTime: '07:30', endDate: '2026-09-28', endTime: '12:00', doorsOpenTime: '07:00', agenda: [
      ses('2026-09-28', '07:00', '07:30', 'Registration & Kit Distribution',     'session'),
      ses('2026-09-28', '07:30', '08:00', 'Team Briefing & Safety Instructions', 'session'),
      ses('2026-09-28', '08:00', '11:00', 'Beach Clean-Up Drive',               'session', 'Teams spread across the designated 2 km stretch of Juhu Beach.'),
      ses('2026-09-28', '11:00', '11:30', 'Waste Sorting & Collection Handover', 'session'),
      ses('2026-09-28', '11:30', '12:00', 'Community Breakfast & Impact Talk',   'networking'),
    ] },
    organizer: baseOrg('OceanFirst India', 'hello@oceanfirst.in', '+91 22 4567 8900', 'https://oceanfirst.in', orgLogo('OF'), { instagram: 'https://instagram.com/oceanfirstindia', linkedin: 'https://linkedin.com/company/oceanfirst-india', hashtags: ['#CleanCoast', '#OceanFirstIndia', '#JuhuBeach'] }),
    communication: baseComm(),
    support:       baseSupport('support@oceanfirst.in', '+91 22 4567 8900'),
    seo:           baseSeo('clean-coast-juhu-beach-drive-2026', 'Clean Coast — Juhu Beach Community Drive 2026', 'Join 500+ volunteers at Juhu Beach for a free community clean-up drive. Gloves, bags, and breakfast provided.', ['beach clean up', 'mumbai', 'juhu beach', 'community drive', 'environment', 'volunteer']),
    publicPage:    basePublicPage({ showSpeakers: false, showSponsors: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { causeInfo: 'Mumbai\'s coastline receives over 80 metric tonnes of plastic waste annually. Clean Coast is our citizen-led response to one of the city\'s most visible environmental crises. Every piece of plastic we remove today stops it from entering the ocean tomorrow.', volunteerInstructions: 'Arrive by 7:15 AM for team briefing. Wear closed-toe shoes and comfortable clothes. All equipment is provided. No prior experience needed — our coordinators will guide your team throughout the drive.', campaignInfo: 'This is part of our annual City Coast Month — four clean-up events across Mumbai, Pune, Goa, and Chennai every September.', impactGoal: 'Remove 2,000 kg of plastic waste from Juhu Beach in a single morning, matching our 2025 record.' },
  }

  // ── EVENT 6: Teach For Change NGO Summit ──────────────────────────────────

  const P6_DEL  = 'p6_del'
  const P6_STU  = 'p6_stu'

  const ev6Passes = [
    pass(P6_DEL, 'Delegate',  0, ['Event Entry', 'Volunteer Certificate', 'Awareness Kit', 'Refreshments'], null),
    pass(P6_STU, 'Student',   0, ['Event Entry', 'Participation Certificate', 'Awareness Kit'], null, 'Free for enrolled college and university students with valid ID.'),
  ]

  const ev6Details = {
    info:    { name: 'Teach For Change NGO Summit 2026', tagline: 'Uniting India\'s education changemakers under one roof.', shortDesc: 'Annual summit for NGOs, educators, and policy makers working on equitable education access across India.', fullDesc: 'The Teach For Change NGO Summit brings together over 200 education-sector NGOs, grassroots educators, government officials, and social entrepreneurs for a day of learning, collaboration, and action planning.\n\nThis year\'s theme is "Bridging the Last Mile" — focused on what it takes to reach the 260 million children in India who are still not accessing quality foundational learning.\n\nThe summit features panel discussions on policy reform, workshops on community engagement and fundraising, and a networking session connecting NGOs with institutional funders and CSR teams from India\'s top corporations.\n\nAttendance is open and free of charge. Lunch and materials are provided for all registered delegates.', language: 'en', dressCode: '' },
    media:   { logo: img(orgLogo('TFC')), coverBanner: img(NGO_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'India International Centre', addressLine1: '40, Max Mueller Marg, Lodhi Estate', addressLine2: '', city: 'New Delhi', state: 'Delhi', country: 'India', pincode: '110003', mapsLink: link('https://maps.google.com/?q=India+International+Centre+New+Delhi'), instructions: 'Nearest Metro: JLN Stadium (Violet Line), 10 min walk. Entry from Max Mueller Marg. Registration desk at the main lobby.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-09-05', startTime: '09:30', endDate: '2026-09-05', endTime: '17:00', doorsOpenTime: '09:00', agenda: [
      ses('2026-09-05', '09:00', '09:30', 'Registration & Morning Tea',              'networking'),
      ses('2026-09-05', '09:30', '10:00', 'Inaugural Address',                       'keynote'),
      ses('2026-09-05', '10:00', '11:00', 'Panel: NEP 2020 — Two Years In',          'panel', 'NGO leaders and former education secretaries assess implementation realities.'),
      ses('2026-09-05', '11:00', '11:15', 'Tea Break',                               'break', '', true),
      ses('2026-09-05', '11:15', '12:15', 'Workshop: Grassroots Fundraising Playbook', 'workshop', 'Practical frameworks for small NGOs to diversify funding without a development team.'),
      ses('2026-09-05', '12:15', '13:15', 'Networking Lunch',                         'networking', '', true),
      ses('2026-09-05', '13:15', '14:15', 'CSR Connect: Matching NGOs with Funders',  'session'),
      ses('2026-09-05', '14:15', '15:15', 'Panel: Technology for Rural Education',    'panel'),
      ses('2026-09-05', '15:15', '15:30', 'Tea Break',                               'break', '', true),
      ses('2026-09-05', '15:30', '16:30', 'Open Forum: Sharing Failures Openly',      'session', 'NGOs share what didn\'t work and what they learned. No spin.'),
      ses('2026-09-05', '16:30', '17:00', 'Closing Ceremony & Pledge',               'keynote'),
    ] },
    organizer: baseOrg('Teach For Change Foundation', 'summit@teachforchange.org', '+91 11 4567 8900', 'https://teachforchange.org', orgLogo('TFC'), { linkedin: 'https://linkedin.com/company/teach-for-change-india', instagram: 'https://instagram.com/teachforchangeindia' }),
    communication: baseComm(),
    support:       baseSupport('support@teachforchange.org', '+91 11 4567 8900'),
    seo:           baseSeo('teach-for-change-ngo-summit-2026', 'Teach For Change NGO Summit 2026 — New Delhi', 'Free annual summit for education NGOs in India. 200+ organisations. Panels, workshops, and CSR connect sessions.', ['ngo summit', 'education ngo', 'new delhi', 'social impact', 'teach for india', 'csr']),
    publicPage:    basePublicPage({ showSpeakers: false, showSponsors: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { causeInfo: '260 million children in India still lack access to quality foundational learning. Teach For Change Summit brings together the organisations, educators, and funders working to change that — one classroom, one district, and one policy at a time.', volunteerInstructions: 'Volunteer slots are available for logistics support, registration desk management, and session facilitation. Email volunteer@teachforchange.org to apply.', campaignInfo: 'This is the 7th edition of the annual summit, which has collectively connected over 800 NGOs with funding partners and policy advisors since 2019.', impactGoal: 'Facilitate 50 new funder–NGO connections and generate ₹2 crore in committed CSR funding at this event.' },
  }

  // ── EVENT 7: Run For A Smile Charity 5K ───────────────────────────────────

  const P7_SUPP  = 'p7_supp'
  const P7_CHAMP = 'p7_champ'
  const P7_HERO  = 'p7_hero'

  const ev7Passes = [
    pass(P7_SUPP,  'Supporter — ₹500 + Donation', 500,  ['Bib Included', 'Event T-Shirt', 'E-Certificate', 'Donation Receipt', 'Refreshments'], 2000, '₹250 goes directly to the Smile Foundation children\'s fund.'),
    pass(P7_CHAMP, 'Champion — ₹1,000 + Donation', 1000, ['Bib Included', 'Event T-Shirt', 'Finisher Medal', 'E-Certificate', 'Donation Receipt', 'Refreshments'], 1000, '₹700 goes to the Smile Foundation. Champion badge on your bib.'),
    pass(P7_HERO,  'Hero — ₹2,000 + Donation',    2000, ['Bib Included', 'Event T-Shirt', 'Finisher Medal', 'Tree Sapling', 'E-Certificate', 'Donation Receipt', 'Refreshments', 'Priority Bib Collection'], 500, '₹1,600 goes to the Smile Foundation. Hero ribbon and plaque.'),
  ]

  const ev7Details = {
    info:    { name: 'Run For A Smile — Charity 5K 2026', tagline: 'Every kilometre you run funds a child\'s education.', shortDesc: 'A 5K charity run in Cubbon Park, Bengaluru, raising funds for underprivileged children\'s education through Smile Foundation.', fullDesc: 'Run For A Smile is Bengaluru\'s most heartfelt morning run. This is not about timing — it\'s about purpose.\n\nEvery entry fee goes directly toward funding quality education for underprivileged children through the Smile Foundation\'s Shiksha na Ruke programme. Last year, 3,500 participants raised ₹42 lakh — enough to fund 84 children\'s full-year education.\n\nThis year, we\'re back at the stunning Cubbon Park with a 5K route through the park\'s tree-lined avenues. The event is family-friendly and open to all fitness levels — you can run, jog, or walk the entire distance. Strollers are welcome.\n\nEvery participant receives a personalised bib with the name of the child their entry supports, a custom t-shirt, and a digital certificate. Hero tier participants also receive a tree sapling.', language: 'en', dressCode: 'Comfortable running wear. Closed-toe shoes.' },
    media:   { logo: img(orgLogo('RFS')), coverBanner: img(CHARITY_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'Cubbon Park — Bandstand Lawn', addressLine1: 'Cubbon Park, Kasturba Road', addressLine2: '', city: 'Bengaluru', state: 'Karnataka', country: 'India', pincode: '560001', mapsLink: link('https://maps.google.com/?q=Cubbon+Park+Bengaluru'), instructions: 'Enter from the Kasturba Road gate. Look for the Run For A Smile start arch near the Bandstand Lawn. Registration desk open from 6:00 AM.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-10-04', startTime: '06:30', endDate: '2026-10-04', endTime: '10:00', doorsOpenTime: '06:00', agenda: [
      ses('2026-10-04', '06:00', '06:30', 'Registration & Bib Collection',     'session'),
      ses('2026-10-04', '06:30', '06:45', 'Opening Address & Warm-up',         'keynote'),
      ses('2026-10-04', '06:45', '07:00', 'Flagoff — Hero Tier',               'session'),
      ses('2026-10-04', '07:00', '07:15', 'Flagoff — Champion & Supporter',    'session'),
      ses('2026-10-04', '08:00', '09:30', 'Finish Line & Celebration',         'networking', 'Live music, finisher medals, breakfast, and impact presentation.'),
      ses('2026-10-04', '09:30', '10:00', 'Tree Sapling Distribution (Hero Tier)', 'session'),
    ] },
    organizer: baseOrg('Smile Foundation India', 'run@smilefoundationindia.org', '+91 80 2222 3333', 'https://smilefoundationindia.org', orgLogo('SF'), { instagram: 'https://instagram.com/smilefoundationindia', twitter: 'https://twitter.com/smilefdn', hashtags: ['#RunForASmile', '#SmileFoundation', '#ShikshaRuke'] }),
    communication: baseComm(),
    support:       baseSupport('support@smilefoundationindia.org', '+91 80 2222 3333'),
    seo:           baseSeo('run-for-a-smile-charity-5k-2026', 'Run For A Smile — Charity 5K Bengaluru 2026', 'Register for the Run For A Smile charity 5K in Cubbon Park. Every entry funds a child\'s education. Family-friendly.', ['charity run', 'bengaluru 5k', 'cubbon park', 'smile foundation', 'fundraising run', 'education']),
    publicPage:    basePublicPage({ showSpeakers: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { beneficiaryInfo: 'Smile Foundation\'s Shiksha na Ruke programme funds quality education for underprivileged children aged 6–18 in Bengaluru, Hyderabad, and Delhi. Funds cover tuition, books, uniforms, and mid-day meals.', fundUsage: '80% of every ticket directly funds children\'s education. 20% covers event logistics. Full impact report shared with all participants post-event.', donationGoal: 5000000, ngoPartner: 'Smile Foundation India (Reg. No. AAATS3490Q)', taxExemptionInfo: 'Donations are eligible for 80G tax exemption. Donation receipts issued within 7 business days of the event.' },
  }

  // ── EVENT 8: India Fintech & Payments Expo 2026 ───────────────────────────

  const P8_VIS  = 'p8_vis'
  const P8_BIZ  = 'p8_biz'
  const P8_EXH  = 'p8_exh'

  const ev8Passes = [
    pass(P8_VIS, 'General Visitor',      0,     ['Visitor Access', 'Hall Access', 'Digital Promotion', 'Directory Listing']),
    pass(P8_BIZ, 'Business Visitor',     999,   ['Business Visitor Entry', 'Business Lounge', 'Buyer-Seller Meet', 'Hall Access', 'Directory Listing']),
    pass(P8_EXH, 'Exhibitor (Booth)',    25000, ['Standard Booth', 'Electricity', 'Table', 'Chairs', 'Internet', 'Directory Listing', 'Brand Promotion', 'Digital Promotion'], 80, 'Includes 3m×3m booth space, fascia board, and 4 exhibitor badges. Additional badges at ₹2,000 each.'),
  ]

  const ev8Sponsors = [
    spo('Razorpay',      spoLogo('Razorpay',  '3395FF'), 'https://razorpay.com',   'title'),
    spo('PhonePe',       spoLogo('PhonePe',   '5f259f'), 'https://phonepe.com',    'gold'),
    spo('NPCI',          spoLogo('NPCI',      '0f4f90'), 'https://npci.org.in',    'gold'),
    spo('Mastercard',    spoLogo('MC',        'eb001b'), 'https://mastercard.com', 'silver'),
    spo('The Hindu BusinessLine', spoLogo('BusinessLine', '1a1a1a'), 'https://thehindubusinessline.com', 'media'),
  ]

  const ev8Details = {
    info:    { name: 'India Fintech & Payments Expo 2026', tagline: 'Three days at the frontier of India\'s payments revolution.', shortDesc: '3-day exhibition and conference bringing together 200+ fintech exhibitors, 80+ speakers, and 10,000+ visitors at Bombay Exhibition Centre.', fullDesc: 'India Fintech & Payments Expo is the subcontinent\'s largest dedicated exhibition for the payments, digital banking, and financial technology ecosystem.\n\nOver three days at the Bombay Exhibition Centre, 200+ exhibitors — from fintech startups to global payment networks — will showcase cutting-edge products and infrastructure powering India\'s $3 trillion digital economy.\n\nThe expo features a three-track conference programme with 80+ speakers from RBI, NPCI, SEBI, and leading fintech companies; a startup pavilion where 40 early-stage fintechs pitch to investors; and a curated Buyer–Seller Matchmaking programme connecting enterprise buyers with solution providers.\n\nGeneral visitor entry is free. Business visitor and exhibitor passes available.', language: 'en', dressCode: 'Business formal' },
    media:   { logo: img(orgLogo('IFE')), coverBanner: img(EXPO_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(EXPO_G1), img(EXPO_G2)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'Bombay Exhibition Centre', addressLine1: 'Western Express Highway, Goregaon East', addressLine2: '', city: 'Mumbai', state: 'Maharashtra', country: 'India', pincode: '400063', mapsLink: link('https://maps.google.com/?q=Bombay+Exhibition+Centre+Goregaon'), instructions: 'Nearest Metro: Goregaon (WEH side). Ample parking in P1, P2 zones. Expo gates open at 9:00 AM all three days.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-11-07', startTime: '09:00', endDate: '2026-11-09', endTime: '18:00', doorsOpenTime: '08:30', agenda: [
      ses('2026-11-07', '09:00', '10:00', 'Inauguration Ceremony & Ribbon Cutting',     'keynote'),
      ses('2026-11-07', '10:00', '13:00', 'Exhibition Halls Open — Day 1',              'session'),
      ses('2026-11-07', '11:00', '12:00', 'Conference: UPI 3.0 — What\'s Next for India\'s Payments Stack', 'panel'),
      ses('2026-11-07', '14:00', '17:00', 'Buyer–Seller Matchmaking Sessions',          'networking'),
      ses('2026-11-08', '09:00', '18:00', 'Exhibition Halls Open — Day 2',              'session'),
      ses('2026-11-08', '11:00', '12:00', 'Conference: Embedded Finance & BaaS',        'panel'),
      ses('2026-11-08', '14:00', '16:00', 'Startup Pavilion — Fintech Pitch Day',       'session'),
      ses('2026-11-09', '09:00', '17:00', 'Exhibition Halls Open — Day 3',              'session'),
      ses('2026-11-09', '11:00', '12:00', 'Conference: Cybersecurity in Digital Payments', 'session'),
      ses('2026-11-09', '15:00', '16:00', 'Valedictory Session & Best Booth Awards',   'keynote'),
    ] },
    organizer: baseOrg('Expo India Events Pvt Ltd', 'info@indiafinexpo.com', '+91 22 4321 5678', 'https://indiafinexpo.com', orgLogo('IFE'), { linkedin: 'https://linkedin.com/company/india-fintech-expo', instagram: 'https://instagram.com/indiafinexpo' }),
    communication: baseComm(),
    support:       baseSupport('support@indiafinexpo.com', '+91 22 4321 5679', 'https://indiafinexpo.com/faq', 'https://indiafinexpo.com/terms'),
    seo:           baseSeo('india-fintech-expo-2026', 'India Fintech & Payments Expo 2026 — Mumbai', '3-day fintech exhibition at Bombay Exhibition Centre. 200+ exhibitors, 80+ speakers, 10,000+ visitors.', ['fintech expo', 'payments expo', 'mumbai fintech', 'digital payments india', 'fintech conference']),
    publicPage:    basePublicPage({ showSpeakers: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { boothInfoUrl: 'https://indiafinexpo.com/exhibitor-kit', floorPlanUrl: '', visitorInstructions: 'Carry a valid photo ID. Pre-register online for faster entry. Business visitor passes include access to all three halls and the conference programme.', parkingInfo: 'Parking available at P1 and P2 zones — ₹100 per day for cars, ₹50 per day for two-wheelers. Metro is strongly recommended on peak days (7–8 Nov).' },
  }

  // ── EVENT 9: Raga & Rhythm Classical Music Festival ───────────────────────

  const P9_STD  = 'p9_std'
  const P9_PREM = 'p9_prem'

  const ev9Passes = [
    pass(P9_STD,  'Standard',  499,  ['Hall Access', 'Both Days', 'Event Badge']),
    pass(P9_PREM, 'Premium',   1499, ['Hall Access', 'Both Days', 'Event Badge', 'Reserved Seating — Front Section', 'Backstage Meet & Greet on Day 2', 'Complimentary Programme Booklet', 'Refreshments'], 200),
  ]

  const ev9Artists = [
    spk('Pandit Shivkumar Prasad', 'Hindustani Vocalist', 'Kirana Gharana', 'A third-generation Kirana gharana vocalist, Pandit Shivkumar Prasad has performed at the Savai Gandharva Sangeet Mahotsav and the Saptak Festival for over three decades.', SPK_1),
    spk('Dr Vijaylakshmi Iyer',   'Carnatic Violinist',  'Independent Artist', 'Disciple of the legendary Lalgudi Jayaraman, Dr Vijaylakshmi brings unparalleled lyricism to the violin. She is a recipient of the Sangeet Natak Akademi Young Talent Award.', SPK_2),
    spk('Arjun Krishnamurthy',    'Mridangam Maestro',   'Carnatic Percussion', 'One of South India\'s most sought-after mridangam accompanists, Arjun brings rhythmic precision and playful improvisation to every performance.', SPK_3),
    spk('Kavita Bhartiya',        'Kathak Dancer',       'Kalashram Academy', 'Trained under Pandit Birju Maharaj\'s tradition, Kavita\'s abhinaya is unmatched in contemporary Kathak. She opens Day 2 with a 45-minute solo recital.', SPK_5),
  ]

  const ev9Details = {
    info:    { name: 'Raga & Rhythm — Classical Music Festival 2026', tagline: 'Two evenings of India\'s finest classical music and dance.', shortDesc: '2-day classical music festival at Chennai\'s historic SMR Concert Hall, featuring Hindustani vocal, Carnatic violin, mridangam, and Kathak.', fullDesc: 'Raga & Rhythm returns to the legendary Sir Mutha Venkatasubba Rao Concert Hall in Chennai for its 11th edition — two evenings of India\'s most celebrated classical art forms in one of the country\'s most acoustically perfect venues.\n\nDay 1 opens with a Carnatic violin recital by Dr Vijaylakshmi Iyer, accompanied on mridangam by Arjun Krishnamurthy, followed by a Hindustani vocal concert by Pandit Shivkumar Prasad.\n\nDay 2 features an inaugural Kathak recital by Kavita Bhartiya, followed by a jugalbandi between the two featured vocalists — a rare and always electric collaboration.\n\nPremium pass holders are invited to a backstage meet-and-greet with all four artists after the final performance.', language: 'en', dressCode: 'Formal or traditional Indian attire preferred.' },
    media:   { logo: img(orgLogo('R&R')), coverBanner: img(CULT_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(CULT_G1), img(CULT_G2)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'Sir Mutha Venkatasubba Rao Concert Hall', addressLine1: 'Greenways Road, R. A. Puram', addressLine2: '', city: 'Chennai', state: 'Tamil Nadu', country: 'India', pincode: '600028', mapsLink: link('https://maps.google.com/?q=Music+Academy+Chennai'), instructions: 'Doors open at 5:30 PM on both evenings. No entry after the programme begins. Mobile phones must be on silent. Photography is not permitted during performances.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-12-20', startTime: '18:00', endDate: '2026-12-21', endTime: '22:30', doorsOpenTime: '17:30', agenda: [
      ses('2026-12-20', '17:30', '18:00', 'Doors Open & Seating',                    'session'),
      ses('2026-12-20', '18:00', '19:30', 'Carnatic Violin Recital — Dr Vijaylakshmi Iyer', 'keynote', 'Accompanied by Arjun Krishnamurthy on mridangam.'),
      ses('2026-12-20', '19:30', '19:45', 'Interval',                                'break', '', true),
      ses('2026-12-20', '19:45', '21:30', 'Hindustani Vocal Concert — Pandit Shivkumar Prasad', 'keynote'),
      ses('2026-12-21', '17:30', '18:00', 'Doors Open & Seating',                    'session'),
      ses('2026-12-21', '18:00', '19:00', 'Kathak Recital — Kavita Bhartiya',        'keynote'),
      ses('2026-12-21', '19:00', '19:15', 'Interval',                                'break', '', true),
      ses('2026-12-21', '19:15', '21:30', 'Jugalbandi — Pandit Prasad & Dr Iyer',   'keynote', 'A rare Hindustani–Carnatic collaboration.'),
      ses('2026-12-21', '21:30', '22:30', 'Backstage Meet & Greet (Premium Pass)',  'networking', 'Premium pass holders only.'),
    ] },
    organizer: baseOrg('Chennai Classical Arts Trust', 'hello@ragaandrhythm.in', '+91 44 2345 6789', 'https://ragaandrhythm.in', orgLogo('RR'), { instagram: 'https://instagram.com/ragaandrhythm', twitter: 'https://twitter.com/ragaandrhythm', hashtags: ['#RagaAndRhythm2026', '#ChennaiMusic'] }),
    communication: baseComm(),
    support:       baseSupport('support@ragaandrhythm.in', '+91 44 2345 6789', 'https://ragaandrhythm.in/faq'),
    seo:           baseSeo('raga-rhythm-classical-festival-2026', 'Raga & Rhythm Classical Music Festival 2026 — Chennai', 'Two evenings of Hindustani and Carnatic classical music in Chennai. Pandit Shivkumar Prasad, Dr Vijaylakshmi Iyer, and more.', ['classical music festival', 'chennai', 'hindustani music', 'carnatic concert', 'kathak', 'music festival']),
    publicPage:    basePublicPage(),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { artists: ev9Artists, programSchedule: 'Day 1 (20 Dec): Carnatic Violin 6–7:30 PM | Interval | Hindustani Vocal 7:45–9:30 PM\nDay 2 (21 Dec): Kathak 6–7 PM | Interval | Jugalbandi 7:15–9:30 PM | Meet & Greet (Premium)', entryRules: 'No entry after the programme begins. Latecomers will be seated during the first interval only. Children under 5 are not permitted. Photography and videography strictly prohibited.', ageRestriction: 'Recommended for ages 5 and above.' },
  }

  // ── EVENT 10: Innovate India Excellence Awards 2026 ───────────────────────

  const P10_DEL  = 'p10_del'
  const P10_VIP  = 'p10_vip'
  const P10_CORP = 'p10_corp'

  const ev10Passes = [
    pass(P10_DEL,  'Delegate',              3500,   ['Event Entry', 'Gala Dinner', 'Participation Certificate', 'Conference Bag']),
    pass(P10_VIP,  'VIP Table Seat',        15000,  ['Event Entry', 'VIP Lounge', 'Gala Dinner', 'Front Row Seating', 'Conference Bag', 'Speaker Meet & Greet'], null, 'Individual VIP seat. Includes cocktail hour access and post-ceremony lounge.'),
    pass(P10_CORP, 'Corporate Table of 10', 125000, ['Event Entry', 'VIP Lounge', 'Gala Dinner', 'Front Row Seating', 'Conference Bag', 'Speaker Meet & Greet', 'Brand Promotion'], 20, 'Reserved table for 10. Includes table branding, company logo in programme booklet, and pre-show photo opportunity.'),
  ]

  const ev10Sponsors = [
    spo('Tata Consultancy Services', spoLogo('TCS',        '2563eb'), 'https://tcs.com',        'title'),
    spo('HDFC Bank',                 spoLogo('HDFC Bank',  '004C8F'), 'https://hdfcbank.com',   'gold'),
    spo('Maruti Suzuki',             spoLogo('Maruti',     'E2001A'), 'https://marutisuzuki.com','gold'),
    spo('FICCI',                     spoLogo('FICCI',      '1a3a5c'), 'https://ficci.in',        'partner'),
    spo('The Economic Times',        spoLogo('ET',         'e8522b'), 'https://economictimes.com','media'),
  ]

  const ev10AwardCategories = [
    { id: uid(), name: 'Startup of the Year', description: 'Recognising the most innovative and fast-growing startup in India across all sectors.' },
    { id: uid(), name: 'Technology Innovation of the Year', description: 'Awarded to the product or solution that has most significantly disrupted its sector.' },
    { id: uid(), name: 'Sustainable Business Leader', description: 'Recognising a leader or organisation driving measurable environmental and social impact.' },
    { id: uid(), name: 'Digital Transformation Excellence', description: 'For the enterprise that best demonstrated transformation through technology adoption.' },
    { id: uid(), name: 'Woman Leader of the Year', description: 'Celebrating an outstanding woman in business, technology, or social entrepreneurship.' },
    { id: uid(), name: 'SME Challenger', description: 'Honouring the small or medium enterprise that has demonstrated the most remarkable growth trajectory.' },
  ]

  const ev10Details = {
    info:    { name: 'Innovate India Excellence Awards 2026', tagline: 'Celebrating the people and companies defining India\'s next chapter.', shortDesc: 'India\'s premier recognition platform for innovation, technology leadership, and sustainable business — hosted at The Leela Palace, New Delhi.', fullDesc: 'The Innovate India Excellence Awards celebrate the enterprises, entrepreneurs, and leaders who are writing India\'s most exciting story. Now in its 9th edition, the Awards have recognised over 200 organisations and individuals across 14 categories — and this year\'s event is the most ambitious yet.\n\nThe 2026 ceremony takes place in the Grand Ballroom of The Leela Palace, New Delhi — an evening of black-tie elegance, live entertainment, gala dinner, and the most coveted trophies in Indian business.\n\nSix award categories will be recognised this year, selected by an independent judging panel of 12 industry veterans through a rigorous three-stage evaluation process. Nominations open on 1 September 2026.\n\nDelegate passes include access to the pre-ceremony cocktail hour, the main ceremony, and the gala dinner. VIP and Corporate table passes include additional access to the VIP Lounge and the post-ceremony networking reception.', language: 'en', dressCode: 'Black tie / Formal Indian attire' },
    media:   { logo: img(orgLogo('IIEA')), coverBanner: img(AWARD_BANNER), bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1, galleryImages: [img(AWARD_G1)], promoVideoUrl: '' },
    venue:   { type: 'physical', physical: { name: 'The Leela Palace, New Delhi — Grand Ballroom', addressLine1: 'Diplomatic Enclave, Chanakyapuri', addressLine2: '', city: 'New Delhi', state: 'Delhi', country: 'India', pincode: '110023', mapsLink: link('https://maps.google.com/?q=The+Leela+Palace+New+Delhi'), instructions: 'Valet parking available at the hotel entrance. Metro: Chanakyapuri (Pink Line). Dress code is strictly enforced — black tie or formal Indian attire. ID required at check-in.', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } }, online: { platform: 'zoom', platformCustomName: '', meetingUrl: '', meetingId: '', passcode: '', revealAfterRegistration: true, joinInstructions: '' } },
    schedule:{ timezone: 'Asia/Kolkata', startDate: '2026-11-28', startTime: '18:00', endDate: '2026-11-28', endTime: '23:30', doorsOpenTime: '17:30', agenda: [
      ses('2026-11-28', '17:30', '18:30', 'Cocktail Reception & Red Carpet',         'networking'),
      ses('2026-11-28', '18:30', '18:45', 'Welcome Address',                          'keynote'),
      ses('2026-11-28', '18:45', '19:00', 'Keynote: Innovation as a National Agenda', 'keynote'),
      ses('2026-11-28', '19:00', '19:45', 'Awards: First Three Categories',           'session', 'Startup of the Year | Technology Innovation | Sustainable Business Leader'),
      ses('2026-11-28', '19:45', '20:30', 'Gala Dinner — Seated',                    'break', '', true),
      ses('2026-11-28', '20:30', '21:30', 'Awards: Final Three Categories',           'session', 'Digital Transformation | Woman Leader | SME Challenger'),
      ses('2026-11-28', '21:30', '22:00', 'Entertainment: Live Jazz Ensemble',        'session'),
      ses('2026-11-28', '22:00', '23:30', 'VIP Reception & Post-Ceremony Networking', 'networking', 'VIP and Corporate Table pass holders only.'),
    ] },
    organizer: baseOrg('India Business Excellence Forum', 'awards@ibef.in', '+91 11 4000 5000', 'https://ibef.in', orgLogo('IBEF'), { linkedin: 'https://linkedin.com/company/india-business-excellence-forum', instagram: 'https://instagram.com/ibef_awards', hashtags: ['#IIEAwards2026', '#InnovateIndia'] }),
    communication: baseComm(),
    support:       baseSupport('awards@ibef.in', '+91 11 4000 5000', 'https://ibef.in/faq', 'https://ibef.in/terms'),
    seo:           baseSeo('innovate-india-awards-2026', 'Innovate India Excellence Awards 2026 — New Delhi', 'India\'s premier innovation and business excellence awards ceremony at The Leela Palace, New Delhi. Gala dinner, 6 categories.', ['india awards 2026', 'startup awards', 'innovation awards', 'business excellence', 'new delhi gala']),
    publicPage:    basePublicPage({ showSpeakers: false }),
    integrations:  { webhookUrl: '', zapierWebhookUrl: '', googleAnalyticsId: '', metaPixelId: '' },
    typeDetails:   { categories: ev10AwardCategories, nominationRules: 'Nominations must be submitted online at ibef.in/nominations by 30 October 2026. Nominators must provide supporting documentation and a ≤300-word submission statement.', judgingProcess: 'Three-stage evaluation: initial screening by IBEF secretariat, blind scoring by 12-member independent jury, and final deliberation. All jury decisions are final and binding.', ceremonyFormat: 'Black-tie gala dinner ceremony. Six award categories. Entertainment by a live jazz ensemble. VIP reception follows the ceremony.' },
  }

  // ── Return all 10 ─────────────────────────────────────────────────────────

  return [
    {
      slug: 'bengaluru-tech-summit-2026',
      doc:  publishedEventDoc('bengaluru-tech-summit-2026', 'conference', 'tech', false, ev1Passes, ev1Details, 0),
      registrations: 312,
      passCounts: { [P1_DEL]: 240, [P1_WORK]: 52, [P1_VIP]: 20 },
    },
    {
      slug: 'mumbai-marathon-2027',
      doc:  publishedEventDoc('mumbai-marathon-2027', 'sports', 'marathon', false, ev2Passes, ev2Details, 0),
      registrations: 4820,
      passCounts: { [P2_5K]: 1800, [P2_10K]: 1600, [P2_HALF]: 900, [P2_FULL]: 520 },
    },
    {
      slug: 'full-stack-dev-bootcamp-2026',
      doc:  publishedEventDoc('full-stack-dev-bootcamp-2026', 'workshop', 'bootcamp', false, ev3Passes, ev3Details, 0),
      registrations: 27,
      passCounts: { [P3_EARL]: 20, [P3_GEN]: 7 },
    },
    {
      slug: 'india-startup-founders-conclave-2026',
      doc:  publishedEventDoc('india-startup-founders-conclave-2026', 'meetup', 'startup', true, ev4Passes, ev4Details, 0),
      registrations: 214,
      passCounts: { [P4_FREE]: 214 },
    },
    {
      slug: 'clean-coast-juhu-beach-drive-2026',
      doc:  publishedEventDoc('clean-coast-juhu-beach-drive-2026', 'community', 'awareness', true, ev5Passes, ev5Details, 0),
      registrations: 387,
      passCounts: { [P5_VOL]: 312, [P5_SUPP]: 75 },
    },
    {
      slug: 'teach-for-change-ngo-summit-2026',
      doc:  publishedEventDoc('teach-for-change-ngo-summit-2026', 'community', 'ngo', true, ev6Passes, ev6Details, 0),
      registrations: 189,
      passCounts: { [P6_DEL]: 142, [P6_STU]: 47 },
    },
    {
      slug: 'run-for-a-smile-charity-5k-2026',
      doc:  publishedEventDoc('run-for-a-smile-charity-5k-2026', 'fundraising', 'charity_run', false, ev7Passes, ev7Details, 0),
      registrations: 1340,
      passCounts: { [P7_SUPP]: 780, [P7_CHAMP]: 420, [P7_HERO]: 140 },
    },
    {
      slug: 'india-fintech-expo-2026',
      doc:  publishedEventDoc('india-fintech-expo-2026', 'exhibition', 'tradeshow', false, ev8Passes, ev8Details, 0),
      registrations: 2640,
      passCounts: { [P8_VIS]: 2200, [P8_BIZ]: 380, [P8_EXH]: 60 },
    },
    {
      slug: 'raga-rhythm-classical-festival-2026',
      doc:  publishedEventDoc('raga-rhythm-classical-festival-2026', 'cultural', 'festival', false, ev9Passes, ev9Details, 0),
      registrations: 415,
      passCounts: { [P9_STD]: 290, [P9_PREM]: 125 },
    },
    {
      slug: 'innovate-india-awards-2026',
      doc:  publishedEventDoc('innovate-india-awards-2026', 'awards', 'awards_night', false, ev10Passes, ev10Details, 0),
      registrations: 680,
      passCounts: { [P10_DEL]: 480, [P10_VIP]: 160, [P10_CORP]: 40 },
    },
  ]
}

// ── 5. Seed runner ────────────────────────────────────────────────────────────

async function seed() {
  console.log('\n🌱  RegisterDesk — Demo Event Seeder')
  console.log('─'.repeat(50))

  const events = buildEvents()
  let seeded   = 0

  for (const ev of events) {
    try {
      const batch      = db.batch()
      const eventRef   = db.collection('events').doc(ev.slug)
      const counterRef = db.collection('registrationCounters').doc(ev.slug)

      const existingSnap = await eventRef.get()
      if (existingSnap.exists) {
        console.log(`  ⚠  Skipped (already exists): ${ev.slug}`)
        continue
      }

      batch.set(eventRef, {
        ...ev.doc,
        publishedAt: NOW,
        updatedAt:   NOW,
      })

      batch.set(counterRef, {
        eventSlug:  ev.slug,
        totalCount: ev.registrations,
        passCounts: ev.passCounts,
        updatedAt:  NOW,
      })

      await batch.commit()
      const eventType = (ev.doc as Record<string, unknown>).eventType
      console.log(`  ✓  ${ev.slug}  (${eventType})`)
      seeded++
    } catch (err) {
      console.error(`  ✗  Failed: ${ev.slug}`, err)
    }
  }

  console.log('─'.repeat(50))
  console.log(`\n✅  Seeded ${seeded} / ${events.length} events.\n`)

  if (seeded < events.length) {
    console.log('   Skipped events already exist in Firestore.')
    console.log('   To re-seed them, delete the existing documents first.\n')
  }
}

seed().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
