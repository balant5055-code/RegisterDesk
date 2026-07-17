'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Mail, Phone, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface FAQEntry { id: string; question: string; answer: string }

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalFAQProps {
  privacyPolicyUrl?: string
  entryRules?:      string
  ageRestriction?:  string
  programSchedule?: string
  faqUrl?:          string
  supportEmail?:    string
  supportPhone?:    string
  termsUrl?:        string
  refundPolicyUrl?: string
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

function buildFAQs(
  entryRules?: string,
  ageRestriction?: string,
): FAQEntry[] {
  return [
    {
      id:       'entry',
      question: 'What are the entry rules for the festival?',
      answer:   entryRules?.trim() ||
        'Tickets must be shown at entry (digital or printed). Carry a valid photo ID. Entry is subject to security checks. Re-entry is permitted within the same day with valid wristband.',
    },
    {
      id:       'age',
      question: 'Is there an age restriction?',
      answer:   ageRestriction?.trim() ||
        'The event is open to all ages. Children below 12 years must be accompanied by a parent or guardian at all times.',
    },
    {
      id:       'items',
      question: 'What items are not allowed inside the venue?',
      answer:   'Professional DSLR cameras, drones, outside food and beverages, alcohol, weapons, and laser pointers are not permitted. All bags are subject to security screening.',
    },
    {
      id:       'photo',
      question: 'Can I take photos and videos during performances?',
      answer:   'Personal photography and short video clips for social media are permitted. Professional recording equipment, tripods, and commercial filming require prior permission from the organiser.',
    },
    {
      id:       'refund',
      question: 'What is the refund or cancellation policy for tickets?',
      answer:   'Tickets are non-refundable once purchased unless the event is cancelled or rescheduled by the organiser. Please contact the organiser for transfer or exchange requests.',
    },
  ]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalFAQ({
  entryRules, ageRestriction,
  faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
}: CulturalFAQProps) {
  const items = buildFAQs(entryRules, ageRestriction)
  const [open, setOpen] = useState<string>(items[0]?.id ?? '')

  return (
    <section className="bg-gray-900 py-14 sm:py-18">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
            FAQ
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Frequently Asked Questions
          </h2>
        </motion.div>

        <div className="space-y-2">
          {items.map((item, i) => {
            const isOpen = open === item.id
            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: i * 0.05 }}
                className={cn(
                  'overflow-hidden rounded-xl border transition-all duration-200',
                  isOpen
                    ? 'border-amber-400/20 bg-amber-400/5'
                    : 'border-white/10 bg-gray-950 hover:border-white/20',
                )}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? '' : item.id)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  aria-expanded={isOpen}
                >
                  <span className={cn(
                    'text-[0.9375rem] font-semibold leading-snug',
                    isOpen ? 'text-amber-300' : 'text-white/80',
                  )}>
                    {item.question}
                  </span>
                  <ChevronDown className={cn(
                    'size-4.5 shrink-0 transition-transform duration-200',
                    isOpen ? 'rotate-180 text-amber-400' : 'text-white/30',
                  )} aria-hidden />
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="body"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.25, 0, 0, 1] }}
                    >
                      <p className="px-5 pb-4 text-[0.875rem] leading-relaxed text-white/50">
                        {item.answer}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}
        </div>

        {/* Contact + links */}
        {(supportEmail || supportPhone || faqUrl || termsUrl || refundPolicyUrl || privacyPolicyUrl) && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.38, delay: 0.1 }}
            className="mt-8 rounded-2xl border border-white/10 bg-gray-950 p-6"
          >
            <p className="mb-3 text-[0.875rem] font-bold text-white/60">
              Still have questions? Reach out to the organiser.
            </p>
            <div className="flex flex-wrap gap-3">
              {supportEmail && (
                <a
                  href={`mailto:${supportEmail}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[12.5px] font-semibold text-white/50 hover:border-amber-400/30 hover:text-amber-300"
                >
                  <Mail className="size-3.5" aria-hidden />
                  {supportEmail}
                </a>
              )}
              {supportPhone && (
                <a
                  href={`tel:${supportPhone}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[12.5px] font-semibold text-white/50 hover:border-amber-400/30 hover:text-amber-300"
                >
                  <Phone className="size-3.5" aria-hidden />
                  {supportPhone}
                </a>
              )}
              {faqUrl && (
                <a href={faqUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[12.5px] font-semibold text-white/50 hover:border-white/20">
                  Full FAQ <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {termsUrl && (
                <a href={termsUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[12.5px] font-semibold text-white/50 hover:border-white/20">
                  Terms <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {refundPolicyUrl && (
                <a href={refundPolicyUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[12.5px] font-semibold text-white/50 hover:border-white/20">
                  Refund Policy <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {privacyPolicyUrl && (
                <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[12.5px] font-semibold text-white/50 hover:border-white/20">
                  Privacy Policy <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>
          </motion.div>
        )}

      </div>
    </section>
  )
}
