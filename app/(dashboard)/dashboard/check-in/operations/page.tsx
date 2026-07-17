import { Suspense } from 'react'
import { OperationsClient } from './OperationsClient'

export const metadata = {
  title: 'Check-in Operations Center — RegisterDesk',
  robots: { index: false, follow: false },
}

export default function CheckInOperationsPage() {
  return (
    <Suspense>
      <OperationsClient />
    </Suspense>
  )
}
