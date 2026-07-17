import { Suspense } from 'react'
import { UsageClient } from './UsageClient'

export const metadata = {
  title: 'Communication Usage — RegisterDesk',
}

export default function UsagePage() {
  return (
    <Suspense>
      <UsageClient />
    </Suspense>
  )
}
