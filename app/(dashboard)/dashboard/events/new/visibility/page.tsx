'use client'

import { Suspense, useEffect }         from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const DRAFT_KEY = 'rd_event_draft_id'

export default function VisibilityRelay() {
  return (
    <Suspense>
      <VisibilityRelayContent />
    </Suspense>
  )
}

function VisibilityRelayContent() {
  const router       = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const draftId = searchParams.get('draftId')
    if (draftId) {
  localStorage.setItem(DRAFT_KEY, draftId)
    } else {
      localStorage.removeItem(DRAFT_KEY)
    }
    router.replace('/dashboard/events/new')
  }, [router, searchParams])

  return (
    <div className="flex min-h-full flex-col gap-5 pt-1" aria-busy="true" aria-label="Loading event wizard">
      <div className="h-4 w-36 animate-pulse rounded-lg bg-muted/50" />
      <div className="h-[76px] animate-pulse rounded-xl bg-muted/30" />
      <div className="mt-1 h-7 w-52 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-44 animate-pulse rounded-xl bg-muted/30" />
      <div className="h-32 animate-pulse rounded-xl bg-muted/30" />
    </div>
  )
}
