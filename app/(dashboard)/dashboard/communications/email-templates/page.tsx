import { Suspense } from 'react'
import { EmailTemplatesClient } from './EmailTemplatesClient'

export const metadata = {
  title: 'Email Templates — RegisterDesk',
}

export default function EmailTemplatesPage() {
  return (
    <Suspense>
      <EmailTemplatesClient />
    </Suspense>
  )
}
