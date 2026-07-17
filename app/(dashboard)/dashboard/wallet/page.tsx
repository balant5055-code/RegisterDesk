import { Suspense } from 'react'
import { WalletOverviewClient } from './WalletOverviewClient'

export const metadata = {
  title: 'Wallet — RegisterDesk',
}

export default function WalletPage() {
  return (
    <Suspense>
      <WalletOverviewClient />
    </Suspense>
  )
}
