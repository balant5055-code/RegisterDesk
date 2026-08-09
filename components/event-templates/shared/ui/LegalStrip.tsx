// LegalStrip — the permanent home for policy links, now a premium trust section.
// 100% Firestore-driven: each policy renders only when its URL exists; the whole
// section hides when there's nothing to show. Pure, framework-tokenised, reusable.
//
// RD-ST14.0 rework. This was a slim `BAND_PY` strip of `text-fs-sm text-muted-foreground`
// links separated by 1px dividers — visually identical to a site footer, sitting below
// the fold, with the same weight as "Contact Organizer". Terms, refunds and privacy are
// the three things a participant checks BEFORE paying, so reading as footer chrome was
// the whole problem.
//
// It is now three equal cards on the page's own card language — icon tile, title, a one
// line explanation of what the document covers, and a "View Policy" action — with the
// ENTIRE card as the link target rather than a ~90px text run.
//
// The helper descriptions are static UI labels describing what each document is. They
// assert nothing about the event, and they do not touch the legal content itself, which
// lives entirely at the organizer's URL and is never proxied, summarised or altered.
//
// This file has NO 'use client' and must keep it that way: the lift, shadow and arrow
// are pure CSS at the framework's own values, so the section ships zero JavaScript.

import Link from 'next/link'
import { ScrollText, Undo2, ShieldCheck, ArrowRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_PAD, GRID_GAP,
  ICON_TILE, ICON_TILE_ICON, type SectionBg,
} from '@/components/event-templates/shared/ui/framework'

const isExternal = (href: string) => /^https?:\/\//.test(href)

interface Policy {
  key:   string
  Icon:  LucideIcon
  title: string
  /** What the document covers — a label for the link, never a claim about the event. */
  desc:  string
  href:  string
}

export interface LegalStripProps {
  termsUrl?:         string
  refundPolicyUrl?:  string
  privacyPolicyUrl?: string
  contactHref?:      string
  contactLabel?:     string
  eyebrow?:          string
  title?:            string
  subtitle?:         string
  /** RD-ST5.2 P0.2 — band background, chosen by the template. Defaults to the previous value. */
  bg?:               SectionBg
}

// ── One policy ──────────────────────────────────────────────────────────────────
// The whole card is the link, so the target is the full card rather than a short text
// run — and keyboard users get one stop per policy instead of one per label.
function PolicyCard({ policy }: { policy: Policy }) {
  const external = isExternal(policy.href)
  return (
    <Link
      href={policy.href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      aria-label={`${policy.title} — view policy`}
      className={cn(
        CARD, CARD_PAD,
        'group flex h-full flex-col outline-none transition duration-150',
        'hover:-translate-y-[3px] hover:shadow-md motion-reduce:transform-none',
        'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
      )}
    >
      <span className={ICON_TILE} aria-hidden>
        <policy.Icon className={ICON_TILE_ICON} />
      </span>

      <h3 className={cn('mt-3.5', TYPE.cardTitle)}>{policy.title}</h3>
      <p className={cn('mt-1.5', TYPE.cardBody)}>{policy.desc}</p>

      <span className="mt-auto inline-flex items-center gap-1 pt-4 text-fs-sm font-semibold text-primary">
        View Policy
        <ArrowRight
          className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transform-none"
          aria-hidden
        />
      </span>
    </Link>
  )
}

export function LegalStrip({
  termsUrl, refundPolicyUrl, privacyPolicyUrl, contactHref, contactLabel = 'Contact Organizer',
  eyebrow = 'Policies', title = 'Terms & Policies', subtitle, bg = 'white',
}: LegalStripProps) {
  // Order is unchanged: Terms → Refund → Privacy, each present only when its URL is set.
  const policies: Policy[] = [
    termsUrl?.trim() && {
      key: 'terms', Icon: ScrollText, title: 'Terms & Conditions',
      desc: 'Participant rules and event conditions.', href: termsUrl.trim(),
    },
    refundPolicyUrl?.trim() && {
      key: 'refund', Icon: Undo2, title: 'Refund Policy',
      desc: 'Cancellation and refund information.', href: refundPolicyUrl.trim(),
    },
    privacyPolicyUrl?.trim() && {
      key: 'privacy', Icon: ShieldCheck, title: 'Privacy Policy',
      desc: 'How participant information is protected.', href: privacyPolicyUrl.trim(),
    },
  ].filter(Boolean) as Policy[]

  // A policies section with no policies would be a placeholder, so it hides entirely.
  // Contact is deliberately not enough to keep it alive — it is a subordinate action
  // here and already has a primary home in the Organizer section.
  if (policies.length === 0) return null

  const contact = contactHref?.trim()

  return (
    <SectionShell id="policies" bg={bg}>
      <EventSectionHeader eyebrow={eyebrow} title={title} description={subtitle} />

      <div className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', GRID_GAP)}>
        {policies.map(policy => <PolicyCard key={policy.key} policy={policy} />)}
      </div>

      {contact && (
        <div className="mt-8 text-center">
          <Link
            href={contact}
            {...(isExternal(contact) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className="inline-flex items-center gap-1.5 rounded text-fs-sm font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
          >
            {contactLabel}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      )}
    </SectionShell>
  )
}
