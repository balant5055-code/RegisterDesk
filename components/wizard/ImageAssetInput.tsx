'use client'

/**
 * ImageAssetInput — reusable single-image field for the Create Event Wizard.
 *
 * Supports upload-from-device (drag & drop, browse, mobile camera) and paste-URL,
 * with auto-compression, preview, replace, and remove. Stores either a data URL
 * (uploaded) or an external URL string — both are compatible with the existing
 * string fields in EventDetailsDraft. Data URLs starting with "data:" are detected
 * as uploaded images by the Firebase Storage abstraction for future upload.
 */

import { useState, useId } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Check, ImageIcon, Link2, Trash2, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Shared style constants (mirror EventDetailsBuilder theme) ────────────────

const inputCls = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-[13px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[13px] text-muted-foreground'

// ─── Internal helpers ─────────────────────────────────────────────────────────

const ACCEPTED = 'image/png,image/jpeg,image/webp'

function validateFile(file: File, maxBytes: number): string | null {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    return 'Only PNG, JPG or WEBP files are allowed.'
  if (file.size > maxBytes)
    return `File must be under ${Math.round(maxBytes / 1024 / 1024)} MB.`
  return null
}

interface CompressResult { dataUrl: string; origKB: number; finalKB: number }

async function compressImage(
  file:      File,
  maxDim:    number,
  targetKB:  number,
): Promise<CompressResult> {
  const origKB = Math.round(file.size / 1024)
  return new Promise((resolve, reject) => {
    const obj = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(obj)
      const canvas = document.createElement('canvas')
      const w = img.naturalWidth, h = img.naturalHeight
      const r = Math.min(maxDim / Math.max(w, h), 1)
      canvas.width  = Math.round(w * r)
      canvas.height = Math.round(h * r)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)

      let q = 0.92
      const run = () =>
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('Canvas export failed')); return }
          if (blob.size <= targetKB * 1024 || q <= 0.4) {
            const fr = new FileReader()
            fr.onload = () => resolve({ dataUrl: fr.result as string, origKB, finalKB: Math.round(blob.size / 1024) })
            fr.readAsDataURL(blob)
          } else { q = Math.max(0.4, q - 0.08); run() }
        }, 'image/jpeg', q)
      run()
    }
    img.onerror = () => { URL.revokeObjectURL(obj); reject(new Error('Image load failed')) }
    img.src = obj
  })
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ImageAssetInputProps {
  /** Field label shown above the control. */
  label:     string
  /** Current value — either an external URL or a data URL from a previous upload. */
  value:     string
  onChange:  (v: string) => void
  hint?:     string
  /**
   * Preview shape.
   * - `'square'` — small square / circular thumbnail (speaker, logo).
   * - `'banner'` — full-width rectangular preview (maps, floor plans, share image).
   * @default 'banner'
   */
  shape?:    'square' | 'banner'
  /** Upload file-size limit in bytes. @default 5 MB */
  maxBytes?: number
  /** Maximum dimension (px) the image is resized to before compression. @default 1200 */
  maxDim?:   number
  /** JPEG compression target in KB. @default 400 */
  targetKB?: number
  required?: boolean
  className?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ImageAssetInput({
  label,
  value,
  onChange,
  hint,
  shape     = 'banner',
  maxBytes  = 5 * 1024 * 1024,
  maxDim    = 1200,
  targetKB  = 400,
  required  = false,
  className,
}: ImageAssetInputProps) {
  const uploadId  = useId()
  const replaceId = useId()

  const [tab,         setTab]         = useState<'upload' | 'url'>('upload')
  const [urlDraft,    setUrlDraft]    = useState(value.startsWith('data:') ? '' : value)
  const [replaceUrl,  setReplaceUrl]  = useState('')
  const [showReplUrl, setShowReplUrl] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [stats,       setStats]       = useState<{ orig: number; final: number } | null>(null)
  const [isDrag,      setIsDrag]      = useState(false)
  const [busy,        setBusy]        = useState(false)

  const hasImage = value.length > 0

  // ── File processing ──────────────────────────────────────────────────────────

  const processFile = async (file: File) => {
    setError(null)
    const err = validateFile(file, maxBytes)
    if (err) { setError(err); return }
    setBusy(true)
    try {
      const { dataUrl, origKB, finalKB } = await compressImage(file, maxDim, targetKB)
      setStats({ orig: origKB, final: finalKB })
      setUrlDraft('')
      setShowReplUrl(false)
      onChange(dataUrl)
    } catch {
      setError('Failed to process image. Try a different file.')
    } finally {
      setBusy(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDrag(false)
    const f = e.dataTransfer.files[0]; if (f) processFile(f)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''
  }

  // ── URL commit ───────────────────────────────────────────────────────────────

  const commitUrl = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    onChange(v)
    setUrlDraft(v)
    setReplaceUrl('')
    setShowReplUrl(false)
    setStats(null)
  }

  // ── Remove ───────────────────────────────────────────────────────────────────

  const handleRemove = () => {
    onChange(''); setUrlDraft(''); setStats(null); setError(null); setShowReplUrl(false)
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const previewCls = cn(
    'relative overflow-hidden rounded-lg border border-border bg-muted/20',
    shape === 'square' ? 'size-16' : 'h-24 w-full',
  )

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label className={labelCls}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>

      {/* ── HAS IMAGE ──────────────────────────────────────────────────────────── */}
      {hasImage && (
        <div className="flex flex-col gap-2">
          {/* Preview */}
          <div className={previewCls}>
            <img src={value} alt="" className="size-full object-cover"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            {/* Quick-remove corner button */}
            <button type="button" onClick={handleRemove}
              className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:bg-red-50 hover:text-red-500">
              <X className="size-3" />
            </button>
          </div>

          {/* Compression badge */}
          {stats && stats.orig > stats.final && (
            <p className="flex items-center gap-1 text-[12px] text-emerald-600">
              <Check className="size-3 shrink-0" />
              Optimised {stats.orig} KB → {stats.final} KB
            </p>
          )}

          {/* Action row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* Replace with file */}
            <label htmlFor={replaceId}
              className={cn('cursor-pointer text-[12px] text-primary underline-offset-2 hover:underline', busy && 'cursor-not-allowed opacity-50')}>
              Replace image
              <input id={replaceId} type="file" accept={ACCEPTED} className="sr-only"
                onChange={handleFileChange} disabled={busy} />
            </label>
            {/* Replace with URL */}
            <button type="button" onClick={() => setShowReplUrl(v => !v)}
              className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Paste URL
            </button>
            {/* Remove */}
            <button type="button" onClick={handleRemove}
              className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-red-500">
              <Trash2 className="size-3" /> Remove
            </button>
          </div>

          {/* Inline URL-replace input */}
          <AnimatePresence>
            {showReplUrl && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="flex gap-2 pt-0.5">
                  <input className={cn(inputCls, 'flex-1')} type="url" value={replaceUrl}
                    autoFocus
                    onChange={e => setReplaceUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitUrl(replaceUrl) } }}
                    placeholder="https://…" />
                  <button type="button" onClick={() => commitUrl(replaceUrl)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/[0.06] text-primary hover:bg-primary/10">
                    <Check className="size-4" />
                  </button>
                  <button type="button" onClick={() => setShowReplUrl(false)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/50">
                    <X className="size-4" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ── NO IMAGE ───────────────────────────────────────────────────────────── */}
      {!hasImage && (
        <>
          {/* Upload / URL tab switcher */}
          <div className="flex w-fit overflow-hidden rounded-lg border border-border text-[12px] font-medium">
            <button type="button" onClick={() => setTab('upload')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                tab === 'upload' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/40')}>
              <Upload className="size-3" /> Upload
            </button>
            <button type="button" onClick={() => setTab('url')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                tab === 'url' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/40')}>
              <Link2 className="size-3" /> Image URL
            </button>
          </div>

          {/* Upload drop zone */}
          {tab === 'upload' && (
            <label
              htmlFor={uploadId}
              onDragOver={e => { e.preventDefault(); setIsDrag(true)  }}
              onDragLeave={() => setIsDrag(false)}
              onDrop={handleDrop}
              className={cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition-colors',
                isDrag   ? 'border-primary bg-primary/[0.04]'
                         : 'border-border/60 hover:border-primary/40 hover:bg-muted/[0.03]',
                busy     && 'cursor-not-allowed opacity-50',
              )}
            >
              {busy ? (
                <p className="text-[12px] text-muted-foreground">Optimising…</p>
              ) : (
                <>
                  <div className={cn('flex size-9 items-center justify-center rounded-full transition-colors', isDrag ? 'bg-primary/10' : 'bg-muted/30')}>
                    <Upload className={cn('size-4', isDrag ? 'text-primary' : 'text-muted-foreground')} />
                  </div>
                  <div>
                    <p className="text-[12px] font-medium text-foreground">
                      {isDrag ? 'Drop image here' : 'Drag & drop or click to browse'}
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      PNG, JPG, WEBP · max {Math.round(maxBytes / 1024 / 1024)} MB
                    </p>
                  </div>
                </>
              )}
              <input id={uploadId} type="file" accept={ACCEPTED} className="sr-only"
                onChange={handleFileChange} disabled={busy} />
            </label>
          )}

          {/* URL input */}
          {tab === 'url' && (
            <input className={inputCls} type="url" value={urlDraft}
              onChange={e => setUrlDraft(e.target.value)}
              onBlur={() => { if (urlDraft.trim()) commitUrl(urlDraft) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitUrl(urlDraft) } }}
              placeholder="https://…" />
          )}
        </>
      )}

      {/* Empty-state icon (square shape, no image) */}
      {!hasImage && shape === 'square' && tab === 'upload' && !busy && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <div className="flex size-16 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10">
            <ImageIcon className="size-5 text-muted-foreground/30" />
          </div>
          <span>Preview will appear here</span>
        </div>
      )}

      {/* Error message */}
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-1.5 text-[12px] text-red-600">
            <AlertTriangle className="size-3 shrink-0" /> {error}
          </motion.p>
        )}
      </AnimatePresence>

      {hint && <p className={hintCls}>{hint}</p>}
    </div>
  )
}
