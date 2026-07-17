import { Suspense } from 'react'
import { EmailLogsClient } from './EmailLogsClient'

export const metadata = {
  title: 'Email Logs — RegisterDesk',
}

export default function EmailLogsPage() {
  return (
    <Suspense>
      <EmailLogsClient />
    </Suspense>
  )
}
