'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Mail, Phone, FileText, ShieldCheck, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ConferenceFAQProps {
  faqUrl:           string
  supportEmail:     string
  supportPhone:     string
  termsUrl:         string
  refundPolicyUrl:  string
  privacyPolicyUrl: string
}

// ─── FAQ data ──────────────────────────────────────────────────────────────────

const CONFERENCE_FAQS = [
  {
    q: 'How will I receive my registration confirmation?',
    a: 'You\'ll receive an email confirmation immediately after completing your registration. The email will include your ticket/QR code, event details, and any logistical information.',
  },
  {
    q: 'Is the event in-person, online, or hybrid?',
    a: 'Please check the event details at the top of this page for the format. If it\'s hybrid, you\'ll be asked to select your preferred mode during registration.',
  },
  {
    q: 'Can I transfer my pass to a colleague?',
    a: 'Pass transfers may be available depending on the organiser\'s policy. Please contact the organiser directly using the contact details below if you need to make a transfer.',
  },
  {
    q: 'Will sessions be recorded and available after the event?',
    a: 'Recording availability varies by session and organiser permission. Check the event communications or reach out to the organiser for details on post-event access.',
  },
  {
    q: 'Is there a group discount for multiple registrations?',
    a: 'Group discounts are typically available for 10 or more attendees from the same organisation. Contact the organiser directly to arrange group pricing.',
  },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceFAQ({ faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl }: ConferenceFAQProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  const hasContact  = !!(supportEmail || supportPhone)
  const hasPolicies = !!(termsUrl || refundPolicyUrl || privacyPolicyUrl)
  if (!faqUrl && !hasContact && !hasPolicies) return null

  const faqs = faqUrl ? CONFERENCE_FAQS : []

  return (
    <section id="faq" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-12"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Support</p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Frequently Asked Questions
          </h2>
        </motion.div>

        <div className="grid gap-10 lg:grid-cols-[1fr_280px]">

          {/* Accordion */}
          {faqs.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45 }}
              className="divide-y divide-gray-100 rounded-2xl border border-gray-100 overflow-hidden"
            >
              {faqs.map(({ q, a }, i) => (
                <div key={i}>
                  <button
                    type="button"
                    onClick={() => setOpenIdx(openIdx === i ? null : i)}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-gray-50"
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
                        <div className="border-t border-gray-100 bg-gray-50 px-5 py-4">
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
              <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5">
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
              <div className={cn('rounded-2xl border border-gray-100 bg-gray-50 p-5')}>
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
                      Terms & Conditions
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
