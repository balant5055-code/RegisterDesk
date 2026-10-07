import { Suspense } from 'react'
import { EventWalletClient } from './EventWalletClient'

export const metadata = {
  title: 'Event Wallet — RegisterDesk',
}

export default function WalletPage() {
  return (
    <Suspense>
      <EventWalletClient />
    </Suspense>
  )
}
