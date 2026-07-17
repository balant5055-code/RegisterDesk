'use client'

// Organizer Asset Library (GA-6 S4). A management surface for reusable images —
// upload once, reuse across every certificate/print project. REUSES the existing
// organizer-asset upload flow (uploadOrganizerLibraryAsset) + the /api/organizer/assets
// routes; it renders no certificates and owns no rendering/storage engine.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onIdTokenChanged } from 'firebase/auth'
import { Loader2, Upload, Trash2, Search, FolderPlus } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { uploadOrganizerLibraryAsset } from '@/lib/firebase/storage'
import { ASSET_CATEGORIES, type AssetCategory, type SerializedOrganizerAsset } from '@/lib/assetLibrary/types'

const CATEGORY_LABEL: Record<AssetCategory, string> = {
  background: 'Backgrounds', logo: 'Logos', signature: 'Signatures', icon: 'Icons',
  sponsor: 'Sponsor Logos', watermark: 'Watermarks', image: 'Images',
}

export default function AssetLibraryClient() {
  const { showToast } = useToast()
  const [token, setToken] = useState('')
  const [uid, setUid]     = useState('')
  const [assets, setAssets] = useState<SerializedOrganizerAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [category, setCategory] = useState<AssetCategory | 'all'>('all')
  const [folder, setFolder] = useState<string>('all')
  const [q, setQ] = useState('')
  const [uploadCategory, setUploadCategory] = useState<AssetCategory>('image')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => onIdTokenChanged(auth, async u => {
    if (u) { setUid(u.uid); setToken(await u.getIdToken()) }
  }), [])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const res = await fetch('/api/organizer/assets', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json() as { assets?: SerializedOrganizerAsset[]; error?: string }
      if (!res.ok) { showToast(data.error ?? 'Could not load assets', 'error'); return }
      setAssets(data.assets ?? [])
    } catch { showToast('Network error', 'error') }
    finally { setLoading(false) }
  }, [token, showToast])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const folders = useMemo(() => Array.from(new Set(assets.map(a => a.folder).filter(Boolean))).sort(), [assets])

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase()
    return assets.filter(a =>
      (category === 'all' || a.category === category) &&
      (folder === 'all' || (a.folder || '') === folder) &&
      (!term || a.name.toLowerCase().includes(term) || (a.folder || '').toLowerCase().includes(term)),
    )
  }, [assets, category, folder, q])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file || !uid || !token) return
    setUploading(true)
    try {
      const url = await uploadOrganizerLibraryAsset(uid, file)   // reuse existing upload flow
      const res = await fetch('/api/organizer/assets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: uploadCategory, name: file.name, url, contentType: file.type }),
      })
      const data = await res.json() as { asset?: SerializedOrganizerAsset; error?: string }
      if (!res.ok || !data.asset) { showToast(data.error ?? 'Upload failed', 'error'); return }
      setAssets(prev => [data.asset!, ...prev])
      showToast('Asset added', 'success')
    } catch { showToast('Upload failed', 'error') }
    finally { setUploading(false) }
  }

  async function remove(id: string) {
    setAssets(prev => prev.filter(a => a.id !== id))   // optimistic
    try {
      const res = await fetch(`/api/organizer/assets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { showToast('Delete failed', 'error'); void load() }
    } catch { showToast('Delete failed', 'error'); void load() }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-[20px] font-bold text-foreground">Asset Library</h1>
          <p className="text-[13px] text-muted-foreground">Reusable images for your certificate & print designs. Upload once, use everywhere.</p>
        </div>
        <select value={uploadCategory} onChange={e => setUploadCategory(e.target.value as AssetCategory)}
          className="h-9 rounded-lg border border-border bg-card px-2 text-[13px] text-foreground">
          {ASSET_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        <label className={cn('flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-semibold text-white hover:opacity-90', uploading && 'opacity-60')}>
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" disabled={uploading} onChange={onFile} />
        </label>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="h-8 w-40 bg-transparent text-[13px] text-foreground focus:outline-none" />
        </div>
        <Chip active={category === 'all'} onClick={() => setCategory('all')}>All</Chip>
        {ASSET_CATEGORIES.map(c => <Chip key={c} active={category === c} onClick={() => setCategory(c)}>{CATEGORY_LABEL[c]}</Chip>)}
        {folders.length > 0 && (
          <select value={folder} onChange={e => setFolder(e.target.value)} className="ml-auto h-8 rounded-lg border border-border bg-card px-2 text-[12px] text-muted-foreground">
            <option value="all">All folders</option>
            {folders.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : visible.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center">
          <FolderPlus className="size-7 text-muted-foreground/50" />
          <p className="text-[13px] text-muted-foreground">No assets yet. Upload an image to start your library.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {visible.map(a => (
            <div key={a.id} className="group relative overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex aspect-square items-center justify-center bg-[repeating-conic-gradient(#f3f4f6_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.name} loading="lazy" className="max-h-full max-w-full object-contain" />
              </div>
              <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-[11.5px] font-medium text-foreground" title={a.name}>{a.name}</p>
                  <p className="text-[10px] text-muted-foreground/70">{CATEGORY_LABEL[a.category]}</p>
                </div>
                <button type="button" onClick={() => remove(a.id)} title="Delete"
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[12px] font-medium',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-muted/40')}>
      {children}
    </button>
  )
}
