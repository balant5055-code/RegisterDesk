// Phase P.3 — /solutions/* page content (CONFIG ONLY).
//
// Vertical solution pages, built from REAL platform capabilities (grounded in the
// SOLUTIONS registry). Reuses the platform framework's section item types. No
// fake data, no placeholder copy.

import type {
  PlatformHeroConfig, PlatformCtaConfig,
  PlatformCapabilityItem, PlatformHighlightItem, PlatformUseCaseItem,
} from '@/lib/marketing/platform/types'

interface SectionHeader { eyebrow?: string; title: string; subtitle?: string }

export interface SolutionPageConfig {
  slug:            string
  breadcrumbLabel: string
  seo:             { title: string; description: string }
  hero:            PlatformHeroConfig
  showcase:        SectionHeader & { screenshotId: string; highlights?: PlatformHighlightItem[] }
  capabilities:    SectionHeader & { items: PlatformCapabilityItem[] }
  useCases:        SectionHeader & { items: PlatformUseCaseItem[] }
  cta:             PlatformCtaConfig
}

const STD_CTA = (headline: string, subheadline: string): PlatformCtaConfig => ({
  headline, subheadline, primaryCta: 'startFree', secondaryCta: 'bookDemo',
})

export const SOLUTION_PAGES: Record<string, SolutionPageConfig> = {
  sports: {
    slug: 'sports', breadcrumbLabel: 'Sports & Marathons',
    seo: {
      title:       'Sports & Marathons | RegisterDesk',
      description: 'Run races and sporting events end to end — bib identifiers, per-category management, offline gate check-in, and finisher certificates.',
    },
    hero: {
      eyebrow: 'Sports & Marathons', headline: 'Run races and sporting events end to end',
      subheadline: 'Register athletes, assign bibs, check them in at the gate even offline, and issue finisher certificates — all from one platform.',
      primaryCta: 'startFree', secondaryCta: 'bookDemo', screenshotId: 'identifier-center',
    },
    showcase: {
      eyebrow: 'Built for race day', title: 'From bib assignment to finisher certificates',
      subtitle: 'Everything a race needs, connected end to end.', screenshotId: 'checkin',
      highlights: [
        { iconKey: 'identifier',   title: 'Bib identifiers',     description: 'Assign bib numbers from the identifier engine.' },
        { iconKey: 'checkin',      title: 'Offline gate check-in', description: 'Admit runners fast, even without a network.' },
        { iconKey: 'certificates', title: 'Finisher certificates', description: 'Issue certificates to finishers in bulk.' },
      ],
    },
    capabilities: {
      eyebrow: 'Capabilities', title: 'Everything a race needs',
      subtitle: 'Real platform capabilities, set up for sport.',
      items: [
        { iconKey: 'registration', title: 'Registration & payments', description: 'Collect entries with categories and secure checkout.' },
        { iconKey: 'identifier',   title: 'Bib assignment',         description: 'Assign and manage bib numbers per category.' },
        { iconKey: 'workspace',    title: 'Per-category management', description: 'Manage age groups, distances, and categories.' },
        { iconKey: 'checkin',      title: 'Offline check-in',       description: 'Fast QR check-in that works without a network.' },
        { iconKey: 'certificates', title: 'Finisher certificates',  description: 'Generate and deliver certificates to finishers.' },
      ],
    },
    useCases: {
      eyebrow: 'Use cases', title: 'For every kind of event',
      items: [
        { title: 'Marathons & runs',     description: 'Road races, fun runs, and timed events with bibs and categories.' },
        { title: 'Cycling & triathlons', description: 'Multi-category endurance events with offline gate check-in.' },
        { title: 'Sports tournaments',   description: 'Team and individual tournaments with participant management.' },
      ],
    },
    cta: STD_CTA('Run your next race on RegisterDesk.', 'Start free and set up your event in minutes.'),
  },

  conferences: {
    slug: 'conferences', breadcrumbLabel: 'Conferences',
    seo: {
      title:       'Conferences | RegisterDesk',
      description: 'Run multi-track conferences — sessions and agendas, delegate identifiers, per-session capacity, attendance, and certificates.',
    },
    hero: {
      eyebrow: 'Conferences', headline: 'Run multi-track conferences with ease',
      subheadline: 'Build agendas, manage sessions and capacity, hand out delegate identifiers, and track attendance — all connected to registration and payments.',
      primaryCta: 'startFree', secondaryCta: 'bookDemo', screenshotId: 'sessions',
    },
    showcase: {
      eyebrow: 'Built for delegates', title: 'Sessions, speakers, and delegates in one place',
      subtitle: 'Plan the agenda and run the day from one workspace.', screenshotId: 'sessions',
      highlights: [
        { iconKey: 'sessions',   title: 'Multi-track agendas', description: 'Build tracks, halls, and schedules.' },
        { iconKey: 'reports',    title: 'Per-session capacity', description: 'Cap and track enrolment per session.' },
        { iconKey: 'identifier', title: 'Delegate identifiers', description: 'Assign delegate IDs and badges.' },
      ],
    },
    capabilities: {
      eyebrow: 'Capabilities', title: 'Everything a conference needs',
      subtitle: 'Run the agenda and the audience together.',
      items: [
        { iconKey: 'registration', title: 'Registration & passes', description: 'Sell passes and collect delegate details.' },
        { iconKey: 'sessions',     title: 'Sessions & agenda',     description: 'Multi-track scheduling with capacity.' },
        { iconKey: 'identifier',   title: 'Delegate identifiers',  description: 'Assign delegate IDs and badges.' },
        { iconKey: 'checkin',      title: 'Session attendance',    description: 'Check delegates into sessions and tracks.' },
        { iconKey: 'certificates', title: 'Certificates',          description: 'Issue attendance certificates in bulk.' },
      ],
    },
    useCases: {
      eyebrow: 'Use cases', title: 'For every kind of conference',
      items: [
        { title: 'Tech & business',  description: 'Multi-track conferences with speakers and sponsors.' },
        { title: 'Academic',         description: 'Paper sessions, tracks, and delegate management.' },
        { title: 'Summits & forums', description: 'Curated events with controlled capacity.' },
      ],
    },
    cta: STD_CTA('Run your next conference on RegisterDesk.', 'Start free and build your agenda today.'),
  },

  schools: {
    slug: 'schools', breadcrumbLabel: 'Schools & Colleges',
    seo: {
      title:       'Schools & Colleges | RegisterDesk',
      description: 'Run campus events and fests — student registration, pass management, check-in, and participation certificates.',
    },
    hero: {
      eyebrow: 'Schools & Colleges', headline: 'Campus events, fests, and certificates',
      subheadline: 'Register students, manage passes, check participants in, and issue participation certificates — from one simple platform.',
      primaryCta: 'startFree', secondaryCta: 'bookDemo', screenshotId: 'certificates',
    },
    showcase: {
      eyebrow: 'Built for campus', title: 'Run campus events from sign-up to certificate',
      subtitle: 'Everything a fest or campus event needs.', screenshotId: 'certificates',
      highlights: [
        { iconKey: 'registration', title: 'Student registration',     description: 'Simple sign-up for students and guests.' },
        { iconKey: 'invoice',      title: 'Pass management',          description: 'Day passes and event passes per fest.' },
        { iconKey: 'certificates', title: 'Participation certificates', description: 'Issue certificates to participants in bulk.' },
      ],
    },
    capabilities: {
      eyebrow: 'Capabilities', title: 'Everything a campus event needs',
      subtitle: 'Simple to run, even for a student team.',
      items: [
        { iconKey: 'registration', title: 'Student registration',     description: 'Collect registrations with custom fields.' },
        { iconKey: 'invoice',      title: 'Pass management',          description: 'Sell or issue passes per event or day.' },
        { iconKey: 'checkin',      title: 'Check-in',                 description: 'Fast QR check-in at the gate.' },
        { iconKey: 'certificates', title: 'Participation certificates', description: 'Generate and deliver certificates.' },
        { iconKey: 'crm',          title: 'Participant CRM',          description: 'Keep a record of every participant.' },
      ],
    },
    useCases: {
      eyebrow: 'Use cases', title: 'For every campus event',
      items: [
        { title: 'College fests',        description: 'Cultural and technical fests with passes and check-in.' },
        { title: 'Workshops & seminars', description: 'Sign-ups, attendance, and completion certificates.' },
        { title: 'Sports days',          description: 'Inter-house and inter-college events with identifiers.' },
      ],
    },
    cta: STD_CTA('Run your next campus event on RegisterDesk.', 'Start free — no setup cost.'),
  },

  corporate: {
    slug: 'corporate', breadcrumbLabel: 'Corporate Events',
    seo: {
      title:       'Corporate Events | RegisterDesk',
      description: 'Run private corporate events — invite-only access, role-based team access, identifiers and check-in, and reports.',
    },
    hero: {
      eyebrow: 'Corporate Events', headline: 'Private events with controlled access',
      subheadline: 'Run invite-only corporate events with role-based team access, identifiers and check-in, and the reports your stakeholders need.',
      primaryCta: 'startFree', secondaryCta: 'bookDemo', screenshotId: 'event-home',
    },
    showcase: {
      eyebrow: 'Built for teams', title: 'Run private, invite-only corporate events',
      subtitle: 'Control who attends and who manages.', screenshotId: 'event-home',
      highlights: [
        { iconKey: 'lock',       title: 'Private events',       description: 'Invite-only events with controlled access.' },
        { iconKey: 'security',   title: 'Role-based team access', description: 'Scope what each team member can do.' },
        { iconKey: 'identifier', title: 'Identifiers & check-in', description: 'Badges and fast on-site check-in.' },
      ],
    },
    capabilities: {
      eyebrow: 'Capabilities', title: 'Everything a corporate event needs',
      subtitle: 'Controlled, reportable, and connected.',
      items: [
        { iconKey: 'lock',       title: 'Private / invite-only', description: 'Limit registration to invited guests.' },
        { iconKey: 'security',   title: 'Role-based team access', description: 'Admin, manager, check-in, and finance roles.' },
        { iconKey: 'identifier', title: 'Identifiers & badges',  description: 'Assign delegate IDs and badges.' },
        { iconKey: 'checkin',    title: 'On-site check-in',      description: 'Fast QR check-in at the venue.' },
        { iconKey: 'reports',    title: 'Reports & exports',     description: 'Attendance and registration reporting.' },
      ],
    },
    useCases: {
      eyebrow: 'Use cases', title: 'For every corporate event',
      items: [
        { title: 'Town halls & offsites',   description: 'Internal events with controlled access and check-in.' },
        { title: 'Product launches',        description: 'Invite-only launches with badges and reporting.' },
        { title: 'Partner & customer events', description: 'Curated guest lists with on-site check-in.' },
      ],
    },
    cta: STD_CTA('Run your next corporate event on RegisterDesk.', 'Start free with controlled access built in.'),
  },

  fundraisers: {
    slug: 'fundraisers', breadcrumbLabel: 'Fundraisers & NGOs',
    seo: {
      title:       'Fundraisers & NGOs | RegisterDesk',
      description: 'Run donation campaigns — secure payments, 80G receipts where configured, refund handling, and a donor CRM.',
    },
    hero: {
      eyebrow: 'Fundraisers & NGOs', headline: 'Donation campaigns with receipts',
      subheadline: 'Raise funds with secure payments, issue 80G receipts where configured, handle refunds, and keep a record of every donor.',
      primaryCta: 'startFree', secondaryCta: 'bookDemo', screenshotId: 'finance',
    },
    showcase: {
      eyebrow: 'Built for giving', title: 'Raise funds with receipts and donor records',
      subtitle: 'Everything a campaign needs to collect and account for donations.', screenshotId: 'finance',
      highlights: [
        { iconKey: 'fundraiser', title: 'Donation campaigns', description: 'Collect one-off and recurring donations.' },
        { iconKey: 'invoice',    title: '80G receipts',        description: 'Issue 80G tax receipts where configured.' },
        { iconKey: 'crm',        title: 'Donor CRM',           description: 'Keep a record of every donor.' },
      ],
    },
    capabilities: {
      eyebrow: 'Capabilities', title: 'Everything a fundraiser needs',
      subtitle: 'Collect, receipt, and account for every donation.',
      items: [
        { iconKey: 'fundraiser', title: 'Donation campaigns', description: 'Run campaigns with custom amounts.' },
        { iconKey: 'payments',   title: 'Secure payments',    description: 'Collect donations through secure checkout.' },
        { iconKey: 'invoice',    title: '80G receipts',        description: 'Issue 80G tax receipts where configured.' },
        { iconKey: 'reuse',      title: 'Refund handling',    description: 'Issue refunds for donations when needed.' },
        { iconKey: 'crm',        title: 'Donor CRM',           description: 'A record of every donor and contribution.' },
      ],
    },
    useCases: {
      eyebrow: 'Use cases', title: 'For every cause',
      items: [
        { title: 'Charity drives',        description: 'Collect donations with receipts and donor records.' },
        { title: 'NGO events',            description: 'Fundraising events with registration and payments.' },
        { title: 'Crowdfunding campaigns', description: 'Campaign pages with secure online giving.' },
      ],
    },
    cta: STD_CTA('Start your next campaign on RegisterDesk.', 'Start free and collect donations securely.'),
  },
}

export function getSolutionPage(slug: string): SolutionPageConfig | undefined {
  return SOLUTION_PAGES[slug]
}
