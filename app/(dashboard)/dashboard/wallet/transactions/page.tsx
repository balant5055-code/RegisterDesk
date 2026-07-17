import { Suspense } from 'react'
import { TransactionsClient } from './TransactionsClient'

export const metadata = {
  title: 'Transactions — RegisterDesk',
}

export default function TransactionsPage() {
  return (
    <Suspense>
      <TransactionsClient />
    </Suspense>
  )
}
