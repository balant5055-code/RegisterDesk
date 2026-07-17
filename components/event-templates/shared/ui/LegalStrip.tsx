// LegalStrip — the permanent home for policy links, a slim tokenized strip above the
// footer. 100% Firestore-driven: each link renders only when its URL exists; the whole
// strip hides when there's nothing to show. Pure, framework-tokenised, reusable.

import Link from 'next/link'

export interface LegalStripProps {
  termsUrl?:         string
  refundPolicyUrl?:  string
  privacyPolicyUrl?: string
  contactHref?:      string
  contactLabel?:     string
}

export function LegalStrip({
  termsUrl, refundPolicyUrl, privacyPolicyUrl, contactHref, contactLabel = 'Contact Organizer',
}: LegalStripProps) {
  const links = [
    termsUrl?.trim()         && { label: 'Terms',          href: termsUrl.trim() },
    refundPolicyUrl?.trim()  && { label: 'Refund Policy',  href: refundPolicyUrl.trim() },
    privacyPolicyUrl?.trim() && { label: 'Privacy Policy', href: privacyPolicyUrl.trim() },
    contactHref?.trim()      && { label: contactLabel,     href: contactHref.trim() },
  ].filter(Boolean) as { label: string; href: string }[]

  if (links.length === 0) return null

  return (
    <div className="border-t border-border/60 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-y-2 px-4 py-6 sm:px-6 lg:px-8">
        {links.map((l, i) => {
          const external = /^https?:\/\//.test(l.href)
          return (
            <span key={l.href} className="inline-flex items-center">
              {i > 0 && <span aria-hidden className="mx-4 h-3 w-px bg-border" />}
              <Link
                href={l.href}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {l.label}
              </Link>
            </span>
          )
        })}
      </div>
    </div>
  )
}
