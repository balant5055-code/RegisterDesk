import { RegistrationsClient } from './RegistrationsClient'

export default async function RegistrationsPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return <RegistrationsClient eventId={eventId} />
}
