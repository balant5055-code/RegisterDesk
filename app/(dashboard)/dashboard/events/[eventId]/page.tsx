import ManageEventClient from './ManageEventClient'

export default async function ManageEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return <ManageEventClient eventId={eventId} />
}
