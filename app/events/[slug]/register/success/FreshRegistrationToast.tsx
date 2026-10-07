'use client'

// The success "popper" — a one-shot acknowledgement fired when the attendee lands here
// straight from a completed registration.
//
// ═══ WHY A TOAST AND NOT A MODAL ═════════════════════════════════════════════
// The page below is already the success page. A blocking dialog would put a dismiss
// click between the attendee and the ticket they just paid for. This reuses the
// platform's existing toast system (components/ui/Toast) rather than introducing a
// second notification pattern — same chip, same motion, same live-region routing.
//
// ═══ WHY IT DOES NOT FIRE ON A BOOKMARK ══════════════════════════════════════
// It fires only for `?fresh=1`, which RegisterClient adds on the post-registration
// redirect. The flag is then STRIPPED from the URL with history.replaceState, so:
//   • a refresh does not re-announce a registration that happened minutes ago
//   • a bookmark or copied link taken after load carries no flag at all
//   • the back/forward entry is replaced, not pushed — no extra history step
// The flag is presentation-only; it gates nothing and grants nothing.

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useToast } from '@/components/ui/Toast'
import { CornerCannons } from '@/components/auth/ConfettiBurst'

/** How long the confetti layer stays mounted — the longest piece lands in ~3.5s. */
const CELEBRATE_MS = 4200

export function FreshRegistrationToast({
  ticketCode, isPending, celebrate = false,
}: {
  ticketCode: string
  isPending:  boolean
  /**
   * 2026-10-06 (owner: "add a popper when the registration is success"). Fire the corner
   * confetti alongside the toast — ONLY for a CONFIRMED registration (the page passes
   * `status === 'confirmed'`), only on the same one-shot `?fresh=1` arrival, and never
   * under prefers-reduced-motion. A refresh or bookmark never re-fires it.
   */
  celebrate?: boolean
}) {
  const { showToast } = useToast()
  const reduceMotion = useReducedMotion() ?? false
  const [burst, setBurst] = useState(false)
  // React 18/19 mounts effects twice in dev StrictMode; without this the toast doubles.
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return

    const url = new URL(window.location.href)
    if (url.searchParams.get('fresh') !== '1') return

    fired.current = true
    const pop = celebrate && !reduceMotion

    // Consume the flag before announcing, so an immediate refresh is already clean.
    url.searchParams.delete('fresh')
    window.history.replaceState(null, '', url.pathname + url.search)

    // Complements the page hero rather than repeating it: the hero states the outcome,
    // this hands over the one detail the attendee needs at the gate.
    showToast(
      isPending
        ? 'We have your registration — you will hear from the organiser soon.'
        : `Your ticket is ready · ${ticketCode}`,
      'success',
      { title: isPending ? 'Registration received' : 'Registration successful' },
    )
    // Next frame, not synchronously in the effect. Deliberately NOT cancelled on cleanup:
    // StrictMode's re-run returns early on `fired`, so cancelling here would mean the
    // confetti never fires in dev. A late setState after unmount is a no-op.
    if (pop) requestAnimationFrame(() => setBurst(true))
  }, [showToast, ticketCode, isPending, celebrate, reduceMotion])

  // Unmount the confetti layer once the pieces have landed.
  useEffect(() => {
    if (!burst) return
    const t = setTimeout(() => setBurst(false), CELEBRATE_MS)
    return () => clearTimeout(t)
  }, [burst])

  return burst ? <CornerCannons seed={7} /> : null
}
