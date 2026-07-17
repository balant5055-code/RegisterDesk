'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Mail, Phone, FileText, ShieldCheck, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CommunityFAQProps {
  faqUrl?:           string
  supportEmail?:     string
  supportPhone?:     string
  termsUrl?:         string
  refundPolicyUrl?:  string
  privacyPolicyUrl?: string
}

// ─── FAQ data ──────────────────────────────────────────────────────────────────

const COMMUNITY_FAQS = [
  {
    q: 'Is this event free to attend?',
    a: 'Yes, this is a free community event. Simply register to secure your spot — no payment required. Some events may offer optional paid tiers for extra perks; check the registration section above.',
  },
  {
    q: 'Can I volunteer at this event?',
    a: 'Absolutely! We welcome community volunteers. Look out for volunteer information in the event details or contact the organiser directly using the details below to express your interest.',
  },
  {
    q: 'Is this event family-friendly?',
    a: 'Yes, this event is designed to be welcoming for people of all ages. Children are welcome when accompanied by a responsible adult. Specific age restrictions, if any, will be listed in the event description.',
  },
  {
    q: 'What should I bring on the day?',
    a: 'Please bring a photo ID and your registration confirmation (digital or printed). Additional items may be listed in the event description or in the confirmation email you receive after registering.',
  },
  {
    q: 'How will I know if the event is changed or cancelled?',
    a: 'You will receive an email notification to the address used at registration if the event is postponed, cancelled, or has any important updates. We recommend checking the event page for real-time updates.',
  },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function CommunityFAQ({
  faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
}: CommunityFAQProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  const hasContact  = !!(supportEmail || supportPhone)
  const hasPolicies = !!(termsUrl || refundPolicyUrl || privacyPolicyUrl)
  if (!faqUrl && !hasContact && !hasPolicies) return null

  const faqs = faqUrl ? COMMUNITY_FAQS : []

  return (
    <section id="faq" className="bg-slate-50 py-10 sm:py-14">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
            Support
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            Frequently Asked Questions
          </h2>
        </motion.div>

        <div className="grid gap-8 lg:grid-cols-[1fr_260px]">

          {/* Accordion */}
          {faqs.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45 }}
              className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100"
            >
              {faqs.map(({ q, a }, i) => (
                <div key={i}>
                  <button
                    type="button"
                    onClick={() => setOpenIdx(openIdx === i ? null : i)}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-white"
                  >
                    <span className="text-[0.9375rem] font-semibold text-gray-900">{q}</span>
                    <motion.span
                      animate={{ rotate: openIdx === i ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                      className="shrink-0"
                    >
                      <ChevronDown className="size-4 text-gray-400" aria-hidden />
                    </motion.span>
                  </button>

                  <AnimatePresence initial={false}>
                    {openIdx === i && (
                      <motion.div
                        key="content"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.25, 0, 0, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-gray-100 bg-white px-5 py-4">
                          <p className="text-sm leading-relaxed text-gray-600">{a}</p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </motion.div>
          )}

          {/* External FAQ link when no accordion */}
          {!faqs.length && faqUrl && (
            <a
              href={faqUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-base font-semibold text-primary hover:underline"
            >
              View Full FAQ
              <ArrowRight className="size-4" aria-hidden />
            </a>
          )}

          {/* Sidebar: contact + policies */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: 0.08 }}
            className="flex flex-col gap-5"
          >
            {(hasContact || faqUrl) && (
              <div className="rounded-2xl border border-gray-100 bg-white p-5">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">
                  Still have questions?
                </p>
                <div className="flex flex-col gap-2.5">
                  {faqUrl && (
                    <a
                      href={faqUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
                    >
                      <ArrowRight className="size-3.5" aria-hidden />
                      Visit Help Centre
                    </a>
                  )}
                  {supportEmail && (
                    <a
                      href={`mailto:${supportEmail}`}
                      className="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-primary"
                    >
                      <Mail className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                      {supportEmail}
                    </a>
                  )}
                  {supportPhone && (
                    <a
                      href={`tel:${supportPhone}`}
                      className="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-primary"
                    >
                      <Phone className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                      {supportPhone}
                    </a>
                  )}
                </div>
              </div>
            )}

            {hasPolicies && (
              <div className={cn('rounded-2xl border border-gray-100 bg-white p-5')}>
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">
                  Policies
                </p>
                <div className="flex flex-col gap-2">
                  {termsUrl && (
                    <a
                      href={termsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-primary"
                    >
                      <FileText className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                      Terms &amp; Conditions
                    </a>
                  )}
                  {refundPolicyUrl && (
                    <a
                      href={refundPolicyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-primary"
                    >
                      <FileText className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                      Refund Policy
                    </a>
                  )}
                  {privacyPolicyUrl && (
                    <a
                      href={privacyPolicyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-primary"
                    >
                      <ShieldCheck className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                      Privacy Policy
                    </a>
                  )}
                </div>
              </div>
            )}
          </motion.div>

        </div>

      </div>
    </section>
  )
}
