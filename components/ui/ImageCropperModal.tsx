'use client'

import { useState, useCallback, useEffect } from 'react'
import Cropper                           from 'react-easy-crop'
import type { Area, Point }              from 'react-easy-crop'
import {
  X, Check, RotateCcw, RotateCw, RefreshCw,
  Loader2, ZoomIn, ZoomOut,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CropConfig {
  label:        string
  aspect:       number   // react-easy-crop v5 requires a number; use 1 (square),
                         // ~3 (wide rect for signatures), or 16/9 (header)
  outputWidth:  number
  outputHeight: number   // explicit — avoids rounding surprises in canvas scaling
}

// ─── Canvas utilities ─────────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.addEventListener('load', () => resolve(img))
    img.addEventListener('error', reject)
    img.setAttribute('crossOrigin', 'anonymous')
    img.src = src
  })
}

/**
 * Three-pass crop + scale:
 *  1. Draw the rotated image on a square "safe" canvas (avoids clipping during rotation).
 *  2. Extract the exact crop at native resolution via getImageData / putImageData.
 *  3. Scale the cropped canvas to the desired output dimensions via drawImage.
 */
export async function getCroppedBlob(
  imageSrc:    string,
  pixelCrop:   Area,
  rotation:    number,
  outputWidth: number,
  outputHeight: number,
): Promise<Blob> {
  const image    = await loadImage(imageSrc)
  const maxSide  = Math.max(image.naturalWidth, image.naturalHeight)
  const safeArea = 2 * ((maxSide / 2) * Math.sqrt(2))

  // Pass 1 — rotated image on safe canvas
  const safeCanvas  = document.createElement('canvas')
  safeCanvas.width  = safeArea
  safeCanvas.height = safeArea
  const safeCtx     = safeCanvas.getContext('2d')!
  safeCtx.translate(safeArea / 2, safeArea / 2)
  safeCtx.rotate((rotation * Math.PI) / 180)
  safeCtx.translate(-safeArea / 2, -safeArea / 2)
  safeCtx.drawImage(
    image,
    safeArea / 2 - image.naturalWidth  * 0.5,
    safeArea / 2 - image.naturalHeight * 0.5,
  )
  const rotatedData = safeCtx.getImageData(0, 0, safeArea, safeArea)

  // Pass 2 — extract exact crop at native scale
  const cropCanvas  = document.createElement('canvas')
  cropCanvas.width  = pixelCrop.width
  cropCanvas.height = pixelCrop.height
  const cropCtx     = cropCanvas.getContext('2d')!
  cropCtx.putImageData(
    rotatedData,
    Math.round(0 - safeArea / 2 + image.naturalWidth  * 0.5 - pixelCrop.x),
    Math.round(0 - safeArea / 2 + image.naturalHeight * 0.5 - pixelCrop.y),
  )

  // Pass 3 — scale to target output dimensions
  const outCanvas  = document.createElement('canvas')
  outCanvas.width  = outputWidth
  outCanvas.height = outputHeight
  outCanvas.getContext('2d')!.drawImage(cropCanvas, 0, 0, outputWidth, outputHeight)

  return new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('Canvas produced empty blob'))
    }, 'image/png')
  })
}

// ─── Slider (shared between zoom and rotation controls) ───────────────────────

function ControlSlider({
  min, max, step, value, onChange,
  decrementIcon: Dec, incrementIcon: Inc,
  label, displayValue,
}: {
  min: number; max: number; step: number; value: number
  onChange: (v: number) => void
  decrementIcon: React.ElementType
  incrementIcon: React.ElementType
  label: string
  displayValue: string
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onChange(Math.max(min, value - step * 5))}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/30"
      >
        <Dec className="size-4" aria-hidden />
      </button>

      <div className="flex flex-1 flex-col gap-1">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          aria-label={label}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-primary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
        />
      </div>

      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(Math.min(max, value + step * 5))}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/30"
      >
        <Inc className="size-4" aria-hidden />
      </button>

      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/40">
        {displayValue}
      </span>
    </div>
  )
}

// ─── ImageCropperModal ────────────────────────────────────────────────────────

interface Props {
  imageSrc: string
  config:   CropConfig
  onApply:  (file: File, previewUrl: string) => void
  onCancel: () => void
}

export function ImageCropperModal({ imageSrc, config, onApply, onCancel }: Props) {
  const [crop,     setCrop]     = useState<Point>({ x: 0, y: 0 })
  const [zoom,     setZoom]     = useState(1)
  const [rotation, setRotation] = useState(0)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [applying, setApplying] = useState(false)

  // GA-7D S1: this full-screen modal had no focus trap or Escape. Reuse the shared
  // trap (trap + restore) and add Escape-to-cancel; role/aria-modal were present.
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const onCropComplete = useCallback((_croppedArea: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels)
  }, [])

  function handleReset() {
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(0)
  }

  async function handleApply() {
    if (!croppedAreaPixels) return
    setApplying(true)
    try {
      const blob       = await getCroppedBlob(imageSrc, croppedAreaPixels, rotation, config.outputWidth, config.outputHeight)
      const previewUrl = URL.createObjectURL(blob)
      const file       = new File([blob], 'image.png', { type: 'image/png' })
      onApply(file, previewUrl)
    } catch {
      // silent — the overlay stays open so the user can try again
    } finally {
      setApplying(false)
    }
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={config.label}
      className="fixed inset-0 z-50 flex flex-col bg-[#111]"
      style={{ touchAction: 'none' }}
    >

      {/* ── Top bar ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/30"
        >
          <X className="size-3.5" aria-hidden /> Cancel
        </button>

        <p className="text-[13px] font-semibold text-white">{config.label}</p>

        <button
          type="button"
          onClick={handleApply}
          disabled={applying || !croppedAreaPixels}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-white/30"
        >
          {applying
            ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
            : <Check   className="size-3.5"              aria-hidden />
          }
          Apply
        </button>
      </div>

      {/* ── Crop canvas — fills remaining height ── */}
      <div className="relative min-h-0 flex-1">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={config.aspect}
          minZoom={0.5}
          maxZoom={4}
          showGrid
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onRotationChange={setRotation}
          onCropComplete={onCropComplete}
          style={{ containerStyle: { background: '#111' } }}
          classes={{
            cropAreaClassName: cn(
              'border-2 border-white/80',
              'shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]',
            ),
          }}
        />
      </div>

      {/* ── Controls panel ── */}
      <div className="shrink-0 border-t border-white/10 bg-[#1c1c1c] px-4 pb-safe-area-inset-bottom">

        {/* Output label */}
        <div className="flex items-center justify-center py-2.5">
          <span className="rounded-full bg-white/10 px-3 py-0.5 text-[11px] font-medium text-white/50">
            Output: {config.outputWidth} × {config.outputHeight} px
          </span>
        </div>

        <div className="space-y-3 pb-4">

          {/* Zoom */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-white/30">Zoom</p>
            <ControlSlider
              min={0.5} max={4} step={0.05}
              value={zoom}
              onChange={setZoom}
              decrementIcon={ZoomOut}
              incrementIcon={ZoomIn}
              label="Zoom"
              displayValue={`${zoom.toFixed(1)}×`}
            />
          </div>

          {/* Rotation */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-white/30">Rotation</p>
            <div className="flex items-center gap-2">
              {/* –90° snap */}
              <button
                type="button"
                onClick={() => setRotation(r => Math.max(-180, r - 90))}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/30"
                aria-label="Rotate left 90°"
              >
                <RotateCcw className="size-4" aria-hidden />
              </button>

              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={rotation}
                onChange={e => setRotation(Number(e.target.value))}
                aria-label="Rotation angle"
                className="h-1.5 w-full flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-primary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
              />

              {/* +90° snap */}
              <button
                type="button"
                onClick={() => setRotation(r => Math.min(180, r + 90))}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/30"
                aria-label="Rotate right 90°"
              >
                <RotateCw className="size-4" aria-hidden />
              </button>

              <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/40">
                {rotation}°
              </span>
            </div>
          </div>

          {/* Reset */}
          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-medium text-white/40 transition-colors hover:bg-white/10 hover:text-white/70 focus:outline-none focus:ring-1 focus:ring-white/30"
            >
              <RefreshCw className="size-3.5" aria-hidden /> Reset
            </button>
          </div>

        </div>
      </div>

    </div>
  )
}
