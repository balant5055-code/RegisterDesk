'use client'

import { useState, useRef, useCallback, useId } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle, Check, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  Crop, Image as ImageIcon, Info, Loader2, Monitor, Plus, Smartphone,
  Tablet, Trash2, Upload, Video, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { MediaConfig, MediaAsset, EventPageTheme } from '@/components/wizard/eventDetailsConfig'
import { uploadEventAsset } from '@/lib/firebase/storage'

// ─── Shared primitives (mirror EventDetailsBuilder theme exactly) ─────────────

const inputCls = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-[12px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[11px] text-muted-foreground'

function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <p className="text-[13px] font-semibold text-foreground">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

function ModeCard({ label, desc, selected, onClick }: { label: string; desc?: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-all duration-150',
        selected ? 'border-primary bg-primary/[0.03] shadow-sm' : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]',
      )}>
      <div className="flex items-center justify-between gap-2">
        <p className={cn('text-[12.5px] font-semibold', selected ? 'text-foreground' : 'text-foreground/80')}>{label}</p>
        <div className={cn('flex size-[16px] shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary' : 'border-border')}>
          {selected && <div className="size-[8px] rounded-full bg-white" />}
        </div>
      </div>
      {desc && <p className="text-[11.5px] leading-snug text-muted-foreground">{desc}</p>}
    </button>
  )
}

function SourceTabs({ active, onChange }: { active: 'upload' | 'url'; onChange: (v: 'upload' | 'url') => void }) {
  return (
    <div className="flex w-fit overflow-hidden rounded-lg border border-border text-[12px] font-medium">
      {(['upload', 'url'] as const).map(t => (
        <button key={t} type="button" onClick={() => onChange(t)}
          className={cn('px-3 py-1.5 transition-colors', active === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/40')}>
          {t === 'upload' ? 'Upload' : 'Image URL'}
        </button>
      ))}
    </div>
  )
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOGO_LIMIT    = 5  * 1024 * 1024   // 5 MB
const BANNER_LIMIT  = 10 * 1024 * 1024   // 10 MB
const GALLERY_LIMIT = 5  * 1024 * 1024   // 5 MB per item
const GALLERY_MAX   = 20
const ACCEPT        = 'image/png,image/jpeg,image/webp'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateFile(file: File, maxBytes: number): string | null {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    return 'Only PNG, JPG, WEBP files are allowed.'
  if (file.size > maxBytes)
    return `File must be under ${Math.round(maxBytes / 1024 / 1024)} MB.`
  return null
}

/** Compresses a File (via its objectURL) to JPEG, resizing and iterating quality. */
async function compressToJpeg(
  objectUrl: string,
  maxW: number,
  maxH: number,
  targetBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas  = document.createElement('canvas')
      let w = img.naturalWidth, h = img.naturalHeight
      const ratio   = Math.min(maxW / w, maxH / h, 1)
      canvas.width  = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)

      let q = 0.92
      const attempt = () => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('Canvas export failed')); return }
          if (blob.size <= targetBytes || q <= 0.4) {
            const fr = new FileReader()
            fr.onload = () => resolve(fr.result as string)
            fr.readAsDataURL(blob)
          } else { q = Math.max(0.4, q - 0.08); attempt() }
        }, 'image/jpeg', q)
      }
      attempt()
    }
    img.onerror = () => reject(new Error('Image load failed'))
    img.src = objectUrl
  })
}

/** Returns the natural dimensions of an image src (data URL or external URL). */
function measureImage(src: string): Promise<{ w: number; h: number }> {
  return new Promise(resolve => {
    const img   = new Image()
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 0, h: 0 })
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous'
    img.src = src
  })
}

/** Returns a YouTube or Vimeo embed URL, or null if not recognised. */
function extractEmbedUrl(url: string): string | null {
  if (!url.trim()) return null
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v')
        || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null)
      if (v) return `https://www.youtube.com/embed/${v}?rel=0&modestbranding=1`
    }
    if (u.hostname === 'youtu.be') {
      const v = u.pathname.slice(1)
      if (v) return `https://www.youtube.com/embed/${v}?rel=0&modestbranding=1`
    }
    if (u.hostname.includes('vimeo.com')) {
      const v = u.pathname.split('/').filter(Boolean).find(p => /^\d+$/.test(p))
      if (v) return `https://player.vimeo.com/video/${v}?dnt=1`
    }
  } catch { /* invalid URL */ }
  return null
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function DropZone({
  onFiles, maxBytes = GALLERY_LIMIT, hint, multiple = false, disabled = false,
}: {
  onFiles:   (files: File[]) => void
  maxBytes?: number
  hint?:     string
  multiple?: boolean
  disabled?: boolean
}) {
  const id        = useId()
  const [over, setOver] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)

  const process = (list: FileList | null) => {
    if (!list) return
    setErr(null)
    const valid: File[] = []
    for (const f of Array.from(list)) {
      const e = validateFile(f, maxBytes)
      if (e) { setErr(e); continue }
      valid.push(f)
    }
    if (valid.length) onFiles(valid)
  }

  return (
    <div>
      <label htmlFor={id}
        onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true)  }}
        onDragLeave={() => setOver(false)}
        onDrop={e  => { e.preventDefault(); setOver(false); if (!disabled) process(e.dataTransfer.files) }}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-colors',
          over    ? 'border-primary bg-primary/[0.04]'
                  : 'border-border/60 hover:border-primary/40 hover:bg-muted/[0.03]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <div className={cn('flex size-10 items-center justify-center rounded-full transition-colors', over ? 'bg-primary/10' : 'bg-muted/30')}>
          <Upload className={cn('size-5', over ? 'text-primary' : 'text-muted-foreground')} />
        </div>
        <div>
          <p className="text-[12.5px] font-medium text-foreground">
            {over ? 'Drop to upload' : 'Drag & drop or click to browse'}
          </p>
          {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
        </div>
        <input id={id} type="file" accept={ACCEPT} multiple={multiple} className="sr-only"
          onChange={e => { process(e.target.files); e.target.value = '' }}
          disabled={disabled} />
      </label>
      <AnimatePresence>
        {err && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="mt-1.5 flex items-center gap-1.5 text-[11px] text-red-600">
            <AlertTriangle className="size-3 shrink-0" /> {err}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Image Cropper Modal ──────────────────────────────────────────────────────

interface CropperProps {
  src:          string
  aspectRatio:  number   // e.g. 1 for 1:1, 16/9 for banner
  outputWidth:  number
  outputHeight: number
  title:        string
  onApply:      (dataUrl: string) => void
  onCancel:     () => void
}

function ImageCropperModal({ src, aspectRatio, outputWidth, outputHeight, title, onApply, onCancel }: CropperProps) {
  const CROP_W = 288
  const CROP_H = Math.round(CROP_W / aspectRatio)

  const imgRef  = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  const [nat,    setNat]    = useState({ w: 0, h: 0 })
  const [offsetX, setOX]   = useState(0)
  const [offsetY, setOY]   = useState(0)
  const [zoom,   setZoom]  = useState(1)
  const [drag,   setDrag]  = useState(false)

  const coverScale = nat.w > 0 ? Math.max(CROP_W / nat.w, CROP_H / nat.h) : 1
  const baseW      = nat.w * coverScale
  const baseH      = nat.h * coverScale

  function clamp(ox: number, oy: number, z: number) {
    const dw = baseW * z, dh = baseH * z
    const mx = Math.max(0, (dw - CROP_W) / 2)
    const my = Math.max(0, (dh - CROP_H) / 2)
    return { x: Math.max(-mx, Math.min(mx, ox)), y: Math.max(-my, Math.min(my, oy)) }
  }

  const onLoad = () => {
    const img = imgRef.current
    if (!img) return
    setNat({ w: img.naturalWidth, h: img.naturalHeight })
    setOX(0); setOY(0); setZoom(1)
  }

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(true)
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offsetX, oy: offsetY }
  }

  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const c = clamp(dragRef.current.ox + e.clientX - dragRef.current.sx,
                    dragRef.current.oy + e.clientY - dragRef.current.sy, zoom)
    setOX(c.x); setOY(c.y)
  }

  const onUp = () => { setDrag(false); dragRef.current = null }

  const onZoom = (z: number) => {
    const c = clamp(offsetX, offsetY, z)
    setZoom(z); setOX(c.x); setOY(c.y)
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    onZoom(Math.max(1, Math.min(4, zoom - e.deltaY * 0.002)))
  }

  const apply = useCallback(() => {
    const img = imgRef.current
    if (!img || nat.w === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = outputWidth; canvas.height = outputHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dw = baseW * zoom, dh = baseH * zoom
    const sx = (dw / 2 - CROP_W / 2 - offsetX) * (nat.w / dw)
    const sy = (dh / 2 - CROP_H / 2 - offsetY) * (nat.h / dh)
    const sw = CROP_W * (nat.w / dw)
    const sh = CROP_H * (nat.h / dh)
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight)
    onApply(canvas.toDataURL('image/jpeg', 0.92))
  }, [nat, offsetX, offsetY, zoom, baseW, baseH, outputWidth, outputHeight, onApply, CROP_W, CROP_H])

  const imgStyle: CSSProperties = {
    position:        'absolute',
    width:           baseW || '100%',
    height:          baseH,
    top:             '50%',
    left:            '50%',
    marginTop:       -(baseH / 2),
    marginLeft:      -(baseW / 2),
    transform:       `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`,
    transformOrigin: 'center',
    pointerEvents:   'none',
    userSelect:      'none',
    maxWidth:        'none',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <Crop className="size-4 text-primary" /> {title}
          </p>
          <button type="button" onClick={onCancel}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        {/* Crop viewport */}
        <div className="flex flex-col items-center gap-4 p-4">
          <div
            style={{ width: CROP_W, height: CROP_H, cursor: drag ? 'grabbing' : 'grab' }}
            className="relative overflow-hidden rounded-lg border border-border bg-muted/20 select-none"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
            onWheel={onWheel}
          >
            {src && <img ref={imgRef} src={src} alt="" style={imgStyle} draggable={false} onLoad={onLoad} />}
            {/* Rule-of-thirds grid */}
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute left-0 right-0 top-1/3 h-px bg-white/20" />
              <div className="absolute left-0 right-0 top-2/3 h-px bg-white/20" />
              <div className="absolute top-0 bottom-0 left-1/3 w-px bg-white/20" />
              <div className="absolute top-0 bottom-0 left-2/3 w-px bg-white/20" />
              <div className="absolute inset-0 rounded-lg border-2 border-white/40" />
            </div>
          </div>

          {/* Zoom controls */}
          <div className="flex w-full items-center gap-3">
            <button type="button" onClick={() => onZoom(Math.max(1, zoom - 0.1))}
              className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/50">
              <ZoomOut className="size-3.5" />
            </button>
            <input type="range" min={1} max={4} step={0.05} value={zoom}
              onChange={e => onZoom(parseFloat(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-primary" />
            <button type="button" onClick={() => onZoom(Math.min(4, zoom + 0.1))}
              className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/50">
              <ZoomIn className="size-3.5" />
            </button>
          </div>
          <p className="-mt-2 text-[10.5px] text-muted-foreground">
            Drag to reposition · scroll or slider to zoom · {zoom.toFixed(1)}×
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onCancel} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
            Cancel
          </button>
          <button type="button" onClick={apply} disabled={nat.w === 0}
            className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}>
            <Check className="size-3.5" /> Apply Crop
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ─── Quality Warning ──────────────────────────────────────────────────────────

function QualityWarning({ message }: { message: string }) {
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
      className="flex items-start gap-1.5 rounded-lg border border-amber-200/60 bg-amber-50/50 px-3 py-2 text-[11px] text-amber-700">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{message} You can still continue.</span>
    </motion.div>
  )
}

// ─── Upload badge (shown after a file is uploaded & cropped) ─────────────────

function UploadedBadge({ label, onRemove, onReplace, onReplaceFiles }: {
  label:          string
  onRemove:       () => void
  onReplace?:     () => void
  onReplaceFiles?:(files: File[]) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald-200/60 bg-emerald-50/50 px-3 py-2">
      <Check className="size-3.5 shrink-0 text-emerald-600" />
      <span className="flex-1 truncate text-[11.5px] text-emerald-800">{label}</span>
      {onReplaceFiles && (
        <label htmlFor={id}
          className="cursor-pointer text-[11px] text-primary underline-offset-2 hover:underline">
          Replace
          <input id={id} type="file" accept={ACCEPT} className="sr-only"
            onChange={e => { if (e.target.files?.[0]) onReplaceFiles(Array.from(e.target.files)); e.target.value = '' }} />
        </label>
      )}
      {onReplace && !onReplaceFiles && (
        <button type="button" onClick={onReplace} className="text-[11px] text-primary underline-offset-2 hover:underline">Replace</button>
      )}
      <button type="button" onClick={onRemove}
        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-red-500">
        <Trash2 className="size-3" />
      </button>
    </div>
  )
}

// ─── Event Logo Section ───────────────────────────────────────────────────────

function EventLogoSection({ logo, onChange, uploadContext }: {
  logo:           MediaAsset
  onChange:       (a: MediaAsset) => void
  uploadContext?: { uid: string; draftId: string }
}) {
  const [tab,       setTab]      = useState<'upload' | 'url'>(logo.source === 'upload' ? 'upload' : 'url')
  const [url,       setUrl]      = useState(logo.source === 'url' ? logo.value : '')
  const [crop,      setCrop]     = useState<string | null>(null)
  const [warn,      setWarn]     = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const pendingRef  = useRef<string | null>(null)

  const hasImg     = logo.value.length > 0
  const previewSrc = hasImg ? logo.value : null

  const openCrop = (objectUrl: string) => { pendingRef.current = objectUrl; setCrop(objectUrl) }

  const handleFiles = (files: File[]) => {
    const f = files[0]
    if (!f) return
    openCrop(URL.createObjectURL(f))
  }

  const handleCropApply = async (dataUrl: string) => {
    if (pendingRef.current) { URL.revokeObjectURL(pendingRef.current); pendingRef.current = null }
    setCrop(null)

    if (uploadContext) {
      setUploading(true)
      try {
        const filename = `logo-${Date.now()}.jpg`
        const downloadUrl = await uploadEventAsset(uploadContext.uid, uploadContext.draftId, 'logo', dataUrl, filename)
        onChange({ source: 'url', value: downloadUrl, originalFileName: 'logo.jpg' })
        const { w, h } = await measureImage(downloadUrl)
        setWarn(w > 0 && (w < 256 || h < 256)
          ? `Logo is ${w}×${h}px. Recommended minimum is 512×512px for sharp display.` : null)
      } catch (err) {
        console.error('[EventLogoSection] Storage upload failed:', err)
        setWarn('Upload failed — please check your connection and try again.')
      } finally {
        setUploading(false)
      }
    } else {
      onChange({ source: 'upload', value: dataUrl, originalFileName: 'logo.jpg' })
      const { w, h } = await measureImage(dataUrl)
      setWarn(w > 0 && (w < 256 || h < 256)
        ? `Logo is ${w}×${h}px. Recommended minimum is 512×512px for sharp display.` : null)
    }
  }

  const handleUrlCommit = async () => {
    const v = url.trim()
    onChange({ source: 'url', value: v })
    if (v) {
      const { w, h } = await measureImage(v)
      setWarn(w > 0 && (w < 256 || h < 256)
        ? `Logo is ${w}×${h}px. Recommended minimum is 512×512px for sharp display.` : null)
    } else { setWarn(null) }
  }

  const handleRemove = () => { onChange({ source: 'url', value: '' }); setUrl(''); setWarn(null) }

  return (
    <>
      <Card title="Event Logo">
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
          {/* Circular preview */}
          <div className="flex shrink-0 flex-col items-center gap-2 sm:w-28">
            <div className="relative size-24 overflow-hidden rounded-full border-2 border-border bg-muted/20">
              {previewSrc
                ? <img src={previewSrc} alt="Logo" className="size-full object-cover" onError={() => {}} />
                : <div className="flex size-full items-center justify-center"><ImageIcon className="size-8 text-muted-foreground/30" /></div>
              }
              {hasImg && (
                <button type="button" onClick={handleRemove}
                  className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:bg-red-50 hover:text-red-500">
                  <X className="size-3" />
                </button>
              )}
            </div>
            <p className="text-center text-[10.5px] text-muted-foreground">512 × 512 px<br />PNG / JPG / WEBP</p>
          </div>

          {/* Controls */}
          <div className="flex flex-1 flex-col gap-3">
            <SourceTabs active={tab} onChange={setTab} />

            {tab === 'upload' ? (
              uploading ? (
                <div className="flex items-center gap-2 rounded-lg border border-blue-200/60 bg-blue-50/50 px-3 py-2.5 text-[12px] text-blue-700">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  Uploading logo…
                </div>
              ) : hasImg && (logo.source === 'upload' || logo.originalFileName) ? (
                <UploadedBadge label={logo.originalFileName ?? 'logo.jpg — cropped 1:1'} onRemove={handleRemove}
                  onReplaceFiles={files => files[0] && openCrop(URL.createObjectURL(files[0]))} />
              ) : (
                <DropZone onFiles={handleFiles} maxBytes={LOGO_LIMIT}
                  hint="PNG, JPG, WEBP · max 5 MB · will be cropped to 1:1 (512 × 512)" />
              )
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <input className={cn(inputCls, 'flex-1')} type="url" value={url}
                    onChange={e => setUrl(e.target.value)}
                    onBlur={handleUrlCommit}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleUrlCommit() } }}
                    placeholder="https://example.com/logo.png" />
                  {hasImg && logo.source === 'url' && (
                    <button type="button" onClick={handleRemove}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-red-50 hover:text-red-500">
                      <X className="size-4" />
                    </button>
                  )}
                </div>
                <p className={hintCls}>Direct image URL. Ensure the image is publicly accessible.</p>
              </div>
            )}

            <AnimatePresence>{warn && <QualityWarning message={warn} />}</AnimatePresence>
          </div>
        </div>
      </Card>

      <AnimatePresence>
        {crop && (
          <ImageCropperModal src={crop} aspectRatio={1} outputWidth={512} outputHeight={512}
            title="Crop Logo (1 : 1 · 512 × 512)"
            onApply={handleCropApply}
            onCancel={() => { if (pendingRef.current) { URL.revokeObjectURL(pendingRef.current); pendingRef.current = null } setCrop(null) }} />
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Cover Banner Section ─────────────────────────────────────────────────────

type DevicePrev = 'desktop' | 'tablet' | 'mobile'

const DEVICE_META: Record<DevicePrev, { label: string; Icon: typeof Monitor; aspect: string; note: string }> = {
  desktop: { label: 'Desktop',   Icon: Monitor,    aspect: '16 / 9',  note: '1600 × 900 — full banner visible' },
  tablet:  { label: 'Tablet',    Icon: Tablet,     aspect: '4 / 3',   note: 'Banner crops to a 4:3 centre' },
  mobile:  { label: 'Mobile',    Icon: Smartphone, aspect: '2 / 1',   note: 'Banner crops to a 2:1 strip' },
}

function CoverBannerSection({ banner, onChange, uploadContext }: {
  banner:         MediaAsset
  onChange:       (a: MediaAsset) => void
  uploadContext?: { uid: string; draftId: string }
}) {
  const [tab,       setTab]      = useState<'upload' | 'url'>(banner.source === 'upload' ? 'upload' : 'url')
  const [url,       setUrl]      = useState(banner.source === 'url' ? banner.value : '')
  const [crop,      setCrop]     = useState<string | null>(null)
  const [device,    setDevice]   = useState<DevicePrev>('desktop')
  const [warn,      setWarn]     = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const pendingRef  = useRef<string | null>(null)

  const hasImg     = banner.value.length > 0
  const previewSrc = hasImg ? banner.value : null

  const openCrop = (objectUrl: string) => { pendingRef.current = objectUrl; setCrop(objectUrl) }

  const handleFiles = (files: File[]) => {
    const f = files[0]; if (!f) return
    openCrop(URL.createObjectURL(f))
  }

  const handleCropApply = async (dataUrl: string) => {
    if (pendingRef.current) { URL.revokeObjectURL(pendingRef.current); pendingRef.current = null }
    setCrop(null)

    if (uploadContext) {
      setUploading(true)
      try {
        const filename = `banner-${Date.now()}.jpg`
        const downloadUrl = await uploadEventAsset(uploadContext.uid, uploadContext.draftId, 'banner', dataUrl, filename)
        onChange({ source: 'url', value: downloadUrl, originalFileName: 'banner.jpg' })
        const { w, h } = await measureImage(downloadUrl)
        setWarn(w > 0 && (w < 800 || h < 450)
          ? `Banner is ${w}×${h}px. Recommended is 1600×900px for crisp display.` : null)
      } catch (err) {
        console.error('[CoverBannerSection] Storage upload failed:', err)
        setWarn('Upload failed — please check your connection and try again.')
      } finally {
        setUploading(false)
      }
    } else {
      onChange({ source: 'upload', value: dataUrl, originalFileName: 'banner.jpg' })
      const { w, h } = await measureImage(dataUrl)
      setWarn(w > 0 && (w < 800 || h < 450)
        ? `Banner is ${w}×${h}px. Recommended is 1600×900px for crisp display.` : null)
    }
  }

  const handleUrlCommit = async () => {
    const v = url.trim()
    onChange({ source: 'url', value: v })
    if (v) {
      const { w, h } = await measureImage(v)
      setWarn(w > 0 && (w < 800 || h < 450)
        ? `Banner is ${w}×${h}px. Recommended is 1600×900px for crisp display.` : null)
    } else { setWarn(null) }
  }

  const handleRemove = () => { onChange({ source: 'url', value: '' }); setUrl(''); setWarn(null) }

  return (
    <>
      <Card title="Cover Banner">
        <div className="flex flex-col gap-4">
          <SourceTabs active={tab} onChange={setTab} />

          {tab === 'upload' ? (
            uploading ? (
              <div className="flex items-center gap-2 rounded-lg border border-blue-200/60 bg-blue-50/50 px-3 py-2.5 text-[12px] text-blue-700">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                Uploading banner…
              </div>
            ) : hasImg && (banner.source === 'upload' || banner.originalFileName) ? (
              <UploadedBadge label={banner.originalFileName ?? 'banner.jpg — cropped 16:9'} onRemove={handleRemove}
                onReplaceFiles={files => files[0] && openCrop(URL.createObjectURL(files[0]))} />
            ) : (
              <DropZone onFiles={handleFiles} maxBytes={BANNER_LIMIT}
                hint="PNG, JPG, WEBP · max 10 MB · recommended 1600 × 900 px" />
            )
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2">
                <input className={cn(inputCls, 'flex-1')} type="url" value={url}
                  onChange={e => setUrl(e.target.value)}
                  onBlur={handleUrlCommit}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleUrlCommit() } }}
                  placeholder="https://example.com/banner.jpg" />
                {hasImg && banner.source === 'url' && (
                  <button type="button" onClick={handleRemove}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-red-50 hover:text-red-500">
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <p className={hintCls}>Direct image URL. Recommended: 1600 × 900 px PNG / JPG.</p>
            </div>
          )}

          <AnimatePresence>{warn && <QualityWarning message={warn} />}</AnimatePresence>

          {/* Responsive safe-area preview */}
          <AnimatePresence>
            {hasImg && previewSrc && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
                {/* Device selector */}
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-medium text-foreground">Responsive Safe Area Preview</p>
                  <div className="flex gap-1">
                    {(Object.entries(DEVICE_META) as [DevicePrev, typeof DEVICE_META[DevicePrev]][]).map(([id, { label, Icon }]) => (
                      <button key={id} type="button" onClick={() => setDevice(id)}
                        className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                          device === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/40')}>
                        <Icon className="size-3.5" /> {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Preview frame */}
                <div className="relative overflow-hidden rounded-lg border border-border bg-black"
                  style={{ aspectRatio: DEVICE_META[device].aspect }}>
                  <img src={previewSrc} alt="Banner preview"
                    className="absolute inset-0 size-full object-cover" />
                  {/* Overlays */}
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-gradient-to-t from-black/40 to-transparent" />
                    {/* Safe-zone dashed guide */}
                    <div className="absolute inset-[10%] rounded border border-dashed border-white/35" />
                    <div className="absolute left-[10%] top-[10%]">
                      <span className="rounded bg-black/50 px-1.5 py-0.5 text-[9px] font-medium text-white/60">Safe zone</span>
                    </div>
                    <div className="absolute bottom-2 right-3">
                      <span className="rounded bg-black/50 px-1.5 py-0.5 text-[9px] text-white/50">
                        {DEVICE_META[device].note}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-1.5 rounded-lg bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  Keep logos and key text within the dashed safe zone for visibility across all screen sizes.
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Card>

      <AnimatePresence>
        {crop && (
          <ImageCropperModal src={crop} aspectRatio={16 / 9} outputWidth={1600} outputHeight={900}
            title="Crop Banner (16 : 9 · 1600 × 900)"
            onApply={handleCropApply}
            onCancel={() => { if (pendingRef.current) { URL.revokeObjectURL(pendingRef.current); pendingRef.current = null } setCrop(null) }} />
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Brand Identity (Primary Color + Theme) ───────────────────────────────────

const THEMES: { id: EventPageTheme; label: string; desc: string }[] = [
  { id: 'default',      label: 'Default',      desc: 'Clean white, primary accent'  },
  { id: 'professional', label: 'Professional', desc: 'Dark header, serif, muted'    },
  { id: 'modern',       label: 'Modern',       desc: 'Full-bleed banner, bold type' },
  { id: 'minimal',      label: 'Minimal',      desc: 'Whitespace-first, text-driven'},
  { id: 'vibrant',      label: 'Vibrant',       desc: 'Gradient header, high contrast'},
]

function BrandIdentitySection({ primaryColor, theme, onChange }: {
  primaryColor: string
  theme:        EventPageTheme
  onChange:     (p: Partial<MediaConfig>) => void
}) {
  return (
    <Card title="Brand Identity">
      <div className="flex flex-col gap-4">
        <div>
          <label className={labelCls}>Primary Colour</label>
          <div className="flex items-center gap-2">
            <input type="color" className="h-9 w-12 cursor-pointer rounded-lg border border-border p-1"
              value={primaryColor} onChange={e => onChange({ primaryColor: e.target.value })} />
            <input className={cn(inputCls, 'font-mono')} value={primaryColor}
              onChange={e => onChange({ primaryColor: e.target.value })}
              placeholder="#6366f1" maxLength={7} />
          </div>
        </div>
        <div>
          <p className={labelCls}>Theme Style</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {THEMES.map(t => (
              <ModeCard key={t.id} label={t.label} desc={t.desc}
                selected={theme === t.id} onClick={() => onChange({ theme: t.id })} />
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

// ─── Gallery Section ──────────────────────────────────────────────────────────

function GallerySection({ images, onChange, uploadContext }: {
  images:         MediaAsset[]
  onChange:       (imgs: MediaAsset[]) => void
  uploadContext?: { uid: string; draftId: string }
}) {
  const [mode,    setMode]    = useState<'upload' | 'url'>('upload')
  const [urlIn,   setUrlIn]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [preview, setPreview] = useState<number | null>(null)

  const remaining = GALLERY_MAX - images.length

  const handleFiles = async (files: File[]) => {
    setBusy(true)
    const batch: MediaAsset[] = []
    for (const f of files.slice(0, remaining)) {
      try {
        const obj  = URL.createObjectURL(f)
        const data = await compressToJpeg(obj, 1200, 900, 300 * 1024)
        URL.revokeObjectURL(obj)

        if (uploadContext) {
          const filename = `gallery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`
          const downloadUrl = await uploadEventAsset(uploadContext.uid, uploadContext.draftId, 'gallery', data, filename)
          batch.push({ source: 'url', value: downloadUrl, originalFileName: f.name })
        } else {
          batch.push({ source: 'upload', value: data, originalFileName: f.name })
        }
      } catch { /* skip failed images */ }
    }
    onChange([...images, ...batch])
    setBusy(false)
  }

  const addUrl = () => {
    const v = urlIn.trim(); if (!v || !remaining) return
    onChange([...images, { source: 'url', value: v }])
    setUrlIn('')
  }

  const remove = (i: number) => {
    onChange(images.filter((_, j) => j !== i))
    if (preview === i) setPreview(null)
  }

  const move = (i: number, dir: 'up' | 'down') => {
    const next = [...images]
    const swap = dir === 'up' ? i - 1 : i + 1
    if (swap < 0 || swap >= next.length) return
    ;[next[i], next[swap]] = [next[swap]!, next[i]!]
    onChange(next)
  }

  return (
    <>
      <Card title="Gallery Images"
        action={<span className="text-[11px] text-muted-foreground">{images.length} / {GALLERY_MAX}</span>}>
        <div className="flex flex-col gap-4">

          {/* Thumbnail grid */}
          {images.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {images.map((img, i) => (
                <div key={i} className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted/20">
                  <img src={img.value} alt={`Gallery ${i + 1}`}
                    className="size-full cursor-zoom-in object-cover"
                    onClick={() => setPreview(i)}
                    onError={() => {}} />
                  {/* Hover controls */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="flex gap-1">
                      {i > 0 && (
                        <button type="button" onClick={() => move(i, 'up')}
                          className="flex size-6 items-center justify-center rounded bg-white/90 text-foreground hover:bg-white">
                          <ChevronUp className="size-3" />
                        </button>
                      )}
                      {i < images.length - 1 && (
                        <button type="button" onClick={() => move(i, 'down')}
                          className="flex size-6 items-center justify-center rounded bg-white/90 text-foreground hover:bg-white">
                          <ChevronDown className="size-3" />
                        </button>
                      )}
                    </div>
                    <button type="button" onClick={() => remove(i)}
                      className="flex size-6 items-center justify-center rounded bg-red-500/90 text-white hover:bg-red-600">
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                  <span className="pointer-events-none absolute left-1 top-1 flex size-4 items-center justify-center rounded bg-black/50 text-[9px] font-medium text-white">
                    {i + 1}
                  </span>
                </div>
              ))}
              {/* Quick-add slot */}
              {remaining > 0 && (
                <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border/60 text-muted-foreground/50 transition-colors hover:border-primary/40 hover:text-primary/60">
                  <Plus className="size-5" />
                  <span className="text-[10px]">Add</span>
                  <input type="file" accept={ACCEPT} multiple className="sr-only"
                    onChange={e => { if (e.target.files) handleFiles(Array.from(e.target.files)); e.target.value = '' }} />
                </label>
              )}
            </div>
          )}

          {/* Add controls */}
          {remaining > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex w-fit overflow-hidden rounded-lg border border-border text-[12px] font-medium">
                {(['upload', 'url'] as const).map(m => (
                  <button key={m} type="button" onClick={() => setMode(m)}
                    className={cn('px-3 py-1.5 transition-colors', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/40')}>
                    {m === 'upload' ? 'Upload' : 'Add URL'}
                  </button>
                ))}
              </div>

              {mode === 'upload' ? (
                <DropZone multiple onFiles={handleFiles} maxBytes={GALLERY_LIMIT} disabled={busy}
                  hint={`PNG, JPG, WEBP · max 5 MB · ${remaining} slot${remaining !== 1 ? 's' : ''} remaining`} />
              ) : (
                <div className="flex gap-2">
                  <input className={cn(inputCls, 'flex-1')} type="url" value={urlIn}
                    onChange={e => setUrlIn(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUrl() } }}
                    placeholder="https://example.com/photo.jpg" />
                  <button type="button" onClick={addUrl} disabled={!urlIn.trim()}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
                    <Plus className="mr-1 size-3.5" /> Add
                  </button>
                </div>
              )}

              {busy && <p className="text-[11px] text-muted-foreground">Processing images…</p>}
            </div>
          )}

          {images.length === 0 && !busy && (
            <p className={cn(hintCls, 'mt-0')}>Add up to {GALLERY_MAX} event photos to engage attendees.</p>
          )}
        </div>
      </Card>

      {/* Lightbox preview */}
      <AnimatePresence>
        {preview !== null && images[preview] && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
            onClick={() => setPreview(null)}>
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }}
              className="relative max-h-[85vh] max-w-[90vw]"
              onClick={e => e.stopPropagation()}>
              <img src={images[preview].value} alt={`Preview ${preview + 1}`}
                className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" />
              <button type="button" onClick={() => setPreview(null)}
                className="absolute -right-3 -top-3 flex size-7 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-md">
                <X className="size-3.5" />
              </button>
              {preview > 0 && (
                <button type="button" onClick={() => setPreview(p => (p !== null ? p - 1 : p))}
                  className="absolute left-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/80 text-foreground shadow">
                  <ChevronLeft className="size-4" />
                </button>
              )}
              {preview < images.length - 1 && (
                <button type="button" onClick={() => setPreview(p => (p !== null ? p + 1 : p))}
                  className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/80 text-foreground shadow">
                  <ChevronRight className="size-4" />
                </button>
              )}
              <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-0.5 text-[11px] text-white/70">
                {preview + 1} / {images.length}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Promotional Video Section ────────────────────────────────────────────────

function PromoVideoSection({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const [input, setInput] = useState(url)
  const embed = extractEmbedUrl(url)

  const commit = () => onChange(input.trim())

  return (
    <Card title="Promotional Video">
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input className={cn(inputCls, 'flex-1')} type="url" value={input}
            onChange={e => setInput(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
            placeholder="https://youtube.com/watch?v=… or vimeo.com/…" />
          {input && (
            <button type="button" onClick={() => { setInput(''); onChange('') }}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-red-50 hover:text-red-500">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 text-[11px] text-muted-foreground">
          <Video className="mt-0.5 size-3.5 shrink-0" />
          YouTube and Vimeo URLs are supported. The video will be embedded on your event page.
        </div>

        <AnimatePresence mode="wait">
          {embed ? (
            <motion.div key={embed} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-black">
                <iframe src={embed} title="Video preview" className="absolute inset-0 size-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen />
              </div>
              <p className="mt-1.5 text-center text-[11px] text-muted-foreground">Video preview</p>
            </motion.div>
          ) : input.trim() ? (
            <motion.div key="invalid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex items-center gap-1.5 text-[11px] text-amber-600">
              <AlertTriangle className="size-3.5 shrink-0" />
              Not a recognised YouTube or Vimeo URL.
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </Card>
  )
}

// ─── Live Preview Section ─────────────────────────────────────────────────────

type PreviewView = 'card' | 'hero' | 'social'

function LivePreviewSection({ media }: { media: MediaConfig }) {
  const [view, setView] = useState<PreviewView>('card')
  const logo   = media.logo.value
  const banner = media.coverBanner.value
  const color  = media.primaryColor

  return (
    <Card title="Live Preview"
      action={
        <div className="flex overflow-hidden rounded-lg border border-border text-[11px]">
          {(['card', 'hero', 'social'] as PreviewView[]).map(v => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn('px-2.5 py-1 font-medium capitalize transition-colors',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/40')}>
              {v}
            </button>
          ))}
        </div>
      }
    >
      <AnimatePresence mode="wait">
        {/* ── Event Card ── */}
        {view === 'card' && (
          <motion.div key="card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="mx-auto max-w-[260px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="relative h-28 bg-muted/30">
                {banner
                  ? <img src={banner} alt="" className="size-full object-cover" onError={() => {}} />
                  : <div className="flex size-full items-center justify-center"><ImageIcon className="size-8 text-muted-foreground/20" /></div>
                }
                <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
              </div>
              <div className="px-3 pb-3">
                <div className="-mt-5 mb-2 flex items-end gap-2">
                  <div className="size-10 overflow-hidden rounded-lg border-2 border-card bg-muted/20 shadow-sm">
                    {logo
                      ? <img src={logo} alt="" className="size-full object-cover" onError={() => {}} />
                      : <div className="flex size-full items-center justify-center"><ImageIcon className="size-4 text-muted-foreground/30" /></div>
                    }
                  </div>
                </div>
                <p className="text-[13px] font-semibold text-foreground">Your Event Name</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Jun 15, 2026 · Bangalore</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ backgroundColor: color }}>Live</span>
                  <span className="text-[11px] text-muted-foreground">₹999</span>
                </div>
              </div>
            </div>
            <p className="mt-3 text-center text-[11px] text-muted-foreground">Event card preview</p>
          </motion.div>
        )}

        {/* ── Hero Banner ── */}
        {view === 'hero' && (
          <motion.div key="hero" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="relative overflow-hidden rounded-xl" style={{ aspectRatio: '16/9' }}>
              {banner
                ? <img src={banner} alt="" className="size-full object-cover" onError={() => {}} />
                : <div className="flex size-full items-center justify-center bg-muted/30"><ImageIcon className="size-10 text-muted-foreground/20" /></div>
              }
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-4">
                <div className="mb-1.5 flex items-center gap-2">
                  {logo && (
                    <div className="size-8 overflow-hidden rounded border border-white/20">
                      <img src={logo} alt="" className="size-full object-cover" onError={() => {}} />
                    </div>
                  )}
                  <p className="text-[15px] font-bold text-white drop-shadow">Your Event Name</p>
                </div>
                <p className="text-[11px] text-white/60">Jun 15, 2026 · Bangalore</p>
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">Hero banner preview</p>
          </motion.div>
        )}

        {/* ── Social Share (OG card) ── */}
        {view === 'social' && (
          <motion.div key="social" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="mx-auto max-w-md overflow-hidden rounded-lg border border-border shadow-sm">
              <div className="relative bg-muted/30" style={{ aspectRatio: '1.91/1' }}>
                {banner
                  ? <img src={banner} alt="" className="size-full object-cover" onError={() => {}} />
                  : <div className="flex size-full items-center justify-center"><ImageIcon className="size-8 text-muted-foreground/20" /></div>
                }
                <div className="absolute inset-0 bg-gradient-to-t from-black/55 to-transparent" />
                <div className="absolute bottom-3 left-3 right-3">
                  {logo && <div className="mb-1.5 size-6 overflow-hidden rounded"><img src={logo} alt="" className="size-full object-cover" onError={() => {}} /></div>}
                  <p className="text-[13px] font-semibold leading-snug text-white">Your Event Name</p>
                  <p className="mt-0.5 text-[11px] text-white/55">registerdesk.in · Jun 2026</p>
                </div>
              </div>
              <div className="border-t border-border bg-muted/20 px-3 py-2">
                <p className="text-[11px] font-medium text-foreground">registerdesk.in</p>
                <p className="text-[11px] text-muted-foreground">Your Event Name — Register Now</p>
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">Social share card (OG image)</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function BrandingMediaSection({
  media,
  onChange,
  uploadContext,
}: {
  media:          MediaConfig
  onChange:       (p: Partial<MediaConfig>) => void
  uploadContext?: { uid: string; draftId: string }
}) {
  return (
    <div className="flex flex-col gap-3">
      <EventLogoSection   logo={media.logo}          onChange={v => onChange({ logo: v })}          uploadContext={uploadContext} />
      <CoverBannerSection banner={media.coverBanner} onChange={v => onChange({ coverBanner: v })}   uploadContext={uploadContext} />
      <BrandIdentitySection
        primaryColor={media.primaryColor}
        theme={media.theme}
        onChange={onChange}
      />
      <GallerySection    images={media.galleryImages} onChange={v => onChange({ galleryImages: v })} uploadContext={uploadContext} />
      <PromoVideoSection url={media.promoVideoUrl}    onChange={v => onChange({ promoVideoUrl: v })} />
      <LivePreviewSection media={media} />
    </div>
  )
}
