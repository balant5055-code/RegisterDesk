// RD-RACEOPS-02C · Public result pages — on-demand cache invalidation.
//
// SERVER ONLY (imports next/cache). The four public result routes are ISR pages
// (`revalidate = 300`), which is the right fallback for a page nobody has changed. After
// a publish or a rollback the live version HAS changed, and a spectator refreshing the
// leaderboard must not see the previous one for up to five minutes.
//
// Only the affected pages are purged: the results landing (which lists this race), the
// event's results page, this race's leaderboard, and the runner pages of this race. The
// runner pages are a dynamic route with one instance per bib, and Next.js purges a dynamic
// route by its pattern (`'page'` type) rather than per instance — that is the narrowest
// purge the framework offers for them, and it stays within the public results routes.
// Nothing outside /results is touched; ISR remains the fallback for everything else.
//
// Called AFTER the state transition committed; a purge failure is logged, never fatal — the
// transition already happened and ISR will catch up.

import { revalidatePath } from 'next/cache'

export function revalidatePublicResults(eventSlug: string, passSlug: string): void {
  try {
    revalidatePath('/results')
    revalidatePath(`/results/${eventSlug}`)
    revalidatePath(`/results/${eventSlug}/${passSlug}`)
    revalidatePath('/results/[eventSlug]/[passSlug]/[bibNumber]', 'page')
  } catch (err) {
    console.error('[race-operations] public results revalidation failed', { eventSlug, passSlug, err })
  }
}
