'use client'

// RD-AI-01 · Pipeline status.
//
// Reads `GET /api/organizer/ai/jobs`, which is already scoped to the caller's workspace
// server-side. The hook holds no credential and knows nothing about providers — it renders
// whatever the server admits to, which is how the UI stays honest when the answer is
// "nothing is configured".

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { EMPTY_QUEUE_SUMMARY, type AIPipelineStatusView } from '@/features/ai/types'

export interface AIPipelineStatusState {
  status:  AIPipelineStatusView
  loading: boolean
  error:   string | null
}

const UNKNOWN: AIPipelineStatusView = {
  configured: false,
  providers:  [],
  kinds:      [],
  summary:    EMPTY_QUEUE_SUMMARY,
}

export function useAiPipelineStatus(eventId?: string | null): AIPipelineStatusState {
  const { user, getToken } = useAuth()
  const [status,  setStatus]  = useState<AIPipelineStatusView>(UNKNOWN)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (user === undefined) return          // auth still resolving
    let cancelled = false

    const run = async () => {
      if (!user) { setLoading(false); return }
      try {
        const token = await getToken()
        if (cancelled || !token) return

        const query = eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''
        const res = await fetch(`/api/organizer/ai/jobs${query}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (cancelled) return
        if (!res.ok) throw new Error('Could not read the AI pipeline status.')

        const data = await res.json() as AIPipelineStatusView
        if (cancelled) return
        setStatus(data)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the AI pipeline status.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [user, getToken, eventId])

  return { status, loading, error }
}
