'use client'

// RD-AI-01 · AI pipeline status panel.
//
// Deliberately unglamorous. Its entire job is to say, truthfully, whether the AI pipeline
// can do anything — because the alternative an organizer would otherwise meet is a feature
// that looks available and silently does nothing.

import { Sparkles } from 'lucide-react'
import { Card } from '@/components/ui'
import { useAiPipelineStatus } from '@/features/ai/hooks/useAiPipelineStatus'

export function AiPipelinePanel({ eventId }: { eventId?: string | null }) {
  const { status, loading, error } = useAiPipelineStatus(eventId)

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
          <Sparkles className="size-[18px] text-muted-foreground" />
        </div>

        <div className="min-w-0 space-y-1">
          <h2 className="text-fs-md font-semibold text-foreground">
            AI analysis pipeline
          </h2>

          {loading ? (
            <p className="text-[13.5px] text-muted-foreground">Checking…</p>
          ) : error ? (
            <p className="text-[13.5px] text-muted-foreground">{error}</p>
          ) : !status.configured ? (
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Not configured. No AI provider is connected, so no photo is sent anywhere for
              analysis and nothing is queued. The pipeline is in place and will start
              accepting work once a provider is enabled.
            </p>
          ) : (
            <>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                Connected: {status.providers.join(', ')}.
                {status.kinds.length > 0 && ` Available analysis: ${status.kinds.join(', ')}.`}
              </p>
              {eventId && status.summary.total > 0 && (
                <p className="text-[13.5px] text-muted-foreground">
                  {status.summary.queued} queued · {status.summary.running} running ·{' '}
                  {status.summary.retry} retrying · {status.summary.completed} done ·{' '}
                  {status.summary.failed} failed
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
