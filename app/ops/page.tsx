// /ops — RD-CHECKIN-STAFF-01
//
// A shell only, matching /ops/checkin/[eventId]/page.tsx. Which assignments this operator
// can open is resolved client-side against endpoints that authorize themselves; nothing is
// decided here. `metadata` lives in app/ops/layout.tsx (title + noindex) and already covers
// this route, so it is not repeated.

import OpsIndexClient from './OpsIndexClient'

export default function OpsIndexPage() {
  return <OpsIndexClient />
}
