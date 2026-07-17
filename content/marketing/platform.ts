// Phase P.1.3 — Platform modules content (real, shipped capabilities only).

import type { ModuleItem } from '@/lib/marketing/types'

export const PLATFORM_MODULES: ModuleItem[] = [
  { iconKey: 'registration', title: 'Registration & Ticketing', description: 'Custom forms, multiple passes, coupons, and waitlists.',
    bullets: ['Custom registration forms', 'Multiple pass types & pricing', 'Coupons & discount codes', 'Waitlist with promotion'] },
  { iconKey: 'payments', title: 'Payments', description: 'Online payments with capacity-safe checkout.',
    bullets: ['Razorpay-powered checkout', 'Automatic refunds on edge cases', 'Coupon-aware pricing', 'Walk-in cash / UPI capture'] },
  { iconKey: 'checkin', title: 'Check-in & Attendance', description: 'QR and manual check-in that works offline.',
    bullets: ['QR scan check-in', 'Offline check-in with sync', 'Attendee search', 'Live attendance stats'] },
  { iconKey: 'identifier', title: 'Identifier Engine', description: 'One engine for bibs, badges, delegate IDs, and more.',
    bullets: ['Auto or manual assignment', 'Pools, reserve, block, retire', 'Swap & release', 'Reuse policies & history'] },
  { iconKey: 'sessions', title: 'Sessions & Agenda', description: 'Multi-track conference scheduling with capacity.',
    bullets: ['Tracks, halls & speakers', 'Per-session capacity', 'Conflict detection', 'Session attendance'] },
  { iconKey: 'certificates', title: 'Certificates', description: 'Design, generate, email, and verify certificates.',
    bullets: ['Template builder', 'Bulk generation', 'Email delivery', 'Public verification'] },
  { iconKey: 'crm', title: 'CRM & Audience', description: 'A unified contact view across all your events.',
    bullets: ['Auto-built contacts', 'Tags & notes', 'Activity timeline', 'Lifetime value'] },
  { iconKey: 'communications', title: 'Communications', description: 'Email confirmations and broadcasts.',
    bullets: ['Transactional emails', 'Email broadcasts', 'Delivery logs', 'Reusable templates'] },
  { iconKey: 'finance', title: 'Finance & Payouts', description: 'Revenue, fees, wallet, and settlements in one place.',
    bullets: ['Revenue & fee breakdown', 'Wallet & usage', 'Settlement requests', 'Payouts to bank / UPI'] },
  { iconKey: 'api', title: 'Developer API & Webhooks', description: 'Build on RegisterDesk with keys and webhooks.',
    bullets: ['Scoped API keys', 'Signed webhooks', 'Registration & donation reads', 'Retry-safe delivery'] },
]
