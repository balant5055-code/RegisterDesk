import ManageEventClient from './ManageEventClient'

export default async function ManageEventPage({
  params,
  searchParams,
}: {
  params:       Promise<{ eventId: string }>
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { eventId } = await params
  const { tab }     = await searchParams
  // Deep-link support (Phase H.4.2): the Command Palette can open a specific tab
  // via ?tab=<key>. Backward compatible — absent/invalid values fall back to Home.
  const initialTab = Array.isArray(tab) ? tab[0] : tab
  return <ManageEventClient eventId={eventId} initialTab={initialTab} />
}
