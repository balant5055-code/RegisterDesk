'use client'

// Post-registration acknowledgement shown at the top of the ticket page.
//
// ═══ WHY A BANNER AND NOT A MODAL ════════════════════════════════════════════
// The registration flow already ends on a full success page
// (app/events/[slug]/register/success) with its own animated status icon. A modal or
// transition overlay here would be a SECOND success mechanism competing with that one —
// two places to keep in step, and a dialog the attendee has to dismiss before reaching
// the thing they came for. This is an acknowledgement, not an interruption.
//
// ═══ WHY IT IS OPT-IN ════════════════════════════════════════════════════════
// Rendered ONLY when the page is reached with `?success=1`. A ticket URL opened cold —
// from an email, a bookmark, or the gate queue six weeks later — shows no banner and is
// completely unaffected. The page never depends on a prior step having happened.
//
// Motion follows the conventions already used by the success page: framer-motion,
// useReducedMotion, soft fade + rise. No confetti, no bounce.

import { motion, useReducedMotion } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'

export function TicketSuccessBanner({ eventName }: { eventName: string }) {
  const reduce = useReducedMotion()

  return (
    <motion.div
      // role="status" + aria-live announces the outcome to a screen reader on arrival
      // without stealing focus, which a dialog would.
      role="status"
      aria-live="polite"
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="mb-6 overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/70 px-5 py-4 print:hidden"
    >
      <div className="flex items-start gap-3.5">
        <motion.span
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : 0.1, ease: [0.34, 1.4, 0.64, 1] }}
          className="mt-0.5 shrink-0"
        >
          <CheckCircle2 className="size-6 text-emerald-600" aria-hidden />
        </motion.span>

        <div className="min-w-0">
          <p className="text-[15px] font-bold leading-snug text-emerald-900">
            Registration successful
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-emerald-800/90">
            You&rsquo;re registered for <span className="font-semibold">{eventName}</span>.
            Your ticket is ready below &mdash; a copy has also been emailed to you.
          </p>
        </div>
      </div>
    </motion.div>
  )
}
