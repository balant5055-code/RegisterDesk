'use client'

// RD-MEDIA-PERF-03 · Queue rows.
// RD-MEDIA-UX-01 · The overall progress display moved into ImportSummaryRail — keeping it
// here too would have been the duplicated information the redesign removes.
//
// ═══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════
// The old bar was `completed / total`. Arithmetically correct, behaviourally useless:
// importing three photos concurrently showed 0% for the entire run and then jumped to 100%.
// An organizer reasonably read that as frozen — and the per-item label made it worse, showing
// "processing" through the decode, three encodes, the prepare call, three PUTs and the
// complete call.
//
// ═══ WHY IT IS SPLIT LIKE THIS ════════════════════════════════════════════════
// `UploadRow` is memoized and takes PRIMITIVES, not the item object. A 3,000-photo import
// issues ~9,000 state updates; without this every one of them reconciled every visible row.
// Now only rows whose own values changed re-render.

import { memo } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { StatusChip } from '@/components/ui'
import { STAGE_ORDER, type ProgressStage } from '@/features/media-studio/utils/queueMachine'
import { STAGE_LABEL } from '@/features/media-studio/utils/uploadTimings'
import type { UploadItemState } from '@/features/media-studio/utils/queueMachine'

export interface UploadRowProps {
  name:  string
  state: UploadItemState
  stage: ProgressStage | null
  storedBytes: number
  reason: string | null
  formatBytes: (bytes: number) => string
}

/**
 * ONE queue row. Memoized on primitives so an unrelated photo's state change does not
 * re-render it — the single biggest React win in a large import.
 */
export const UploadRow = memo(function UploadRow({
  name, state, stage, storedBytes, reason, formatBytes,
}: UploadRowProps) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border/60 px-2.5 py-1.5">
      {state === 'completed'
        ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        : state === 'failed'
          ? <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />
          : <span className="size-4 shrink-0" aria-hidden />}

      <span className="min-w-0 flex-1 truncate text-fs-sm text-foreground">{name}</span>

      <span className="shrink-0 text-fs-2xs text-muted-foreground">
        {state === 'completed'
          ? formatBytes(storedBytes)
          : state === 'failed' && reason
            ? reason
            : state === 'uploading' || state === 'processing'
              // The REAL stage, not the state-machine label.
              ? <StatusChip tone="info">{nextLabel(stage)}</StatusChip>
              : state}
      </span>
    </li>
  )
})

function nextLabel(stage: ProgressStage | null): string {
  const at   = stage === null ? -1 : STAGE_ORDER.indexOf(stage)
  const next = STAGE_ORDER[at + 1]
  return next ? STAGE_LABEL[next] : STAGE_LABEL.complete
}
