'use client'

// RD-PRODUCT-01B — real-time draft save status. Presentational only; reflects the
// useDraft state machine. NEVER fakes success — 'saved' is shown only after a
// confirmed server write.

import { useEffect, useState } from 'react'
import { Check, Cloud, CloudOff, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import type { SaveState } from '@/lib/hooks/useDraft'

function relativeTime(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 5)   return 'just now'
  if (s < 60)  return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60)  return `${m} min${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  return `${h} hr${h === 1 ? '' : 's'} ago`
}

export function SaveStatusIndicator({
  state, lastSavedAt,
}: { state: SaveState; lastSavedAt: number | null }) {
  // Tick so "Last saved 2 mins ago" stays current without a save.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])

  const cls = 'inline-flex items-center gap-1.5 text-[12px] tabular-nums'
  switch (state) {
    case 'saving':
      return <span className={`${cls} text-muted-foreground`}><Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…</span>
    case 'retrying':
      return <span className={`${cls} text-amber-600`}><RefreshCw className="size-3.5 animate-spin" aria-hidden /> Connection issue — retrying…</span>
    case 'offline':
      return <span className={`${cls} text-amber-600`}><CloudOff className="size-3.5" aria-hidden /> Offline — changes saved locally</span>
    case 'error':
      return <span className={`${cls} text-red-600`}><AlertTriangle className="size-3.5" aria-hidden /> Couldn’t save — will keep trying</span>
    case 'saved':
      return (
        <span className={`${cls} text-emerald-600`}>
          <Check className="size-3.5" aria-hidden />
          {lastSavedAt ? `Saved ${relativeTime(lastSavedAt, now)}` : 'Saved'}
        </span>
      )
    default:
      return lastSavedAt
        ? <span className={`${cls} text-muted-foreground`}><Cloud className="size-3.5" aria-hidden /> Last saved {relativeTime(lastSavedAt, now)}</span>
        : <span className={`${cls} text-muted-foreground/60`}><Cloud className="size-3.5" aria-hidden /> Draft</span>
  }
}
