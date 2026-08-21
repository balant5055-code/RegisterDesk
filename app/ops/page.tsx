// /ops — RD-CHECKIN-STAFF-01
//
// The landing page for a gate operator who arrives without an event.
//
// It deliberately does NOT list events. A gate-only role holds `checkin` and
// nothing else — it cannot read the organizer events endpoint, and inventing a
// listing for it would mean widening exactly the permission this work narrowed.
// An operator is given a link to their gate; this page says so when they arrive
// without one.

export const metadata = {
  title: 'Check-in',
  robots: { index: false, follow: false },
}

export default function OpsIndexPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        RegisterDesk
      </p>
      <h1 className="text-fs-lg font-semibold text-foreground">Check-in console</h1>
      <p className="text-fs-sm text-muted-foreground">
        Open the check-in link your organizer shared with you to start scanning.
      </p>
    </main>
  )
}
