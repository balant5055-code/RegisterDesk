import { redirect } from 'next/navigation'
import ManageEventClient from './ManageEventClient'
import { isRetiredEventTab } from '@/lib/events/eventTabs'

// RD-EVENT-09 · The event workspace route.
//
// ═══ ONE SHELL, ONE LANDING ══════════════════════════════════════════════════
// This route used to render two entirely different chromes: with no `?tab=` it showed
// `EventOverviewClient`, which had its own page header, its own KPI cards and its own
// event fetch; with a tab it showed the workspace shell. Opening an event and then
// clicking Setup changed the whole frame around you, and the root paid for a second
// copy of an event the shell would fetch anyway.
//
// Now there is one shell for every view. No `?tab=` means the Event Command Center —
// the consolidated landing that replaced the old Home and Overview tabs.
//
// `?tab=home` and `?tab=overview` are retired but not broken: they redirect to the
// root so bookmarks, old emails and browser history keep working.

export default async function ManageEventPage({
  params,
  searchParams,
}: {
  params:       Promise<{ eventId: string }>
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { eventId } = await params
  const { tab }     = await searchParams

  const requestedTab = Array.isArray(tab) ? tab[0] : tab

  if (isRetiredEventTab(requestedTab)) {
    redirect(`/dashboard/events/${encodeURIComponent(eventId)}`)
  }

  return <ManageEventClient eventId={eventId} initialTab={requestedTab} />
}
