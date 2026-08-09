'use client'

// RD-PHOTO-01 · Photo Branding — the interactive half.
//
// Upload, validation, live preview, status and the template download. Everything is composed
// from the EXISTING design system (`components/ui`, `Panel`) and the EXISTING media
// upload pattern (server presigns, browser PUTs). No new upload path, no new storage call,
// no new image pipeline — validation and preview both use the Canvas helpers Media Studio
// already relies on.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CheckCircle2, Download, Image as ImageIcon, Loader2, Trash2,
  Upload as UploadIcon,
} from 'lucide-react'
import { Banner, Button, Card, StatusChip, TextLink, useConfirm, useToast } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import { Panel } from '@/features/media-studio/components/MediaStudioShell'
import { EventContextBar } from '@/features/media-studio/components/EventContextBar'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import { putToSignedUrl } from '@/features/media-studio/utils/browserImage'
import { downloadFile } from '@/features/media-studio/utils/downloadFile'
import {
  DEFAULT_STYLE, formatBytes, formatDimensions, specFor,
} from '@/features/photo-branding/utils/artworkSpec'
import { validateOverlayFile, type OverlayIssue } from '@/features/photo-branding/utils/validateOverlay'
import { placementAsPercent } from '@/features/photo-branding/utils/placement'
// RD-PHOTO-09 — with/without comparison, and the EXISTING shared viewer for full-size
// inspection. No second lightbox is introduced.
import { BrandingCompareToggle } from '@/features/photo-branding/components/BrandingCompareToggle'
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import { buildTemplatePng, buildTemplateSvg } from '@/features/photo-branding/utils/template'
import type { BrandingResponse } from '@/app/api/organizer/media-studio/branding/route'
import { describeBrandingLock } from '@/features/photo-branding/utils/brandingLock'
import { resolveBrandingWorkflow } from '@/features/photo-branding/utils/brandingIntent'
// RD-PHOTO-07 — THE live-preview decision. Pure and unit-tested against the full truth
// table, so the state machine is verified rather than read off the JSX.
import {
  PLACEHOLDER_MESSAGE, canRenderLivePreview, previewPlaceholderReason,
  type LivePreviewFacts,
} from '@/features/photo-branding/utils/livePreview'
// RD-PHOTO-04 — one wording, shared with the import gate, the hub and the page.
import {
  BRANDING_LABEL, BRANDING_NONE, BRANDING_PERMANENT, BRANDING_WHAT, BRANDING_WHY_LOCKED,
} from '@/features/photo-branding/utils/brandingCopy'
import type { AssetListResponse } from '@/app/api/organizer/media-studio/assets/route'
import type { GalleryListResponse } from '@/app/api/organizer/media-studio/galleries/route'

const API = '/api/organizer/media-studio'
const SPEC = specFor(DEFAULT_STYLE)

/** No event chosen, or branding unreadable — the same shape the API returns. */
const EMPTY_BRANDING: BrandingResponse = {
  overlay: null,
  active:  false,
  lock:    describeBrandingLock(0),
  workflow: resolveBrandingWorkflow({
    intent: null, hasOverlay: false, overlayEnabled: false, photoCount: 0,
  }),
}

export function BrandingClient() {
  const { getToken } = useAuth()
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { event } = useMediaStudio()

  const [state,   setState]   = useState<BrandingResponse>(EMPTY_BRANDING)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [issues,  setIssues]  = useState<OverlayIssue[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  // RD-PHOTO-09 · presentation-only view state. Neither touches branding data.
  const [showOverlay, setShowOverlay] = useState(true)
  const [expanded,    setExpanded]    = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  const call = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(detail?.error ?? 'That request could not be completed.')
    }
    return await res.json() as T
  }, [getToken])

  // ── Current overlay ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) setLoading(false); return }
      if (!cancelled) setLoading(true)
      try {
        const data = await call<BrandingResponse>(`/branding?eventId=${encodeURIComponent(event.eventId)}`)
        if (!cancelled) setState(data)
      } catch {
        if (!cancelled) setState(EMPTY_BRANDING)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  // ── A real photo for the preview, when the organizer has one ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) setPreview(null); return }
      try {
        const galleries = await call<GalleryListResponse>(`/galleries?eventId=${encodeURIComponent(event.eventId)}`)
        const first = galleries.galleries.find(g => g.assetCount > 0)
        if (!first) { if (!cancelled) setPreview(null); return }
        // RD-PHOTO-08 — a HERO preview, not a grid tile. Measured: the 400px thumbnail was
        // being painted into a 1640x1093 box, a 4.1x upscale that renders as a blur.
        // `preview=1` returns medium (1600px) → original → thumbnail.
        const assets = await call<AssetListResponse>(
          `/assets?galleryId=${encodeURIComponent(first.galleryId)}&preview=1`,
        )
        const best = assets.assets[0]
        if (!cancelled) setPreview(best?.previewUrl ?? best?.thumbnailUrl ?? null)
      } catch {
        // A preview photo is a nicety. Falling back to the sample is the right failure.
        if (!cancelled) setPreview(null)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  /**
   * Validate → presign → PUT → record.
   *
   * Validation happens FIRST and entirely in the browser, so an unusable file never reaches
   * storage and the organizer is told exactly what is wrong with the one they picked.
   */
  const upload = useCallback(async (file: File) => {
    if (!event) return
    setBusy(true); setIssues([])

    try {
      const result = await validateOverlayFile(file, DEFAULT_STYLE)
      if (!result.ok) { setIssues(result.issues); return }

      const prepared = await call<{ path: string; uploadUrl: string }>('/branding', {
        method: 'POST',
        body: JSON.stringify({
          action: 'prepare', eventId: event.eventId,
          mimeType: file.type, bytes: file.size,
        }),
      })

      // The SAME helper Media Studio uses for photo renditions — timeout, abort handling
      // and error classification all inherited.
      await putToSignedUrl(prepared.uploadUrl, file, file.type)

      const next = await call<BrandingResponse>('/branding', {
        method: 'POST',
        body: JSON.stringify({
          action: 'complete', eventId: event.eventId, path: prepared.path,
          width: result.metrics.width, height: result.metrics.height,
        }),
      })

      setState(next)
      showToast('Branding saved. Photos you import from now on will carry it.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'The overlay could not be uploaded.', 'error')
    } finally {
      setBusy(false)
    }
  }, [event, call, showToast])

  const toggle = useCallback(async (enabled: boolean) => {
    if (!event) return
    setBusy(true)
    try {
      const next = await call<BrandingResponse>('/branding', {
        method: 'PATCH',
        body: JSON.stringify({ eventId: event.eventId, enabled }),
      })
      setState(next)
      showToast(enabled
        ? 'Branding enabled. Photos imported from now on will carry it.'
        : 'Branding disabled. Photos imported from now on will not carry it.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'That could not be changed.', 'error')
    } finally {
      setBusy(false)
    }
  }, [event, call, showToast])

  const remove = useCallback(async () => {
    if (!event) return
    const ok = await confirm({
      title: 'Remove branding artwork?',
      message: 'Photos you import from now on will not be branded. This is only possible because the event has no photos yet — once it does, branding is locked.',
      confirmLabel: 'Remove branding',
      tone: 'danger',
    })
    if (!ok) return

    setBusy(true)
    try {
      const next = await call<BrandingResponse>(`/branding?eventId=${encodeURIComponent(event.eventId)}`, {
        method: 'DELETE',
      })
      setState(next)
      showToast('Branding removed.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'That could not be removed.', 'error')
    } finally {
      setBusy(false)
    }
  }, [event, call, confirm, showToast])

  /** Generated in the browser from the spec — no asset to keep in sync with the rules. */
  const downloadTemplate = useCallback(async (kind: 'png' | 'svg') => {
    try {
      const blob = kind === 'png' ? await buildTemplatePng(DEFAULT_STYLE) : buildTemplateSvg(DEFAULT_STYLE)
      const url = URL.createObjectURL(blob)
      await downloadFile(url, `registerdesk-branding-template.${kind}`)
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      showToast('The template could not be generated.', 'error')
    }
  }, [showToast])

  // The preview places the overlay with the SAME function the import pipeline uses
  // (`placeOverlay`), so what is shown here is what gets baked into the stored photo.
  const placement = useMemo(() => {
    if (!state.overlay) return null
    return placementAsPercent({
      style: state.overlay.style,
      // A 3:2 frame — the shape of almost every event photograph.
      photoWidth: 3000, photoHeight: 2000,
      overlayWidth: state.overlay.width, overlayHeight: state.overlay.height,
    })
  }, [state.overlay])

  /**
   * RD-PHOTO-07 · The facts the preview decision is made from.
   *
   * Assembled here, decided in `utils/livePreview.ts`. Every value is derived in THIS render
   * pass — `state` from the last `setState`, `placement` from a `useMemo` keyed on
   * `state.overlay` — so deleting, uploading, enabling or disabling flips the outcome in the
   * same commit. No effect, no refetch, no refresh.
   */
  const previewFacts: LivePreviewFacts = {
    hasPhoto:        Boolean(preview),
    hasOverlay:      Boolean(state.overlay),
    brandingEnabled: state.active,
    hasPlacement:    Boolean(placement),
  }
  const showLivePreview = canRenderLivePreview(previewFacts)

  return (
    <div className="space-y-6">
      <Panel label="Event" title="Branding is set per event.">
        <EventContextBar />
      </Panel>

      {event && (
        <>
          {/* ── Branding: preview beside its controls (RD-PHOTO-09) ──
              One panel, not two. The preview used to be full-width (1093px of photo on a
              1640px column) with every management control below the fold — the artefact
              prioritised over the workflow. */}
          <Panel
            label="Branding"
            title="Your artwork, previewed on a real photo"
            action={showLivePreview
              ? <BrandingCompareToggle showOverlay={showOverlay} onChange={setShowOverlay} />
              : undefined}
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">

              {/* ═══ preview column ═══ */}
              <div className="min-w-0 space-y-2">
                {showLivePreview ? (
                  <>
                    {/* Click to inspect at full resolution. A button rather than a div, so
                        it is reachable and operable from the keyboard. */}
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      aria-label="View the preview at full size"
                      className="block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <LivePreview
                        photoUrl={preview!}
                        overlayUrl={state.overlay!.url}
                        placement={placement!}
                        showOverlay={showOverlay}
                      />
                    </button>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-fs-2xs text-muted-foreground">
                        Previewing one of your imported photos.
                      </p>
                      <TextLink onClick={() => setExpanded(true)}>View full size</TextLink>
                    </div>
                  </>
                ) : (
                  <>
                    <PreviewPlaceholder overlay={state.overlay} facts={previewFacts} />
                    <p className="text-fs-2xs text-muted-foreground">
                      Import photos for this event and your branding is previewed against a
                      real one.
                    </p>
                  </>
                )}
              </div>

              {/* ═══ management column ═══ */}
              <div className="min-w-0 space-y-3">
                {loading ? (
                  <p className="text-fs-sm text-muted-foreground">Loading…</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-fs-md font-semibold text-foreground">
                        {state.overlay ? 'Overlay uploaded' : 'No overlay yet'}
                      </h3>
                      {state.overlay && (
                        <StatusChip tone={state.active ? 'success' : 'neutral'}>
                          {state.active ? 'Branding on' : 'Branding off'}
                        </StatusChip>
                      )}
                    </div>

                    {state.overlay ? (
                      <dl className="space-y-0.5 text-fs-2xs text-muted-foreground">
                        <div>{formatDimensions(state.overlay.width, state.overlay.height)} · {formatBytes(state.overlay.bytes)}</div>
                        <div>Uploaded {new Date(state.overlay.uploadedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                        <div>Last updated {new Date(state.overlay.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                      </dl>
                    ) : (
                      <p className="text-fs-sm text-muted-foreground">{BRANDING_WHAT}</p>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={fileRef} type="file" accept="image/png" className="sr-only"
                        onChange={e => {
                          const file = e.target.files?.[0]
                          e.target.value = ''
                          if (file) void upload(file)
                        }}
                      />
                      <Button size="sm" disabled={busy || state.lock.locked} onClick={() => fileRef.current?.click()}>
                        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UploadIcon className="size-4" aria-hidden />}
                        {state.overlay ? 'Replace overlay' : 'Upload overlay'}
                      </Button>
                      {state.overlay && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy || state.lock.locked} onClick={() => void toggle(!state.active)}>
                            {state.active ? 'Disable' : 'Enable'}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy || state.lock.locked} onClick={() => void remove()}>
                            <Trash2 className="size-4" aria-hidden /> Remove
                          </Button>
                        </>
                      )}
                    </div>

                    {/* RD-PHOTO-03 — said plainly, with the count, and never as a silent
                        disabled button. The server refuses these operations too. */}
                    {state.lock.locked && (
                      <Banner tone="warning" title={BRANDING_LABEL.locked}>
                        This event already has {state.lock.photoCount.toLocaleString('en-IN')}{' '}
                        photo{state.lock.photoCount === 1 ? '' : 's'}. {BRANDING_WHY_LOCKED}
                      </Banner>
                    )}

                    {issues.map(issue => (
                      <Banner key={issue.code} tone="error" title="That artwork cannot be used">
                        {issue.message}
                      </Banner>
                    ))}
                  </>
                )}
              </div>
            </div>
          </Panel>

          {/* ── Templates ── */}
          <Panel
            label="Design templates" title={`Correctly sized at ${formatDimensions(SPEC.recommendedWidth, SPEC.recommendedHeight)}, with the safe area marked.`}
          >
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void downloadTemplate('png')}>
                <Download className="size-4" aria-hidden /> PNG template
              </Button>
              <Button size="sm" variant="outline" onClick={() => void downloadTemplate('svg')}>
                <Download className="size-4" aria-hidden /> SVG template
              </Button>
            </div>
            <p className="text-fs-2xs text-muted-foreground">
              Both are generated from the same specification this page validates against, so a
              template can never describe a rule that has changed. Photoshop and Figma starter
              files are not generated — open the SVG in either, or design to the sizes above.
            </p>
          </Panel>
        </>
      )}

      {!event && !loading && (
        <Banner tone="info" title="Choose an event">
          Branding is set per event. Pick one above to upload artwork.
        </Banner>
      )}

      {/* What THIS event's photos will get. One line, from the resolved state — never a
          second explanation of how branding works. */}
      {event && !loading && (
        <p className="flex items-start gap-2 text-fs-2xs text-muted-foreground">
          <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
          {state.workflow.brandingApplies ? BRANDING_PERMANENT : BRANDING_NONE}
        </p>
      )}

      {/* RD-PHOTO-09 — the EXISTING shared viewer (public gallery, organizer browser).
          Full 1600px inspection on demand, so the inline preview never has to be large. */}
      {preview && (
        <ImageLightbox
          open={expanded}
          src={preview}
          alt="Your photo at full size"
          onClose={() => setExpanded(false)}
        />
      )}

      {/* RD-MS-CLOSURE-02 · a `role="status"` region whose only child was an `opacity-0`
          icon used to render here while `busy`. It announced nothing to a screen reader —
          a live region with no text content — and drew nothing on screen, while still
          taking a line box at the end of the panel. The upload/toggle/remove buttons above
          already carry the real busy affordance (their own spinner, via the same `busy`
          flag), so this was vestigial rather than a second indicator. Deleted, not hidden. */}
    </div>
  )
}

/**
 * RD-PHOTO-07 · The preview itself.
 *
 * Rendered ONLY when `canRenderLivePreview` is true, so all three inputs are guaranteed
 * present and none of them is re-tested here. The dashed "Your branding appears here" band
 * that used to sit inside this box existed purely to fill it when there was no artwork; that
 * state can no longer reach this component, so the band is deleted rather than left dead.
 */
function LivePreview({
  photoUrl, overlayUrl, placement, showOverlay,
}: {
  photoUrl: string
  overlayUrl: string
  placement: CSSProperties
  showOverlay: boolean
}) {
  return (
    // RD-PHOTO-09 — the width is BOUNDED and responsive.
    //
    // `aspect-[3/2]` derives height from width, so an unbounded `w-full` produced 1093px on
    // a 1640px column and grew with the viewport. `clamp(520px, 65vw, 900px)` scales with the
    // screen, floors at a size where the 19%-tall banner is still legible, and ceilings well
    // below the medium rendition's native 1600px so the image is never upscaled.
    //
    // It is a max-WIDTH, not a max-height: height stays derived from the true 3:2 ratio, so
    // nothing is cropped or letterboxed. Below ~520px the container is narrower than the
    // floor and simply wins — no overflow on mobile.
    <Card
      padded={false}
      className="overflow-hidden"
      style={{ maxWidth: 'clamp(520px, 65vw, 900px)' }}
    >
      <div className="relative aspect-[3/2] w-full bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photoUrl}
          alt="One of your photos, showing where branding appears"
          className="size-full object-cover"
        />
        {/* Hidden, not unmounted, when comparing: the photo underneath must not reflow. */}
        {showOverlay && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={overlayUrl}
            alt=""
            aria-hidden
            className="absolute object-fill"
            style={placement}
          />
        )}
      </div>
    </Card>
  )
}

/**
 * RD-PHOTO-06 · What the preview shows before any photo exists.
 *
 * FIXED height (200px) on purpose. The full preview uses `aspect-[3/2]`, which computes
 * height from width and therefore scales to ~1050px on a wide screen — acceptable when it
 * frames a real photograph, and a viewport of dead space when it frames nothing.
 *
 * When artwork has been uploaded it is shown here at a bounded size, so an organizer can
 * still see what they uploaded without needing to import a photo first.
 */
function PreviewPlaceholder({
  overlay, facts,
}: { overlay: BrandingResponse['overlay']; facts: LivePreviewFacts }) {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 text-center">
      {overlay ? (
        <>
          {/* Checkerboard behind it: on a plain background transparency is
              indistinguishable from white, which is the commonest way an overlay upload
              goes wrong. */}
          <div
            className="max-w-xs overflow-hidden rounded-lg border border-border"
            style={{
              backgroundImage:
                'linear-gradient(45deg,var(--muted) 25%,transparent 25%,transparent 75%,var(--muted) 75%),'
                + 'linear-gradient(45deg,var(--muted) 25%,transparent 25%,transparent 75%,var(--muted) 75%)',
              backgroundSize: '12px 12px',
              backgroundPosition: '0 0, 6px 6px',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={overlay.url}
              alt="Your event branding overlay"
              width={overlay.width}
              height={overlay.height}
              className="h-auto w-full max-h-20 object-contain"
            />
          </div>
          <p className="text-fs-sm font-semibold text-foreground">
            {facts.brandingEnabled ? 'Your artwork is ready' : 'Branding is currently disabled'}
          </p>
        </>
      ) : (
        <>
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted" aria-hidden>
            <ImageIcon className="size-5 text-muted-foreground" />
          </div>
          <p className="text-fs-base font-semibold text-foreground">Nothing to preview yet</p>
        </>
      )}

      {/* ONE message per state, from the tested map — never re-derived here. */}
      <p className="max-w-sm text-fs-sm leading-relaxed text-muted-foreground">
        {PLACEHOLDER_MESSAGE[previewPlaceholderReason(facts)]}
      </p>
    </div>
  )
}
