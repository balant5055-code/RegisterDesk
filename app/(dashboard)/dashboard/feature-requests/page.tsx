// RD-FEATURE-REQ-01 · Request a Feature + My Requests. `useSearchParams` (?new=1 opens the form,
// ?id=… expands one request) requires the client tree to sit inside Suspense.

import { Suspense } from 'react'
import FeatureRequestsClient from './FeatureRequestsClient'

export default function FeatureRequestsPage() {
  return (
    <Suspense>
      <FeatureRequestsClient />
    </Suspense>
  )
}
