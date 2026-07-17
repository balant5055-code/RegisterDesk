// Phase P.1.3 — Marketing icon registry.
//
// ONE icon language for the marketing site (lucide-react, the app-wide library).
// Content registries reference icons by key (string), never by importing lucide
// directly — so content stays data, not code. SDK-free, presentation config only.

import type { LucideIcon } from 'lucide-react'
import {
  Ticket, CreditCard, ScanLine, IdCard, CalendarClock, Award, Users, Mail,
  Wallet, Banknote, BarChart3, Plug, Webhook, ShieldCheck, Globe, Building2,
  Trophy, GraduationCap, HeartHandshake, Megaphone, Lock, Zap, FileCheck2,
  LayoutDashboard, QrCode, Repeat, Landmark, ReceiptText, Network,
} from 'lucide-react'

export const MARKETING_ICONS = {
  registration:  Ticket,
  payments:      CreditCard,
  checkin:       ScanLine,
  qr:            QrCode,
  identifier:    IdCard,
  sessions:      CalendarClock,
  certificates:  Award,
  crm:           Users,
  communications: Mail,
  broadcast:     Megaphone,
  wallet:        Wallet,
  settlements:   Banknote,
  finance:       Landmark,
  reports:       BarChart3,
  api:           Plug,
  webhooks:      Webhook,
  integrations:  Network,
  security:      ShieldCheck,
  lock:          Lock,
  domains:       Globe,
  corporate:     Building2,
  sports:        Trophy,
  education:     GraduationCap,
  fundraiser:    HeartHandshake,
  workspace:     LayoutDashboard,
  reuse:         Repeat,
  invoice:       ReceiptText,
  verify:        FileCheck2,
  fast:          Zap,
} as const satisfies Record<string, LucideIcon>

export type MarketingIconKey = keyof typeof MARKETING_ICONS

/** Canonical icon sizes for marketing (Tailwind classes only). */
export const ICON_SIZE = {
  inline: 'size-4',
  card:   'size-5',
  tile:   'size-6',
  hero:   'size-8',
} as const
export type IconSize = keyof typeof ICON_SIZE
