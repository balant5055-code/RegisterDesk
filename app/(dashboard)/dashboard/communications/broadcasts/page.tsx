import { Suspense } from 'react'
import { BroadcastsClient } from './BroadcastsClient'

export const metadata = {
  title: 'Broadcasts — RegisterDesk',
}

export default function BroadcastsPage() {
  return (
    <Suspense>
      <BroadcastsClient />
    </Suspense>
  )
}
