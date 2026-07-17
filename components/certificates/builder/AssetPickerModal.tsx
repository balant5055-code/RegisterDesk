'use client'

// GA-7D S3 — Asset Library picker for the certificate designer. Reuses the EXISTING
// organizer Asset Library (GET /api/organizer/assets) so a saved logo/image can be
// inserted into a template without re-uploading — NO second media browser. Self-
// contained (gets its own token) so it needs no new props threaded through the canvas.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Images } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { Dialog } from '@/components/ui/Dialog'

interface Asset { id: string; name: string; url: string; category: string }

export default function AssetPickerModal({
  open, onClose, onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (url: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) throw new Error('Not authenticated')
      const res = await fetch('/api/organizer/assets', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string })?.error ?? 'Failed to load assets')
      setAssets(((await res.json()) as { assets: Asset[] }).assets)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load assets') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  return (
    <Dialog open={open} onClose={onClose} title="Asset Library" size="lg">
      {loading ? (
        <div className="flex items-center justify-center py-14"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : err ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{err}</div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Images className="size-8 text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">No saved assets yet. Upload reusable logos and images in the Asset Library.</p>
        </div>
      ) : (
        <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
          {assets.map(a => (
            <button key={a.id} type="button" onClick={() => { onPick(a.url); onClose() }} className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-primary">
              <div className="flex aspect-square items-center justify-center overflow-hidden bg-muted/40">
                <img src={a.url} alt={a.name} className="h-full w-full object-contain" />
              </div>
              <span className="truncate px-1.5 py-1 text-[11px] text-muted-foreground">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  )
}
