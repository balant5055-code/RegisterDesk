import { Suspense } from 'react'
import { RegistrationsClient } from './RegistrationsClient'

export default async function RegistrationsPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return (
    <Suspense>
      <RegistrationsClient eventId={eventId} />
    </Suspense>
  )
}
