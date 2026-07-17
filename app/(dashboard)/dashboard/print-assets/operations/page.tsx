import { Suspense } from 'react'
import { PrintOpsClient } from './PrintOpsClient'

export const metadata = {
  title: 'Print Operations Center — RegisterDesk',
}

export default function PrintOperationsPage() {
  return (
    <Suspense>
      <PrintOpsClient />
    </Suspense>
  )
}
