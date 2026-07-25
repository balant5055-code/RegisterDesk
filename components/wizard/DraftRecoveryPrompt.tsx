'use client'

// RD-PRODUCT-01B — draft recovery / conflict resolution modal. Shown when useDraft
// detects unsynced local edits (crash / tab close) and/or a server change made from
// another device. The organizer decides which version to keep — nothing is discarded
// silently.

import { History, Cloud, Smartphone } from 'lucide-react'
import type { DraftConflict } from '@/lib/hooks/useDraft'

function when(ms: number): string {
  try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
  catch { return 'recently' }
}

export function DraftRecoveryPrompt({
  conflict, onResolve,
}: { conflict: DraftConflict; onResolve: (keepLocal: boolean) => void }) {
  const crossDevice = conflict.kind === 'server-changed'
  const snap = conflict.snapshot

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <History className="size-5 text-primary" aria-hidden />
          <h2 className="text-[15px] font-semibold text-foreground">
            {crossDevice ? 'This draft was edited elsewhere' : 'Recover unsaved changes?'}
          </h2>
        </div>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {crossDevice
            ? 'You have unsaved changes on this device, but this draft was also updated from another device. Which version do you want to keep?'
            : 'We found unsaved changes from your last session (a refresh or closed tab). Would you like to restore them?'}
        </p>

        <div className="mt-3 grid gap-2 text-[12px]">
          <div className="rounded-lg border border-border bg-background p-2.5">
            <div className="flex items-center gap-1.5 font-medium text-foreground"><Smartphone className="size-3.5" aria-hidden /> Your unsaved edits</div>
            <div className="mt-0.5 text-muted-foreground">Edited {when(snap.clientUpdatedAt)} · {snap.device} · {snap.pendingKeys.length} unsaved section{snap.pendingKeys.length === 1 ? '' : 's'}</div>
          </div>
          {crossDevice && (
            <div className="rounded-lg border border-border bg-background p-2.5">
              <div className="flex items-center gap-1.5 font-medium text-foreground"><Cloud className="size-3.5" aria-hidden /> Saved version</div>
              <div className="mt-0.5 text-muted-foreground">The version currently stored in the cloud.</div>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onResolve(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted">
            {crossDevice ? 'Use saved version' : 'Discard'}
          </button>
          <button type="button" onClick={() => onResolve(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90">
            {crossDevice ? 'Keep my edits' : 'Restore my changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
