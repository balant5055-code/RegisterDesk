'use client'

// GA-7D S3 — Brand Kit. Surfaces the EXISTING organizer brand kit
// (GET/PUT /api/organizer/brand-kit, collection organizerBrandKit/{uid}) so logos,
// signature, seal, colours and the default font live in one reusable place. Uploads
// reuse the existing organizer-library storage helper — no new upload engine. The
// brand kit is organizer-wide (shared across all events).

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Save, Upload, X } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { uploadOrganizerLibraryAsset } from '@/lib/firebase/storage'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { Spinner, ErrorBox, FieldLabel, inputCls, selectCls, btnPrimary, btnGhost } from './ui'
import type { BrandKit } from '@/lib/brandkit/types'

type Kit = Omit<BrandKit, 'organizerUid' | 'updatedAt' | 'updatedBy'>

const BLANK: Kit = {
  logoUrl: '', secondaryLogoUrl: '', sealUrl: '', signatureUrl: '',
  primaryColor: '#e5277e', secondaryColor: '#1f2937', font: 'helvetica',
  footer: '', website: '', supportEmail: '', phone: '',
}

const IMAGE_FIELDS: { key: keyof Kit; label: string }[] = [
  { key: 'logoUrl', label: 'Logo' },
  { key: 'signatureUrl', label: 'Signature' },
  { key: 'sealUrl', label: 'Seal' },
  { key: 'secondaryLogoUrl', label: 'Secondary logo' },
]

export default function BrandKitPanel({ token }: { token: string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [kit, setKit] = useState<Kit>(BLANK)
  const [dirty, setDirty] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const { showToast } = useToast()

  const load = useCallback(async () => {
    setErr(null)
    const res = await fetch('/api/organizer/brand-kit', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string })?.error ?? 'Failed to load brand kit')
    const { brandKit } = await res.json() as { brandKit: BrandKit }
    setKit({
      logoUrl: brandKit.logoUrl, secondaryLogoUrl: brandKit.secondaryLogoUrl, sealUrl: brandKit.sealUrl,
      signatureUrl: brandKit.signatureUrl, primaryColor: brandKit.primaryColor || '#e5277e',
      secondaryColor: brandKit.secondaryColor || '#1f2937', font: brandKit.font,
      footer: brandKit.footer, website: brandKit.website, supportEmail: brandKit.supportEmail, phone: brandKit.phone,
    })
    setDirty(false)
  }, [token])

  useEffect(() => { load().catch(e => setErr(e.message)).finally(() => setLoading(false)) }, [load])

  function set<K extends keyof Kit>(key: K, value: Kit[K]) { setKit(k => ({ ...k, [key]: value })); setDirty(true) }

  async function onUpload(key: keyof Kit, file: File | undefined) {
    if (!file) return
    const uid = auth.currentUser?.uid
    if (!uid) { setErr('Not authenticated.'); return }
    setUploading(key); setErr(null)
    try { set(key, (await uploadOrganizerLibraryAsset(uid, file)) as Kit[typeof key]) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed') }
    finally { setUploading(null) }
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/organizer/brand-kit', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(kit),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string })?.error ?? 'Save failed')
      setDirty(false)
      showToast('Brand kit saved.', 'success')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  if (loading) return <Spinner />

  return (
    <div className="space-y-5">
      <p className="text-[13px] text-muted-foreground">Your logos, signature, seal, colours and default font — shared across all your events.</p>
      {err && <ErrorBox message={err} />}

      {/* Images */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {IMAGE_FIELDS.map(({ key, label }) => {
          const url = kit[key] as string
          return (
            <div key={key} className="rounded-xl border border-border bg-card p-3">
              <FieldLabel>{label}</FieldLabel>
              <div className="flex aspect-[1.6/1] items-center justify-center overflow-hidden rounded-lg bg-muted/40">
                {url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <span className="text-[12px] text-muted-foreground">None</span>}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <label className={cn(btnGhost, 'cursor-pointer')}>
                  {uploading === key ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} {url ? 'Replace' : 'Upload'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => { void onUpload(key, e.target.files?.[0]); e.target.value = '' }} />
                </label>
                {url && <button type="button" className={btnGhost} title="Remove" onClick={() => set(key, '' as Kit[typeof key])}><X className="size-3.5" /></button>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Colours + font */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <FieldLabel>Primary colour</FieldLabel>
          <div className="flex items-center gap-2">
            <input type="color" className="h-9 w-10 shrink-0 cursor-pointer rounded border border-border bg-card" value={kit.primaryColor} onChange={e => set('primaryColor', e.target.value)} />
            <input className={inputCls} value={kit.primaryColor} onChange={e => set('primaryColor', e.target.value)} />
          </div>
        </div>
        <div>
          <FieldLabel>Secondary colour</FieldLabel>
          <div className="flex items-center gap-2">
            <input type="color" className="h-9 w-10 shrink-0 cursor-pointer rounded border border-border bg-card" value={kit.secondaryColor} onChange={e => set('secondaryColor', e.target.value)} />
            <input className={inputCls} value={kit.secondaryColor} onChange={e => set('secondaryColor', e.target.value)} />
          </div>
        </div>
        <div>
          <FieldLabel>Default font</FieldLabel>
          <select className={selectCls} value={kit.font} onChange={e => set('font', e.target.value as Kit['font'])}>
            <option value="helvetica">Helvetica</option>
            <option value="times">Times</option>
            <option value="courier">Courier</option>
          </select>
        </div>
      </div>

      {/* Contact / footer */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><FieldLabel>Website</FieldLabel><input className={inputCls} placeholder="https://…" value={kit.website} onChange={e => set('website', e.target.value)} /></div>
        <div><FieldLabel>Support email</FieldLabel><input className={inputCls} placeholder="support@…" value={kit.supportEmail} onChange={e => set('supportEmail', e.target.value)} /></div>
        <div><FieldLabel>Phone</FieldLabel><input className={inputCls} value={kit.phone} onChange={e => set('phone', e.target.value)} /></div>
        <div><FieldLabel>Footer text</FieldLabel><input className={inputCls} value={kit.footer} onChange={e => set('footer', e.target.value)} /></div>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" className={btnPrimary} disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save brand kit
        </button>
        {dirty && <span className="text-[12px] text-muted-foreground">Unsaved changes</span>}
      </div>
    </div>
  )
}
