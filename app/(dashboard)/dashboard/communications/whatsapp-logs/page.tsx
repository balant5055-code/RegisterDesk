import { Suspense } from 'react'
import { WhatsAppLogsClient } from './WhatsAppLogsClient'

export const metadata = {
  title: 'WhatsApp Logs — RegisterDesk',
}

export default function WhatsAppLogsPage() {
  return (
    <Suspense>
      <WhatsAppLogsClient />
    </Suspense>
  )
}
