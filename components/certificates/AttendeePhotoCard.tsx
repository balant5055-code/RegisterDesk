'use client'

// RD-CERT-PHOTO-01 — the attendee's optional certificate photo.
//
// OPTIONAL IS THE POINT. Nothing here blocks a certificate: the card states that the photo
// is optional, offers "Continue without photo", and an attendee who never touches it gets
// exactly the certificate they would have got before this feature existed.
//
// ═══ ALL PROCESSING HAPPENS IN THE BROWSER ═══════════════════════════════════
// The crop, the orientation fix and the resize to <=1024px all run on the device, and only
// the finished ~150-400 KB JPEG is uploaded. That is the cheap architecture: no original is
// ever transmitted or stored, no server-side image pipeline exists, and no thumbnail or
// medium rendition is generated. ONE object per attendee, replaced in place.
//
// Reuses the existing ImageCropperModal (crop / zoom / move / rotate / preview / reset,
// plus the flip it gained here). No second cropper, no new dependency.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, Trash2, ImageOff } from 'lucide-react'
import { ImageCropperModal } from '@/components/ui/ImageCropperModal'
import { cn } from '@/lib/utils/cn'

/**
 * The stored photo's longest edge. NOT the size it is printed at — the organizer's
 * certificate template owns the display box. 1024px is comfortably more resolution than a
 * photo box on an A4 certificate consumes, while keeping the object small.
 */
const MAX_EDGE = 1024
/** Visually high quality; still lands a 1024px portrait at roughly 150–400 KB. */
const JPEG_QUALITY = 0.82

/** Portrait 4:5 — the shape a person photograph wants. The template box may differ; the
 *  renderer letterboxes with `contain`, so a mismatch never crops a face. */
const CROP_CONFIG = {
  label:        'Adjust your photo',
  aspect:       4 / 5,
  outputWidth:  Math.round(MAX_EDGE * 0.8),   // 819 × 1024 — longest edge is MAX_EDGE
  outputHeight: MAX_EDGE,
}

type Status = 'idle' | 'loading' | 'saving' | 'removing'

export function AttendeePhotoCard({
  endpoint,
  grant,
  description,
  onContinue,
  className,
}: {
  /**
   * The GET/POST/DELETE endpoint for THIS photo, already carrying whatever identifies the
   * target (a registrationId for the signed-in portal, a certificateId for the public
   * Certificate Center). The card never constructs it, so it cannot address the wrong
   * registration — and it never learns a registration id in the public flow.
   */
  endpoint: string
  /** Certificate-photo grant for the public flow. Omitted in the portal, where the
   *  attendee session cookie is the credential. A primitive, so the effect below has a
   *  stable dependency. */
  grant?: string
  /** Overrides the explanatory line — the public flow already knows the template has a
   *  photo area, so it should not say "if". */
  description?: string
  /** Optional "I'm done here" affordance — the card works standalone without it. */
  onContinue?: () => void
  className?: string
}) {
  const [status,   setStatus]   = useState<Status>('loading')
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [pending,  setPending]  = useState<string | null>(null)   // object URL being cropped
  const [error,    setError]    = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = status === 'saving' || status === 'removing'

  /** The grant travels in a header, never in the URL — a query string ends up in history,
   *  in referrers and in server logs, and this one is a write credential. */
  const authHeaders = useCallback(
    (): Record<string, string> => (grant ? { 'X-Certificate-Grant': grant } : {}),
    [grant],
  )

  /** Imperative reload, used after a save or removal. Called from event handlers only. */
  const reload = useCallback(async () => {
    try {
      const res  = await fetch(endpoint, { headers: authHeaders() })
      const data = await res.json() as { hasPhoto?: boolean; url?: string | null }
      setPhotoUrl(res.ok && data.hasPhoto ? data.url ?? null : null)
    } catch {
      setPhotoUrl(null)
    } finally {
      setStatus('idle')
    }
  }, [endpoint, authHeaders])

  // The initial read lives INSIDE the effect, matching every other data-loading component
  // in the repo (see useMediaDefaults): a hoisted useCallback would be traced by
  // `react-hooks/set-state-in-effect` as a synchronous set, which it is not — the state
  // lands after an await, on a later tick.
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const res  = await fetch(endpoint, { headers: grant ? { 'X-Certificate-Grant': grant } : {} })
        const data = await res.json() as { hasPhoto?: boolean; url?: string | null }
        if (!cancelled) setPhotoUrl(res.ok && data.hasPhoto ? data.url ?? null : null)
      } catch {
        if (!cancelled) setPhotoUrl(null)
      } finally {
        if (!cancelled) setStatus('idle')
      }
    }
    void run()

    return () => { cancelled = true }
  }, [endpoint, grant])

  // Revoke the object URL we created for the cropper, so a long session cannot leak blobs.
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending) }, [pending])

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''                       // allow re-picking the same file
    if (!file) return
    if (!/^image\//.test(file.type)) { setError('That file is not an image.'); return }
    setError(null)
    setPending(URL.createObjectURL(file))
  }

  async function handleApply(cropped: File) {
    if (pending) URL.revokeObjectURL(pending)
    setPending(null)
    setStatus('saving')
    setError(null)
    try {
      // The shared cropper has already cropped, oriented and resized to CROP_CONFIG; it
      // always emits PNG. Re-encode here rather than teaching the shared component about
      // output formats: a lossless 819×1024 PNG of a photograph is several megabytes, and
      // this feature's whole size budget (~150–400 KB) depends on JPEG. The pixels are
      // unchanged — only the container is.
      const file = await encodeAsJpeg(cropped)
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': file.type, ...authHeaders() },
        body:    file,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? 'upload_failed')
      }
      await reload()
    } catch (err) {
      setError(messageFor(err instanceof Error ? err.message : 'upload_failed'))
      setStatus('idle')
    }
  }

  async function handleRemove() {
    setStatus('removing')
    setError(null)
    try {
      await fetch(endpoint, { method: 'DELETE', headers: authHeaders() })
      setPhotoUrl(null)
    } catch {
      setError('Could not remove the photo. Please try again.')
    } finally {
      setStatus('idle')
    }
  }

  return (
    <section className={cn('rounded-2xl border border-border/60 bg-card p-4 sm:p-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-fs-md font-bold text-foreground">
            Add your photo <span className="font-medium text-muted-foreground">(optional)</span>
          </h2>
          <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
            {description ?? 'If your organizer’s certificate has a photo area, this is the picture that appears on it. You can skip this — your certificate works either way.'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* Preview — 4:5, the shape the photo is stored in. */}
        <div className="mx-auto w-32 shrink-0 sm:mx-0">
          <div className="aspect-[4/5] w-full overflow-hidden rounded-xl border border-border bg-muted/40">
            {status === 'loading' ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoUrl} alt="Your certificate photo" className="size-full object-cover" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
                <ImageOff className="size-5" aria-hidden />
                <span className="text-fs-2xs">No photo</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={pickFile}
          />

          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted/40 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {status === 'saving'
              ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Saving…</>
              : <><Camera className="size-4" aria-hidden /> {photoUrl ? 'Replace photo' : 'Upload photo'}</>}
          </button>

          {photoUrl && (
            <button
              type="button"
              disabled={busy}
              onClick={handleRemove}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-fs-sm font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {status === 'removing'
                ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Removing…</>
                : <><Trash2 className="size-4" aria-hidden /> Remove photo</>}
            </button>
          )}

          {onContinue && (
            <button
              type="button"
              disabled={busy}
              onClick={onContinue}
              className="inline-flex h-11 w-full items-center justify-center rounded-xl px-4 text-fs-sm font-semibold text-primary underline-offset-4 hover:underline disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {photoUrl ? 'Continue' : 'Continue without photo'}
            </button>
          )}

          {error && (
            <p role="alert" className="text-fs-2xs font-medium text-destructive">{error}</p>
          )}
          <p className="text-fs-2xs leading-relaxed text-muted-foreground">
            Your photo is private. It is only used on your certificate.
          </p>
        </div>
      </div>

      {pending && (
        <ImageCropperModal
          imageSrc={pending}
          config={CROP_CONFIG}
          // The cropper mints a preview object URL for callers that show an optimistic
          // thumbnail. This card re-reads the stored photo via reload() instead, so the URL
          // is released immediately rather than leaking one blob per crop.
          onApply={(file, previewUrl) => { URL.revokeObjectURL(previewUrl); void handleApply(file) }}
          onCancel={() => { if (pending) URL.revokeObjectURL(pending); setPending(null) }}
        />
      )}
    </section>
  )
}

/**
 * Re-encode the cropper's PNG as JPEG at JPEG_QUALITY, at its existing pixel dimensions.
 *
 * Falls back to the original file if the browser cannot produce a JPEG blob: a slightly
 * larger upload is strictly better than refusing the attendee's photo, and the server accepts
 * PNG too. Nothing here resizes — CROP_CONFIG already fixed the dimensions.
 */
async function encodeAsJpeg(source: File): Promise<File> {
  const url = URL.createObjectURL(source)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload  = () => resolve(el)
      el.onerror = () => reject(new Error('decode_failed'))
      el.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width  = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return source
    // JPEG has no alpha; paint white first so any transparency composites predictably
    // rather than turning black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    })
    if (!blob) return source
    return new File([blob], 'photo.jpg', { type: 'image/jpeg' })
  } catch {
    return source
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Server error codes → something an attendee can act on. */
function messageFor(code: string): string {
  switch (code) {
    case 'too_large':        return 'That image is too large. Please choose a smaller one.'
    case 'unsupported_type': return 'That file type is not supported. Use a JPEG, PNG or WebP image.'
    case 'forbidden':        return 'You are not signed in as the owner of this registration.'
    case 'unauthorized':     return 'Please sign in again to update your photo.'
    case 'not_found':        return 'We could not find that registration.'
    default:                 return 'Could not save the photo. Please try again.'
  }
}
