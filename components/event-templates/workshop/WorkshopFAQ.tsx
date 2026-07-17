'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Mail, Phone, ExternalLink } from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface FaqItem { q: string; a: string }

// ─── Workshop-specific FAQ defaults ───────────────────────────────────────────

const DEFAULTS: FaqItem[] = [
  {
    q: 'Will I receive a recording of the sessions?',
    a: 'Yes, recordings of all sessions will be shared with enrolled participants after each class. Access is available for a limited period post-workshop.',
  },
  {
    q: 'What happens if I miss a session?',
    a: 'All sessions are recorded and shared. You can catch up at your own pace. However, live participation is strongly recommended for the best experience.',
  },
  {
    q: 'Is there any hands-on practice included?',
    a: 'Yes, this workshop is project-based. You will work on real exercises and assignments throughout to apply what you learn.',
  },
  {
    q: 'What is the refund policy?',
    a: 'Refunds can be requested up to 48 hours before the workshop start date. Please contact the organiser for refund requests.',
  },
  {
    q: 'Will I get a certificate after completing the workshop?',
    a: 'Yes, participants who meet the attendance and assignment criteria will receive a verified Certificate of Completion.',
  },
]

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopFAQProps {
  privacyPolicyUrl?: string
  faqUrl?:          string
  supportEmail?:    string
  supportPhone?:    string
  termsUrl?:        string
  refundPolicyUrl?: string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopFAQ({
  faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
}: WorkshopFAQProps) {
  const [open, setOpen] = useState<number | null>(null)
  const hasContact = !!(supportEmail?.trim() || supportPhone?.trim())

  return (
    <section id="faq" className="bg-gray-50 py-12 sm:py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">FAQ</p>
          <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            Frequently Asked Questions
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.05 }}
          transition={{ duration: 0.4 }}
          className="overflow-hidden rounded-2xl border border-gray-100 bg-white"
        >
          {DEFAULTS.map((item, i) => (
            <div key={i} className={i < DEFAULTS.length - 1 ? 'border-b border-gray-50' : ''}>
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-gray-50 sm:px-6"
                aria-expanded={open === i}
              >
                <span className="text-[0.9rem] font-bold leading-snug text-gray-900">{item.q}</span>
                <motion.div
                  animate={{ rotate: open === i ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-100"
                >
                  <ChevronDown className="size-3.5 text-gray-500" aria-hidden />
                </motion.div>
              </button>

              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.25, 0, 0, 1] }}
                    className="overflow-hidden"
                  >
                    <p className="px-5 pb-4 text-[0.875rem] leading-relaxed text-gray-500 sm:px-6">
                      {item.a}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </motion.div>

        {/* Full FAQ link */}
        {faqUrl?.trim() && (
          <div className="mt-4 flex justify-center">
            <a href={faqUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700">
              View full FAQ
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </div>
        )}

        {/* Contact + policy links */}
        {(hasContact || termsUrl || refundPolicyUrl || privacyPolicyUrl) && (
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: 0.1 }}
            className="mt-5 rounded-2xl border border-gray-100 bg-white p-5"
          >
            <h3 className="mb-3 text-[13px] font-bold text-gray-800">Still have questions?</h3>
            <div className="flex flex-col gap-2">
              {supportEmail?.trim() && (
                <a href={`mailto:${supportEmail}`}
                  className="flex items-center gap-2 text-[0.875rem] text-gray-500 transition-colors hover:text-blue-600">
                  <Mail className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                  {supportEmail}
                </a>
              )}
              {supportPhone?.trim() && (
                <a href={`tel:${supportPhone}`}
                  className="flex items-center gap-2 text-[0.875rem] text-gray-500 transition-colors hover:text-blue-600">
                  <Phone className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                  {supportPhone}
                </a>
              )}
            </div>
            {(termsUrl || refundPolicyUrl || privacyPolicyUrl) && (
              <div className="mt-3 flex gap-4 border-t border-gray-100 pt-3">
                {termsUrl?.trim() && (
                  <a href={termsUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs font-semibold text-gray-400 hover:text-gray-600">
                    Terms &amp; Conditions
                  </a>
                )}
                {refundPolicyUrl?.trim() && (
                  <a href={refundPolicyUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs font-semibold text-gray-400 hover:text-gray-600">
                    Refund Policy
                  </a>
                )}
                {privacyPolicyUrl?.trim() && (
                  <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs font-semibold text-gray-400 hover:text-gray-600">
                    Privacy Policy
                  </a>
                )}
              </div>
            )}
          </motion.div>
        )}

      </div>
    </section>
  )
}
