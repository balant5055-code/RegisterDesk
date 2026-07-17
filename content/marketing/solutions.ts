// Phase P.1.3 — Solutions / verticals content (real capabilities per vertical).

import type { SolutionItem } from '@/lib/marketing/types'

export const SOLUTIONS: SolutionItem[] = [
  { slug: 'marathons', iconKey: 'sports', title: 'Marathons & Sports', summary: 'Bibs, categories, offline check-in, and finisher certificates.',
    outcomes: ['Assign bibs with the identifier engine', 'Offline gate check-in', 'Finisher certificates', 'Per-category management'] },
  { slug: 'conferences', iconKey: 'sessions', title: 'Conferences', summary: 'Multi-track agendas, speakers, and session capacity.',
    outcomes: ['Tracks, halls & speakers', 'Per-session capacity', 'Session attendance', 'Delegate identifiers'] },
  { slug: 'workshops', iconKey: 'education', title: 'Workshops & Training', summary: 'Registrations, attendance, and completion certificates.',
    outcomes: ['Simple registration', 'Attendance tracking', 'Completion certificates', 'Participant CRM'] },
  { slug: 'exhibitions', iconKey: 'corporate', title: 'Exhibitions & Expos', summary: 'Exhibitor and visitor management for trade shows.',
    outcomes: ['Exhibitor directory', 'Visitor registration', 'Badge identifiers', 'On-site check-in'] },
  { slug: 'awards', iconKey: 'certificates', title: 'Awards & Ceremonies', summary: 'Nominations, shortlisting, and recognition certificates.',
    outcomes: ['Nomination intake', 'Shortlisting workflow', 'Guest registration', 'Certificates'] },
  { slug: 'fundraisers', iconKey: 'fundraiser', title: 'Fundraisers & NGOs', summary: 'Donation campaigns with receipts and 80G support.',
    outcomes: ['Donation campaigns', '80G receipts', 'Refund handling', 'Donor CRM'] },
  { slug: 'corporate', iconKey: 'corporate', title: 'Corporate Events', summary: 'Private events with team roles and controlled access.',
    outcomes: ['Private / invite-only events', 'Role-based team access', 'Identifiers & check-in', 'Reports & exports'] },
  { slug: 'schools', iconKey: 'education', title: 'Schools & Colleges', summary: 'Campus events, fests, and certificate issuance.',
    outcomes: ['Student registration', 'Pass management', 'Check-in', 'Participation certificates'] },
]
