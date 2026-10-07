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

/**
 * The one static we need off @zxing/browser's reader class.
 *
 * `BrowserCodeReader` keeps every stream it creates in a static `streamTracker` and
 * `releaseAllStreams()` stops all of them. Typed structurally so the class can be
 * held without importing it eagerly — the dynamic import is what keeps this module
 * server-side-free.
 */
type ZxingReaderStatics = { releaseAllStreams: () => void }

export default function QrScanner({ active, onCode }: Props) {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  // Duplicate-scan guard: same code within 2 s is ignored
  const lastScanRef = useRef<{ code: string; ts: number } | null>(null)

  /**
   * Which scanner start is the CURRENT one.
   *
   * ═══ THE LEAK THIS CLOSES ══════════════════════════════════════════════════
   * `startScanner` is async: it awaits a dynamic import and then
   * `decodeFromVideoDevice`, which is where getUserMedia actually happens. The
   * effect cleanup is synchronous. So a start could be superseded — by the
   * `cameraId` this component sets after enumerating devices, by `active`
   * toggling on every admission, or by the page unmounting — while still in
   * flight. Cleanup then ran with `controlsRef` still null and `srcObject` still
   * unset, so it stopped nothing, and the in-flight start went on to create a
   * stream that nothing held a reference to any more. Measured live: two
   * getUserMedia calls, both tracks left `live`, camera indicator stayed on after
   * leaving the page.
   *
   * Every start captures this counter, and `stopScanner` bumps it. A start that
   * finds the counter moved knows it lost, and stops what IT created rather than
   * handing it to a ref that now belongs to somebody else.
   */
  const runIdRef = useRef(0)

  /** The reader class, kept so cleanup can sweep streams without an await. */
  const readerRef = useRef<ZxingReaderStatics | null>(null)

  const [cameras,   setCameras]   = useState<MediaDeviceInfo[]>([])
  const [cameraId,  setCameraId]  = useState<string | undefined>()
  const [torchOn,   setTorchOn]   = useState(false)
  const [torchOk,   setTorchOk]   = useState(false)
  const [starting,  setStarting]  = useState(false)
  const [camError,  setCamError]  = useState<string | null>(null)
  /**
   * Has device enumeration finished (successfully or not)?
   *
   * ═══ WHY THE START WAITS FOR IT ════════════════════════════════════════════
   * Enumeration sets `cameraId`, which is a dependency of the start effect. So the
   * component used to start the camera TWICE on every mount: once with
   * `cameraId: undefined`, then again the moment enumeration resolved. Two
   * getUserMedia calls, two streams, one of them immediately superseded — which is
   * precisely the race that leaked. Measured before this change: `2 call(s), 2 live`.
   *
   * Waiting costs one `enumerateDevices()` round trip and removes the duplicate
   * stream entirely rather than merely making it safe. The run-token guard below
   * still stands: it covers unmount and `active` toggling, which no amount of
   * ordering can eliminate.
   */
  const [devicesReady, setDevicesReady] = useState(false)

  // ── Stop scanner + release camera track ──────────────────────────────────

  const stopScanner = useCallback(() => {
    // Retire every in-flight start FIRST. Anything still awaiting will see the
    // counter has moved and dispose of its own result instead of committing it.
    runIdRef.current += 1

    controlsRef.current?.stop()
    controlsRef.current = null
    if (videoRef.current?.srcObject instanceof MediaStream) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop())
      videoRef.current.srcObject = null
    }

    // The sweeper. The two lines above can only ever reach the LAST stream — the
    // ref holds one set of controls and the element holds one srcObject — so a
    // stream orphaned by an earlier race is unreachable through either, by
    // construction. `releaseAllStreams` walks zxing's own static registry of every
    // stream it has created, which is the only place an orphan still exists.
    //
    // Global to the library, and safe here for a specific reason rather than by
    // assumption: this component is the only camera consumer in the repository and
    // only one instance is ever mounted (it renders solely under `mode === 'scan'`).
    readerRef.current?.releaseAllStreams()

    setTorchOn(false)
    setTorchOk(false)
  }, [])

  // ── Start scanner ────────────────────────────────────────────────────────

  const startScanner = useCallback(async () => {
    // Captured once, before any await. Cleanup may detach the ref while this start
    // is in flight; the element itself stays valid to hand to zxing either way.
    const video = videoRef.current
    if (!video) return
    setCamError(null)
    setStarting(true)
    stopScanner()

    // AFTER stopScanner, which bumps the counter — this is now the current run.
    const myRun = runIdRef.current
    /** True once any later start, or cleanup, has superseded this one. */
    const superseded = () => runIdRef.current !== myRun

    try {
      // Dynamic import keeps @zxing/browser server-side-free
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      // Held for the sweep in stopScanner, which cannot await.
      readerRef.current = BrowserMultiFormatReader as unknown as ZxingReaderStatics
      if (superseded()) return
      const reader = new BrowserMultiFormatReader()

      const controls = await reader.decodeFromVideoDevice(
        cameraId,
        video,
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
      // ═══ THE RACE GATE ═════════════════════════════════════════════════════
      // getUserMedia has already run inside decodeFromVideoDevice, so a camera is
      // live at this point whether or not this run still matters. If it does not,
      // this start owns the only reference to that stream and must dispose of it
      // here — committing it to `controlsRef` would hand it to a run that has
      // moved on and orphan whatever that run created.
      if (superseded()) {
        controls.stop()
        return
      }
      controlsRef.current = controls

      // Detect torch capability after stream is established
      await new Promise<void>(r => setTimeout(r, 600))
      if (superseded()) return
      const stream = videoRef.current?.srcObject
      if (stream instanceof MediaStream) {
        const track = stream.getVideoTracks()[0]
        const caps  = track?.getCapabilities() as ExtendedCapabilities | undefined
        setTorchOk(!!caps?.torch)
      }

      // Refresh camera labels now that permission is granted
      const { BrowserMultiFormatReader: BMF2 } = await import('@zxing/browser')
      const devices = await BMF2.listVideoInputDevices()
      if (superseded()) return
      if (devices.length > 0) setCameras(devices)
    } catch {
      if (superseded()) return
      setCamError('Failed to start camera. Check permissions and try again.')
    } finally {
      // Only the current run owns the spinner; a superseded one must not clear a
      // later run's "Starting camera…".
      if (!superseded()) setStarting(false)
    }
  }, [cameraId, onCode, stopScanner])

  // ── Initial camera list (before permission — labels may be empty) ─────────

  useEffect(() => {
    import('@zxing/browser').then(({ BrowserMultiFormatReader }) => {
      // Arm the sweeper as early as the module is available, so a cleanup that runs
      // before any start still has something to call.
      readerRef.current = BrowserMultiFormatReader as unknown as ZxingReaderStatics
      return BrowserMultiFormatReader.listVideoInputDevices()
        .then(devices => {
          if (devices.length === 0) return
          setCameras(devices)
          // Prefer back/environment camera on mobile
          const back = devices.find(d => /back|rear|environment/i.test(d.label))
          setCameraId((back ?? devices[0]).deviceId)
        })
        .catch(() => {
          // Devices may not be enumerable until permission is granted — start scanner first
        })
        // Released in BOTH outcomes: a failed enumeration must not leave the camera
        // permanently unstarted, it simply means zxing picks the default device.
        .finally(() => setDevicesReady(true))
    }).catch(() => setDevicesReady(true))
  }, [])

  // ── React to active / cameraId changes ───────────────────────────────────

  useEffect(() => {
    // `devicesReady` gates only the FIRST start: once enumeration has settled,
    // `cameraId` is final, so this effect runs once instead of twice and exactly one
    // stream is created per session.
    if (active && devicesReady) {
      startScanner()
    } else {
      stopScanner()
    }
    return stopScanner
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cameraId, devicesReady])

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
            <Loader2 className="size-8 animate-spin text-white/80 motion-reduce:animate-none" aria-hidden />
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
        <p className="text-center text-[13px] text-muted-foreground">
          Point the camera at the attendee's ticket QR code
        </p>
      )}
    </div>
  )
}
