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

import { useEffect, useRef } from 'react'
import { useToast } from '@/components/ui/Toast'

export function FreshRegistrationToast({
  ticketCode, isPending,
}: {
  ticketCode: string
  isPending:  boolean
}) {
  const { showToast } = useToast()
  // React 18/19 mounts effects twice in dev StrictMode; without this the toast doubles.
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return

    const url = new URL(window.location.href)
    if (url.searchParams.get('fresh') !== '1') return

    fired.current = true

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
  }, [showToast, ticketCode, isPending])

  return null
}
