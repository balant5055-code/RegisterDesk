'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { IScannerControls }                     from '@zxing/browser'
import { cn }                                        from '@/lib/utils/cn'
import {
  Camera, ChevronDown, Zap, ZapOff,
  CameraOff, Loader2, RefreshCcw,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  active: boolean
  onCode: (code: string) => void
}

// MediaTrackCapabilities doesn't include `torch` in the standard TypeScript lib
type ExtendedCapabilities = MediaTrackCapabilities & { torch?: boolean }

// ─── Component ────────────────────────────────────────────────────────────────

export default function QrScanner({ active, onCode }: Props) {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  // Duplicate-scan guard: same code within 2 s is ignored
  const lastScanRef = useRef<{ code: string; ts: number } | null>(null)

  const [cameras,   setCameras]   = useState<MediaDeviceInfo[]>([])
  const [cameraId,  setCameraId]  = useState<string | undefined>()
  const [torchOn,   setTorchOn]   = useState(false)
  const [torchOk,   setTorchOk]   = useState(false)
  const [starting,  setStarting]  = useState(false)
  const [camError,  setCamError]  = useState<string | null>(null)

  // ── Stop scanner + release camera track ──────────────────────────────────

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    if (videoRef.current?.srcObject instanceof MediaStream) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop())
      videoRef.current.srcObject = null
    }
    setTorchOn(false)
    setTorchOk(false)
  }, [])

  // ── Start scanner ────────────────────────────────────────────────────────

  const startScanner = useCallback(async () => {
    if (!videoRef.current) return
    setCamError(null)
    setStarting(true)
    stopScanner()

    try {
      // Dynamic import keeps @zxing/browser server-side-free
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      const reader = new BrowserMultiFormatReader()

      const controls = await reader.decodeFromVideoDevice(
        cameraId,
        videoRef.current,
        (result) => {
          if (!result) return
          const code = result.getText().trim().toUpperCase()
          const now  = Date.now()
          // Suppress duplicate within 2 s to avoid double-submit on the same QR
          if (
            lastScanRef.current &&
            lastScanRef.current.code === code &&
            now - lastScanRef.current.ts < 2000
          ) return
          lastScanRef.current = { code, ts: now }
          onCode(code)
        },
      )
      controlsRef.current = controls

      // Detect torch capability after stream is established
      await new Promise<void>(r => setTimeout(r, 600))
      const stream = videoRef.current?.srcObject
      if (stream instanceof MediaStream) {
        const track = stream.getVideoTracks()[0]
        const caps  = track?.getCapabilities() as ExtendedCapabilities | undefined
        setTorchOk(!!caps?.torch)
      }

      // Refresh camera labels now that permission is granted
      const { BrowserMultiFormatReader: BMF2 } = await import('@zxing/browser')
      const devices = await BMF2.listVideoInputDevices()
      if (devices.length > 0) setCameras(devices)
    } catch {
      setCamError('Failed to start camera. Check permissions and try again.')
    } finally {
      setStarting(false)
    }
  }, [cameraId, onCode, stopScanner])

  // ── Initial camera list (before permission — labels may be empty) ─────────

  useEffect(() => {
    import('@zxing/browser').then(({ BrowserMultiFormatReader }) =>
      BrowserMultiFormatReader.listVideoInputDevices()
        .then(devices => {
          if (devices.length === 0) return
          setCameras(devices)
          // Prefer back/environment camera on mobile
          const back = devices.find(d => /back|rear|environment/i.test(d.label))
          setCameraId((back ?? devices[0]).deviceId)
        })
        .catch(() => {
          // Devices may not be enumerable until permission is granted — start scanner first
        }),
    )
  }, [])

  // ── React to active / cameraId changes ───────────────────────────────────

  useEffect(() => {
    if (active) {
      startScanner()
    } else {
      stopScanner()
    }
    return stopScanner
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cameraId])

  // ── Torch toggle ─────────────────────────────────────────────────────────

  async function toggleTorch() {
    const stream = videoRef.current?.srcObject
    if (!(stream instanceof MediaStream)) return
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch { /* torch unsupported on this device */ }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">

      {/* Camera selector — only shown when multiple cameras detected */}
      {cameras.length > 1 && (
        <div className="relative">
          <Camera
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <select
            value={cameraId ?? ''}
            onChange={e => setCameraId(e.target.value)}
            className="w-full appearance-none rounded-xl border border-border bg-background py-2.5 pl-8 pr-8 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            aria-label="Select camera"
          >
            {cameras.map((c, i) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
        </div>
      )}

      {/* Viewfinder */}
      <div
        className="relative overflow-hidden rounded-2xl bg-black"
        style={{ aspectRatio: '4/3' }}
        role="img"
        aria-label="Camera viewfinder"
      >
        {/* Live video */}
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          muted
          playsInline
          autoPlay
        />

        {/* Scan-area overlay: dark strips around a 200 × 200 px target window */}
        {!camError && !starting && (
          <>
            <div
              className="pointer-events-none absolute inset-x-0 top-0 bg-black/50"
              style={{ height: 'calc(50% - 100px)' }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50"
              style={{ height: 'calc(50% - 100px)' }}
            />
            <div
              className="pointer-events-none absolute left-0 bg-black/50"
              style={{ top: 'calc(50% - 100px)', height: '200px', width: 'calc(50% - 100px)' }}
            />
            <div
              className="pointer-events-none absolute right-0 bg-black/50"
              style={{ top: 'calc(50% - 100px)', height: '200px', width: 'calc(50% - 100px)' }}
            />

            {/* Corner bracket markers */}
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ width: '200px', height: '200px' }}
              aria-hidden
            >
              <span className="absolute left-0 top-0 block h-10 w-10 rounded-tl-xl border-l-[3px] border-t-[3px] border-white" />
              <span className="absolute right-0 top-0 block h-10 w-10 rounded-tr-xl border-r-[3px] border-t-[3px] border-white" />
              <span className="absolute bottom-0 left-0 block h-10 w-10 rounded-bl-xl border-b-[3px] border-l-[3px] border-white" />
              <span className="absolute bottom-0 right-0 block h-10 w-10 rounded-br-xl border-b-[3px] border-r-[3px] border-white" />
            </div>
          </>
        )}

        {/* Starting overlay */}
        {starting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-white">
            <Loader2 className="size-8 animate-spin text-white/80" aria-hidden />
            <p className="text-[13px]">Starting camera…</p>
          </div>
        )}

        {/* Camera error overlay */}
        {camError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 p-6 text-center text-white">
            <CameraOff className="size-10 text-red-400" aria-hidden />
            <p className="text-[13px] leading-relaxed">{camError}</p>
            <button
              type="button"
              onClick={startScanner}
              className="flex items-center gap-2 rounded-xl bg-white/10 px-5 py-3 text-[13px] font-semibold transition-colors hover:bg-white/20"
            >
              <RefreshCcw className="size-3.5" aria-hidden />
              Retry
            </button>
          </div>
        )}

        {/* Torch toggle — only shown when torch is available */}
        {torchOk && !camError && (
          <button
            type="button"
            onClick={toggleTorch}
            className={cn(
              'absolute bottom-4 right-4 flex size-11 items-center justify-center rounded-full shadow-lg backdrop-blur-sm transition-colors',
              torchOn
                ? 'bg-yellow-400/90 text-yellow-900'
                : 'bg-black/60 text-white hover:bg-black/80',
            )}
            aria-label={torchOn ? 'Turn off torch' : 'Turn on torch'}
          >
            {torchOn
              ? <ZapOff className="size-5" aria-hidden />
              : <Zap   className="size-5" aria-hidden />
            }
          </button>
        )}
      </div>

      {/* Hint text */}
      {!camError && !starting && (
        <p className="text-center text-[12px] text-muted-foreground">
          Point the camera at the attendee's ticket QR code
        </p>
      )}
    </div>
  )
}
