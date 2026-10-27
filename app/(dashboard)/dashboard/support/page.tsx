// RD-SUPPORT-01 · Support Center — the signed-in organizer's Help & Support. `useSearchParams`
// (?id=… opens a ticket, ?new=1 opens the form) requires the client tree to sit inside Suspense.

import { Suspense } from 'react'
import SupportCenterClient from './SupportCenterClient'

export default function SupportCenterPage() {
  return (
    <Suspense>
      <SupportCenterClient />
    </Suspense>
  )
}
