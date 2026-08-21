// /ops/checkin/[eventId] — RD-CHECKIN-STAFF-01
//
// The dedicated event-day gate surface for `checkin_staff`.
//
// This file is only a shell. It deliberately performs NO authorization of its own:
// `middleware.ts` cannot verify a Firebase ID token on the Edge runtime (see the
// note in that file), so the repo's established pattern — the same one
// app/(admin)/layout.tsx uses — is to render a shell that calls a Node route
// handler with a Bearer token and shows nothing until that call succeeds.
//
// The authorization lives in GET /api/checkin/ops/[eventId] and in every check-in
// route the client subsequently calls. Each one independently re-runs
// authorizeEvent, so this page cannot leak an event by being reached directly.

import OpsCheckinClient from './OpsCheckinClient'

export default async function OpsCheckinPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return <OpsCheckinClient eventId={eventId} />
}
