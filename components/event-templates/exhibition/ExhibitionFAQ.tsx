'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Mail, Phone, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface FAQEntry {
  id:       string
  question: string
  answer:   string
  order:    number
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ExhibitionFAQProps {
  faqs?:           FAQEntry[]
  faqUrl?:         string
  supportEmail?:   string
  supportPhone?:   string
  termsUrl?:       string
  refundPolicyUrl?:  string
  privacyPolicyUrl?: string
}

// ─── Default FAQs ─────────────────────────────────────────────────────────────

const DEFAULTS: FAQEntry[] = [
  {
    id:       'reg',
    question: 'How do I register as a visitor?',
    answer:   'Click "Register to Visit" and choose the pass that fits your visit. You will receive a confirmation email with your entry pass and QR code.',
    order:    0,
  },
  {
    id:       'entry',
    question: 'What documents do I need at the entry gate?',
    answer:   'Please carry a valid government-issued photo ID and your digital or printed entry pass with QR code for quick scanning at the gate.',
    order:    1,
  },
  {
    id:       'parking',
    question: 'Is parking available at the venue?',
    answer:   'Yes, paid parking is available on-site. Shuttle services from overflow parking areas will also operate throughout the event days.',
    order:    2,
  },
  {
    id:       'exhibit',
    question: 'Can I book a meeting with an exhibitor in advance?',
    answer:   'Yes, after registration you can use the online meeting scheduler to book one-on-one meetings with exhibitors. Check the exhibitor listing for participating companies.',
    order:    3,
  },
  {
    id:       'refund',
    question: 'What is the refund policy for paid passes?',
    answer:   'Paid passes are refundable up to 7 days before the event. Please check the refund policy page for full details or contact the organiser.',
    order:    4,
  },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionFAQ({
  faqs = [], faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
}: ExhibitionFAQProps) {
  const items = faqs.length > 0 ? faqs : DEFAULTS
  const [open, setOpen] = useState<string>(items[0]?.id ?? '')

  return (
    <section className="bg-white py-14 sm:py-18">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            FAQ
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Frequently Asked Questions
          </h2>
        </motion.div>

        {/* Accordion */}
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
                  isOpen ? 'border-teal-200 bg-teal-50/30' : 'border-gray-100 bg-gray-50 hover:border-gray-200',
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
                    isOpen ? 'text-teal-700' : 'text-gray-800',
                  )}>
                    {item.question}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-4.5 shrink-0 transition-transform duration-200',
                      isOpen ? 'rotate-180 text-teal-500' : 'text-gray-400',
                    )}
                    aria-hidden
                  />
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
                      <p className="px-5 pb-4 text-[0.875rem] leading-relaxed text-gray-600">
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
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.38, delay: 0.1 }}
          className="mt-8 rounded-2xl border border-gray-100 bg-gray-50 p-6"
        >
          <p className="mb-3 text-[0.875rem] font-bold text-gray-700">
            Still have questions? Contact the organiser.
          </p>
          <div className="flex flex-wrap gap-3">
            {supportEmail && (
              <a
                href={`mailto:${supportEmail}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:border-teal-300 hover:text-teal-700"
              >
                <Mail className="size-3.5" aria-hidden />
                {supportEmail}
              </a>
            )}
            {supportPhone && (
              <a
                href={`tel:${supportPhone}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:border-teal-300 hover:text-teal-700"
              >
                <Phone className="size-3.5" aria-hidden />
                {supportPhone}
              </a>
            )}
            {faqUrl && (
              <a
                href={faqUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:border-gray-300"
              >
                Full FAQ
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {termsUrl && (
              <a
                href={termsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:border-gray-300"
              >
                Terms &amp; Conditions
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {refundPolicyUrl && (
              <a
                href={refundPolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:border-gray-300"
              >
                Refund Policy
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {privacyPolicyUrl && (
              <a
                href={privacyPolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:border-gray-300"
              >
                Privacy Policy
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </div>
        </motion.div>

      </div>
    </section>
  )
}
