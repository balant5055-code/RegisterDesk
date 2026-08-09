// RD-MEDIA-03 · Media Studio workspace shell.
//
// Exists for ONE reason: to hold the workspace context above every Media Studio page. A
// layout does not unmount as the organizer moves between its children, so the active event,
// the selected gallery, the compression profile and the upload queue — including the `File`
// objects, which cannot be serialised and so could never be restored any other way —
// survive the walk from Import Media to Galleries and back.
//
// It adds NO navigation and NO chrome. Every route below it is unchanged.

import { Suspense, type ReactNode } from 'react'
import { MediaStudioProvider } from '@/features/media-studio/context/MediaStudioContext'

// The provider reads `?eventId=` via `useSearchParams`, which App Router requires to sit
// under a Suspense boundary.
export default function MediaStudioLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <MediaStudioProvider>{children}</MediaStudioProvider>
    </Suspense>
  )
}
