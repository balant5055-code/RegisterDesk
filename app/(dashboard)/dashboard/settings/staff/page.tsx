// /dashboard/settings/staff — RD-TEAM-IMPL-01
//
// Staff management moved to /dashboard/settings/team, which IS staff management now
// that the email-invitation flow is gone. Two surfaces for one concept was the split
// the audit flagged: the sidebar linked only Team, while the credential screen lived
// somewhere an organizer had to already know about.
//
// This redirect stays rather than the route being deleted: the path is in browser
// history, in the Settings index card, and possibly in a bookmark, and a 404 there
// would look like the feature was removed. `redirect()` issues a real 307, so no
// stale UI is served.

import { redirect } from 'next/navigation'

export default function StaffAccountsMoved() {
  redirect('/dashboard/settings/team')
}
