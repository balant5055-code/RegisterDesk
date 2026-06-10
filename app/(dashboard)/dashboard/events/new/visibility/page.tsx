'use client'

import { useEffect }                  from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const DRAFT_KEY = 'rd_event_draft_id'

/**
 * Redirect relay for the event wizard entry point.
 *
 * All "Create Event" and "Edit Event" buttons in the dashboard point here.
 * When a draftId query param is present (edit / duplicate flow) we write it
 * to localStorage so the main wizard's useDraft hook loads that draft instead
 * of creating a blank one.  Then we replace the URL with the real wizard.
 */
export default function VisibilityRelay() {
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
