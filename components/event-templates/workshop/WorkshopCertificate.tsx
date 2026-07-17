'use client'

import { motion } from 'framer-motion'
import { Award, CheckCircle2, FileText } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopCertificateProps {
  eventTitle: string
}

// ─── Component ─────────────────────────────────────────────────────────────────

const CRITERIA = [
  'Attend at least 80% of the sessions',
  'Complete all hands-on assignments and exercises',
  'Submit the final project (if applicable)',
  'Pass the end-of-workshop assessment (if applicable)',
]

export function WorkshopCertificate({ eventTitle }: WorkshopCertificateProps) {
  return (
    <section className="bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        <div className="grid items-center gap-8 lg:grid-cols-[1fr_380px]">

          {/* Left — Info */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.1 }}
              transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
            >
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">
                Certificate
              </p>
              <h2 className="mb-2 text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
                Certificate of Completion
              </h2>
              <p className="mb-6 text-[0.9375rem] leading-relaxed text-gray-500">
                Earn a certificate that validates your skills and commitment.
                Share it on LinkedIn or include it in your portfolio.
              </p>

              <h3 className="mb-3 text-[13px] font-bold text-gray-700">Eligibility Criteria</h3>
              <ul className="flex flex-col gap-2">
                {CRITERIA.map((c, i) => (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: i * 0.06 }}
                    className="flex items-start gap-2.5 text-[0.875rem] text-gray-600"
                  >
                    <CheckCircle2 className="mt-[1px] size-4 shrink-0 text-blue-400" aria-hidden />
                    {c}
                  </motion.li>
                ))}
              </ul>
            </motion.div>
          </div>

          {/* Right — Certificate preview */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <div className="relative overflow-hidden rounded-2xl border-2 border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-6 shadow-md shadow-blue-100/50">
              {/* Decorative corner lines */}
              <div className="absolute left-3 top-3 size-4 border-l-2 border-t-2 border-blue-300 rounded-tl-sm" />
              <div className="absolute right-3 top-3 size-4 border-r-2 border-t-2 border-blue-300 rounded-tr-sm" />
              <div className="absolute bottom-3 left-3 size-4 border-b-2 border-l-2 border-blue-300 rounded-bl-sm" />
              <div className="absolute bottom-3 right-3 size-4 border-b-2 border-r-2 border-blue-300 rounded-br-sm" />

              <div className="flex flex-col items-center py-4 text-center">
                <Award className="mb-3 size-10 text-blue-400" aria-hidden />
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-blue-400">
                  Certificate of Completion
                </p>
                <p className="mt-3 text-[11px] font-medium text-gray-500">This certifies that</p>
                <div className="my-2 h-px w-24 border-b border-dashed border-blue-300" />
                <p className="text-[11.5px] italic text-gray-400">Your Name</p>
                <div className="my-2 h-px w-24 border-b border-dashed border-blue-300" />
                <p className="text-[11px] font-medium text-gray-500">has successfully completed</p>
                <p className="mt-1.5 text-[0.875rem] font-black text-gray-800 line-clamp-2">
                  {eventTitle}
                </p>
                <div className="mt-4 flex items-center gap-1.5 text-[10px] text-blue-500">
                  <FileText className="size-3" aria-hidden />
                  Verified by RegisterDesk
                </div>
              </div>
            </div>
          </motion.div>

        </div>
      </div>
    </section>
  )
}
