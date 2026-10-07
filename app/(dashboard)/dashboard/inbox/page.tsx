import { Suspense } from 'react'
import { InboxClient } from './InboxClient'

export const metadata = {
  title: 'Inbox — RegisterDesk',
}

export default function InboxPage() {
  return (
    <Suspense>
      <InboxClient />
    </Suspense>
  )
}
