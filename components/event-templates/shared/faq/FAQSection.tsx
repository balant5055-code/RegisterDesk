'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Mail, Phone, FileText, ShieldCheck, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'

export function FAQSection({ faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl }: {
  faqUrl:           string
  supportEmail:     string
  supportPhone:     string
  termsUrl:         string
  refundPolicyUrl:  string
  privacyPolicyUrl: string
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const hasContact  = supportEmail || supportPhone
  const hasPolicies = termsUrl || refundPolicyUrl || privacyPolicyUrl
  if (!faqUrl && !hasContact && !hasPolicies) return null

  const genericFaqs = faqUrl ? [
    { q: 'How do I receive my confirmation?', a: 'You will receive an email confirmation at the address provided during registration within a few minutes of completing your registration.' },
    { q: 'Can I transfer my registration to someone else?', a: 'Transfer policies depend on the organizer. Please contact the organizer directly using the contact details below.' },
    { q: 'What is the refund policy?', a: refundPolicyUrl ? undefined : 'Please contact the organizer for information about refunds and cancellations.' },
    { q: 'Is there an on-site registration option?', a: 'Please check with the organizer for on-site registration availability.' },
  ].filter(({ a }) => a !== undefined) as { q: string; a: string }[] : []

  return (
    <SectionWrapper id="faq" title="FAQ">
      {genericFaqs.length > 0 && (
        <div className="mb-5 divide-y divide-border/40 rounded-xl border border-border overflow-hidden">
          {genericFaqs.map(({ q, a }, i) => (
            <div key={i}>
              <button
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
                className="flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-muted/30"
              >
                <span className="text-sm font-medium text-foreground">{q}</span>
                {openIdx === i
                  ? <ChevronUp   className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  : <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
              </button>
              {openIdx === i && (
                <div className="border-t border-border/40 bg-muted/20 px-4 py-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">{a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {faqUrl && (
        <a
          href={faqUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          View All FAQs
          <ArrowRight className="size-3.5" aria-hidden />
        </a>
      )}

      {hasContact && (
        <div className={cn('flex flex-wrap gap-4', faqUrl && 'mt-4 border-t border-border/40 pt-4')}>
          {supportEmail && (
            <a href={`mailto:${supportEmail}`}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary">
              <Mail className="size-3.5 shrink-0" aria-hidden />{supportEmail}
            </a>
          )}
          {supportPhone && (
            <a href={`tel:${supportPhone}`}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary">
              <Phone className="size-3.5 shrink-0" aria-hidden />{supportPhone}
            </a>
          )}
        </div>
      )}

      {hasPolicies && (
        <div className={cn('flex flex-wrap gap-2', (faqUrl || hasContact) && 'mt-4 border-t border-border/40 pt-4')}>
          {termsUrl && (
            <a href={termsUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-primary">
              <FileText className="size-2.5 shrink-0" aria-hidden />Terms & Conditions
            </a>
          )}
          {refundPolicyUrl && (
            <a href={refundPolicyUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-primary">
              <FileText className="size-2.5 shrink-0" aria-hidden />Refund Policy
            </a>
          )}
          {privacyPolicyUrl && (
            <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-primary">
              <ShieldCheck className="size-2.5 shrink-0" aria-hidden />Privacy Policy
            </a>
          )}
        </div>
      )}
    </SectionWrapper>
  )
}
