'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Mail, Phone, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface FAQEntry { id: string; question: string; answer: string }

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsFAQProps {
  privacyPolicyUrl?: string
  nominationRules?:  string
  judgingProcess?:   string
  faqUrl?:           string
  supportEmail?:     string
  supportPhone?:     string
  termsUrl?:         string
  refundPolicyUrl?:  string
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

function buildFAQs(nominationRules?: string, judgingProcess?: string): FAQEntry[] {
  return [
    {
      id:       'nominate',
      question: 'How do I nominate someone for an award?',
      answer:   nominationRules?.trim() ||
        'Nominations can be submitted through the official portal before the deadline. You may nominate yourself, your organisation, or a deserving candidate. Ensure all required information and supporting documents are included.',
    },
    {
      id:       'judging',
      question: 'How are winners selected?',
      answer:   judgingProcess?.trim() ||
        'An independent jury of domain experts evaluates all shortlisted nominations against pre-defined criteria including innovation, impact, scalability, and sustainability. Jury decisions are final and binding.',
    },
    {
      id:       'attend',
      question: "Can I attend the ceremony even if I'm not a nominee?",
      answer:   'Yes! The ceremony is open to all registered ticket holders. Tickets are available for General Attendees, VIP guests, and Corporate Tables. Register early as seats are limited.',
    },
    {
      id:       'announce',
      question: 'When will winners be announced?',
      answer:   'Winners will be revealed live at the ceremony. Finalists in select categories may be notified privately in advance, but results are officially announced at the event.',
    },
    {
      id:       'refund',
      question: 'What is the ticket refund or transfer policy?',
      answer:   'Tickets may be transferred to another guest up to 48 hours before the event. Refunds are available up to 14 days before the ceremony date. Please review the full refund policy for details.',
    },
  ]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsFAQ({
  nominationRules, judgingProcess,
  faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
}: AwardsFAQProps) {
  const items = buildFAQs(nominationRules, judgingProcess)
  const [open, setOpen] = useState<string>(items[0]?.id ?? '')

  return (
    <section className="bg-zinc-900 py-14 sm:py-20">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
          className="mb-10"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              FAQ
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
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
                transition={{ duration: 0.35, delay: i * 0.05 }}
                className={cn(
                  'overflow-hidden rounded-xl border transition-all duration-200',
                  isOpen
                    ? 'border-yellow-400/20 bg-yellow-400/4'
                    : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700',
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
                    isOpen ? 'text-yellow-300' : 'text-zinc-200',
                  )}>
                    {item.question}
                  </span>
                  <ChevronDown className={cn(
                    'size-4.5 shrink-0 transition-transform duration-200',
                    isOpen ? 'rotate-180 text-yellow-400' : 'text-zinc-600',
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
                      <p className="px-5 pb-4 text-[0.875rem] leading-relaxed text-zinc-400">
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
            transition={{ duration: 0.4, delay: 0.1 }}
            className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
          >
            <p className="mb-3 text-[0.875rem] font-bold text-zinc-400">
              More questions? Get in touch with the organiser.
            </p>
            <div className="flex flex-wrap gap-2.5">
              {supportEmail && (
                <a href={`mailto:${supportEmail}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[12.5px] font-semibold text-zinc-400 hover:border-yellow-400/20 hover:text-yellow-400">
                  <Mail className="size-3.5" aria-hidden />
                  {supportEmail}
                </a>
              )}
              {supportPhone && (
                <a href={`tel:${supportPhone}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[12.5px] font-semibold text-zinc-400 hover:border-yellow-400/20 hover:text-yellow-400">
                  <Phone className="size-3.5" aria-hidden />
                  {supportPhone}
                </a>
              )}
              {faqUrl && (
                <a href={faqUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[12.5px] font-semibold text-zinc-400 hover:border-zinc-700">
                  Full FAQ <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {termsUrl && (
                <a href={termsUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[12.5px] font-semibold text-zinc-400 hover:border-zinc-700">
                  Terms <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {refundPolicyUrl && (
                <a href={refundPolicyUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[12.5px] font-semibold text-zinc-400 hover:border-zinc-700">
                  Refund Policy <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {privacyPolicyUrl && (
                <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[12.5px] font-semibold text-zinc-400 hover:border-zinc-700">
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
