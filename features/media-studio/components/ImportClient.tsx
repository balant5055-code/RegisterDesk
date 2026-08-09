'use client'

// RD-MEDIA-01 · Import Media — the upload workflow.
// RD-MEDIA-UX-01 · Rebuilt as a two-pane workspace.
//
// ─── What this refactor changed, and what it did NOT ─────────────────────────
// PRESENTATION ONLY. Every handler, effect, ref, fetch and business rule above the
// `return` is carried forward unchanged — the upload queue, the branding gate, the
// compression estimate and the gallery creation flow all behave exactly as before.
//
// The page was seven numbered full-width sections stacked to ~1,900px, with the primary
// action at the bottom and the destination restated three times. It is now:
//
//   Workspace bar          where am I uploading to
//   Left  · workflow       Destination · Branding · Photos · Compression · Queue
//   Right · summary rail   the facts, the readiness checklist, and the ONE action
//
// ─── The scroll fix is structural ────────────────────────────────────────────
// EVERY panel is mounted unconditionally. Empty and disabled states live INSIDE panels
// rather than being expressed by absence, so selecting a gallery — or the events fetch
// resolving after hydration — changes inner content only. The panel count and the
// document skeleton never change, so Chrome has no insertion to anchor against. No
// `overflow-anchor`, no negative margins, no CSS hack.
//
// ─── What changed, and why ───────────────────────────────────────────────────
// The event is no longer chosen here. It belongs to the workspace
// (`MediaStudioContext`), so it is chosen once and every page inherits it.
//
// A missing gallery used to send the organizer to a different page to create one — which
// asked for the event a second time and, on the way back, discarded the files they had
// already selected. A gallery is now created INLINE, from the same event-driven suggestions
// the Galleries page uses, and is selected the moment it exists. Nothing unmounts, so
// nothing is lost.
//
// Folder upload uses `webkitdirectory`, which every current browser supports and which is
// the only way to select a directory tree from a file input.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen, FolderPlus, Images, Plus, RefreshCw, Upload, Wallet, X,
} from 'lucide-react'
import {
  Banner, Button, EmptyState, StatusChip, TextLink, useConfirm, useToast,
} from '@/components/ui'
// RD-MEDIA-PERF-03 — a memoized row so a 3,000-photo import does not reconcile every
// visible row on every state change.
import { UploadRow } from './UploadProgress'
// RD-MEDIA-UX-01 — the workspace shell pieces.
import { ImportWorkspaceBar } from './ImportWorkspaceBar'
import { ImportSummaryRail, type RailState } from './ImportSummaryRail'
import { BuyCreditsDialog } from '@/features/media-credits/components/BuyCreditsDialog'
import {
  ImportCreditsCard, creditVerdict, estimateCost,
  type ImportSessionStatus,
} from './ImportCreditsCard'
// RD-MEDIA-UX-07 — the rail column owns `sticky`, so the grid item is content-sized rather
// than stretched to the workflow column's height.
import { MEDIA_RAIL_COLUMN } from './workspace'
import { CompressionSelector } from './CompressionSelector'
// RD-MEDIA-IMPORT-UX — one scrolling chip strip, with edge fades and horizontal-only
// scroll-into-view. Shared by the gallery and album rows.
import { ScrollRow } from './ScrollRow'
import { useAuth } from '@/components/auth/AuthProvider'
import { ROUTES } from '@/config/navigation'
import { Panel } from './MediaStudioShell'
import { EventContextBar } from './EventContextBar'
import { useMediaStudio, withEvent } from '@/features/media-studio/context/MediaStudioContext'
// RD-MEDIA-02: gallery suggestions come from the EVENT's template. Media Studio is a
// PLATFORM module and holds no event-specific names of its own.
import { CUSTOM_GALLERY_KEY, resolveGalleryTemplate } from '@/lib/events/galleryTemplates'
import {
  COMPRESSION_PROFILES, DEFAULT_PROFILE_ID, estimateBatch, findProfile,
} from '@/features/media-studio/utils/compressionProfiles'
import type { AlbumView, GalleryView } from '@/features/media-studio/types'
import type { GalleryListResponse, GalleryCreateResponse } from '@/app/api/organizer/media-studio/galleries/route'
import type { AlbumListResponse } from '@/app/api/organizer/media-studio/albums/route'
import type { BrandingResponse } from '@/app/api/organizer/media-studio/branding/route'
// RD-PHOTO-04 — the workflow gate. Import is where the irreversible branding decision is
// made, so it is where the decision is asked.
import { BrandingGate } from '@/features/photo-branding/components/BrandingGate'
import type { BrandingIntent } from '@/features/photo-branding/utils/brandingIntent'

const API = '/api/organizer/media-studio'
const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif'
// RD-MS-CLOSURE-01 · the rendition plan is no longer a constant here. It is resolved
// global → plan → event and reaches this component through the workspace context, so a
// plan-level storage decision actually applies to the upload it was made for.

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

/**
 * MS-FINAL-01 · Names the photo a duplicate matched, so the row is checkable.
 *
 * An intra-batch repeat has no stored asset behind it — the scanner reports the earlier
 * QUEUE item as the match — so it says so rather than showing an empty gallery id.
 */
function duplicateReason(m: { originalFilename: string | null; uploadedAtMs: number; galleryId: string }): string {
  if (!m.galleryId) return 'Selected twice in this batch.'
  const name = m.originalFilename ?? 'an existing photo'
  const when = m.uploadedAtMs > 0
    ? new Date(m.uploadedAtMs).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null
  return when
    ? `Already uploaded as ${name} on ${when}.`
    : `Already uploaded as ${name}.`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function ImportClient() {
  const { getToken } = useAuth()

  // ── MS-IMPORT-01 · credits ────────────────────────────────────────────────
  // Read on mount, and again after a purchase completes here (MC-08.2). Still deliberately
  // NOT polled: the balance an organizer needs is the one they had when they queued the
  // batch, and a number that shifts under them mid-review is worse than a slightly stale
  // one. A purchase is the exception because they caused it and are waiting to see it. The
  // authoritative check happens server-side at session open, which is what actually refuses
  // an unaffordable upload.
  const [credits, setCredits] = useState<{
    enabled: boolean; balance: number; held: number; available: number; creditsPerPhoto: number
  } | null>(null)
  const [creditsLoading, setCreditsLoading] = useState(true)
  const [creditsError, setCreditsError] = useState<string | null>(null)

  // MC-08.2 · Shortfall the Buy dialog should open on, or false when it is closed.
  // Buying happens HERE rather than on the Credits page because the queued files live in
  // browser state — navigating away to buy would discard the batch being prepared.
  const [buyingShortfall, setBuyingShortfall] = useState<number | false>(false)
  // Server unit price, needed to price the packs. Read from the same balance response, so
  // there is no second endpoint and no rate invented on the client.
  const [unitPricePaise, setUnitPricePaise] = useState(0)
  const { showToast } = useToast()
  const { prompt }    = useConfirm()

  // Event, gallery, album, profile and the queue all live in the workspace context, so
  // walking to another Media Studio page and back preserves every one of them.
  const {
    event, galleryId, setGalleryId, albumId, setAlbumId, profileId, setProfileId, queue,
    renditionPlan,
  } = useMediaStudio()

  const [galleries, setGalleries] = useState<GalleryView[]>([])
  const [albums,    setAlbums]    = useState<AlbumView[]>([])
  const [creating,  setCreating]  = useState(false)
  // RD-PHOTO-03: branding is applied HERE, during import, so the wizard has to know about
  // it before the first byte is processed.
  const [branding,  setBranding]  = useState<BrandingResponse | null>(null)
  const [brandingLoading, setBrandingLoading] = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  const fileRef   = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

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

  // ── Galleries for the workspace's event ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      // Cleared inside the async body, not synchronously in the effect: a synchronous
      // setState here would cascade a second render on every event change.
      if (!event) { if (!cancelled) setGalleries([]); return }
      try {
        const data = await call<GalleryListResponse>(`/galleries?eventId=${encodeURIComponent(event.eventId)}`)
        if (!cancelled) setGalleries(data.galleries)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load galleries.')
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  // ── The event's branding ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) { setBranding(null); setBrandingLoading(false) } return }
      if (!cancelled) setBrandingLoading(true)
      try {
        const data = await call<BrandingResponse>(`/branding?eventId=${encodeURIComponent(event.eventId)}`)
        if (!cancelled) setBranding(data)
      } catch {
        // Unreadable branding must not block an import of an UNBRANDED event. If the event
        // does have branding, `prepareOverlay` fails loudly at Start rather than quietly
        // importing unbranded photos.
        if (!cancelled) setBranding(null)
      } finally {
        if (!cancelled) setBrandingLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  /**
   * What the upload queue needs. Derived from the RESOLVED state, so the wizard's promise
   * and the pipeline's behaviour are one fact rather than two kept in sync.
   */
  const brandingSource = useMemo(
    () => (event && branding?.workflow.brandingApplies && branding.overlay
      ? { eventId: event.eventId, style: branding.overlay.style }
      : null),
    [event, branding],
  )

  /** Records the once-per-event decision and refreshes the resolved state. */
  const decideBranding = useCallback(async (intent: BrandingIntent) => {
    if (!event) return
    try {
      const next = await call<BrandingResponse>('/branding', {
        method: 'POST',
        body: JSON.stringify({ action: 'decide', eventId: event.eventId, intent }),
      })
      setBranding(next)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'That choice could not be saved.', 'error')
    }
  }, [event, call, showToast])

  const gallery = useMemo(
    () => galleries.find(g => g.galleryId === galleryId) ?? null,
    [galleries, galleryId],
  )

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!gallery) {
        // Cleared inside the async body, not synchronously in the effect: a synchronous
        // setState here would cascade a second render on every gallery change.
        if (!cancelled) setAlbums([])
        return
      }
      try {
        const data = await call<AlbumListResponse>(`/albums?galleryId=${encodeURIComponent(gallery.galleryId)}`)
        if (!cancelled) setAlbums(data.albums)
      } catch { /* albums are optional — a failure here must not block an upload */ }
    }
    void run()
    return () => { cancelled = true }
  }, [gallery, call])

  const profile = findProfile(profileId) ?? findProfile(DEFAULT_PROFILE_ID)!

  // Live preview — recomputed when the SELECTION changes, not when a photo changes state.
  //
  // RD-MEDIA-PERF-03: this used to be keyed on `queue.items` identity, which changes on
  // every one of the ~9,000 state updates a 3,000-photo import produces — so an O(n) pass
  // over every file ran 9,000 times. The byte total only changes when files are added or
  // removed, so that is what it is keyed on now.
  const sizeSignature = useMemo(
    () => queue.items.reduce((n, i) => n + i.file.size, 0),
    [queue.items],
  )
  const estimate = useMemo(
    () => estimateBatch(queue.items.map(i => i.file.size), profile, renditionPlan),
    // Keyed on the byte signature and the count on purpose: `queue.items` identity changes
    // on every stage update, and the estimate depends only on the set of file SIZES.
    //
    // RD-MS-CLOSURE-01 · `renditionPlan` IS a real dependency and is listed. It arrives after
    // the first render (the resolver is a fetch), and without it the size estimate would keep
    // quoting the fallback plan after the resolved one had landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sizeSignature, queue.items.length, profile, renditionPlan],
  )

  /** The photo furthest through the pipeline, for the stage checklist. */
  const currentPhoto = useMemo(() => {
    const active = queue.items.find(i => i.state === 'uploading' || i.state === 'processing')
    return active ? { name: active.file.name, stage: active.stage } : null
  }, [queue.items])

  const onPick = useCallback((list: FileList | null) => {
    if (!list) return
    // A folder selection includes everything; keep only images the platform accepts.
    const accepted = [...list].filter(f => ACCEPT.split(',').includes(f.type))
    const rejected = list.length - accepted.length
    if (accepted.length > 0) queue.add(accepted)
    setError(rejected > 0
      ? `${rejected} file${rejected === 1 ? ' was' : 's were'} skipped — only JPEG, PNG, WebP and AVIF images are accepted.`
      : null)
  }, [queue])

  /**
   * Creates a gallery and selects it, without leaving the page.
   *
   * THE fix for the round trip this sprint exists to remove: the organizer stays where they
   * are, the new gallery becomes the upload target immediately, and the files they already
   * chose are untouched because nothing unmounted.
   */
  const createGallery = useCallback(async (preset: string, name?: string) => {
    if (!event) return
    setCreating(true)
    try {
      const created = await call<GalleryCreateResponse>('/galleries', {
        method: 'POST',
        body: JSON.stringify({ eventId: event.eventId, preset, name }),
      })
      setGalleries(prev => [...prev, created.gallery])
      setGalleryId(created.gallery.galleryId)
      setAlbumId(null)
      showToast(`Gallery "${created.gallery.name}" created and selected.`, 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not create the gallery.', 'error')
    } finally {
      setCreating(false)
    }
  }, [event, call, setGalleryId, setAlbumId, showToast])

  const createCustomGallery = useCallback(async () => {
    const name = await prompt({
      title: 'Create a gallery',
      message: 'Name it however you like — for example a sponsor zone, a camera position, or a moment the suggestions do not cover.',
      placeholder: 'Gallery name',
      confirmLabel: 'Create gallery',
      required: true,
    })
    if (!name) return
    await createGallery(CUSTOM_GALLERY_KEY, name)
  }, [prompt, createGallery])

  // Follows the event automatically. Media Studio passes the type straight through and
  // never interprets it.
  const template = resolveGalleryTemplate(event?.eventType, event?.eventSubtype)
  const existingPresets = new Set(galleries.map(g => g.preset))

  // Blocked ONLY by the undecided and required states. A locked event imports normally.
  const canImport = branding?.workflow.canImport ?? false

  /**
   * RD-MEDIA-UI-01 — gated on the FILES only, deliberately not on the gallery.
   *
   * When this also required a gallery, choosing one inserted section 6 ABOVE the already
   * mounted section 7, which is precisely the kind of mid-document insertion that makes
   * Chrome's scroll anchoring move the viewport. Sections 6 and 7 now appear and disappear
   * together, so selecting a gallery inserts nothing.
   */
  const ready = queue.items.length > 0

  // ─── Presentation-only derivations (RD-MEDIA-UX-01) ────────────────────────
  // Nothing here decides anything: each value reads state the page already held.

  const album = useMemo(
    () => albums.find(a => a.albumId === albumId) ?? null,
    [albums, albumId],
  )

  /** Which face the summary rail shows. */
  const railState: RailState = queue.running
    ? 'uploading'
    : (queue.counts.completed > 0 && queue.counts.queued === 0) ? 'complete' : 'ready'

  const storedBytes = useMemo(
    () => queue.items.reduce((n, i) => n + i.storedBytes, 0),
    [queue.items],
  )

  const brandingState = branding?.workflow.state ?? null
  const brandingLabel =
    brandingLoading ? 'Checking…'
      : brandingState === 'enabled'  ? 'On'
      : brandingState === 'disabled' ? 'Off'
      : brandingState === 'locked'   ? (branding?.workflow.brandingApplies ? 'On · locked' : 'Off · locked')
      : brandingState === 'required' ? 'Artwork needed'
      : 'Not set'
  const brandingTone: 'success' | 'neutral' | 'warning' =
    brandingState === 'enabled' || (brandingState === 'locked' && branding?.workflow.brandingApplies)
      ? 'success'
      : brandingState === 'required' || brandingState === 'undecided' ? 'warning' : 'neutral'

  const startUpload = useCallback(() => {
    // MS-FINAL-01 · `event` joins the guard. It was always required — every upload writes
    // into an event's gallery — and the duplicate scan now needs it by name.
    if (!gallery || !canImport || !event) return
    queue.start({
      // The scan is scoped to one event: the same photo in two different events is two
      // legitimate uploads, not a duplicate.
      eventId:   event.eventId,
      galleryId: gallery.galleryId,
      albumId:   albumId,
      profile, plan: renditionPlan,
      branding: brandingSource,
    })
  }, [gallery, canImport, event, queue, albumId, profile, renditionPlan, brandingSource])

  const destinationRef = useRef<HTMLDivElement>(null)

  // Loads the credit position. A failure is surfaced in the card rather than blocking the
  // page: credits may be switched off entirely, and an unreadable balance must not stop an
  // organizer from preparing an import.
  // MC-08.2 · Extracted from the mount effect so a completed purchase can re-read the
  // balance in place. Still not polled — see the note above; this fires only when the
  // organizer has actually done something that changes the number.
  const loadCredits = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch('/api/organizer/media-credits/balance', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not read your credit balance.')
      const body = await res.json() as {
        balance: number; held: number; available: number
        creditsEnabled: boolean; creditsPerPhoto: number; unitPricePaise: number
      }
      setCredits({
        enabled:   body.creditsEnabled,
        balance:   body.balance,
        held:      body.held,
        available: body.available,
        creditsPerPhoto: body.creditsPerPhoto,
      })
      setUnitPricePaise(body.unitPricePaise)
      setCreditsError(null)
    } catch (e) {
      setCreditsError(e instanceof Error ? e.message : 'Could not read your credit balance.')
    } finally {
      setCreditsLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    // Wrapped rather than called directly so the mount read stays asynchronous — the first
    // state write happens after the token and the fetch resolve, never during the effect.
    //
    // The previous version carried a `cancelled` flag to suppress a write after unmount.
    // It is gone with the extraction, deliberately: the writes now live inside `loadCredits`,
    // which is also called from the purchase callback where a mount-scoped token means
    // nothing. A late write to an unmounted component is a no-op in React 19, and a flag
    // that reads like a guard while guarding nothing is worse than its absence.
    void (async () => { await loadCredits() })()
  }, [loadCredits])

  // MC-10.6 · Re-read the balance the moment a cancellation has finished releasing its
  // sessions. Watching the flag fall — rather than firing inside `cancelAll` — means the
  // read happens AFTER settlement has committed, so the number shown is the recovered one
  // and not the pre-release balance.
  const wasReleasing = useRef(false)
  useEffect(() => {
    if (wasReleasing.current && !queue.releasing) {
      void (async () => { await loadCredits() })()
    }
    wasReleasing.current = queue.releasing
  }, [queue.releasing, loadCredits])

  // ONE definition of affordability, shared by the card and the Start gate below. Two
  // separate rules is how a green card ends up beside a disabled button.
  const creditVerdictNow = credits?.enabled
    ? creditVerdict({
        available: credits.available,
        cost: estimateCost(estimate.photoCount, credits.creditsPerPhoto),
        photoCount: estimate.photoCount,
      })
    : 'ok'
  const canAffordImport = creditVerdictNow !== 'insufficient'

  // MC-10.5 · The queue hit a 402. Distinct from `creditVerdictNow`, which is the PRE-flight
  // estimate: this one is the server's own verdict, with the numbers it refused on, and it is
  // the only one that can appear mid-batch after the balance moved under us.
  const creditStop = queue.failures.find(f => f.kind === 'insufficient_credits')?.credits ?? null
  // MC-10.5 · Whether the stop has been cleared. DERIVED from the balance the purchase
  // refreshed, not from a "did they buy something" flag: a flag would stay true after a
  // partial top-up that still leaves the batch unaffordable, and would offer Resume for an
  // upload certain to stop again at the same photo.
  const creditStopCleared =
    creditStop !== null && (credits?.available ?? 0) >= creditStop.required

  // Re-queues the stopped photos and drives them. Completed photos are untouched — retry
  // only moves `failed` items, and each keeps the slot it was given (MC-10.2), so nothing
  // re-uploads and no second credit slot is consumed.
  const resumeAfterPurchase = useCallback(() => {
    queue.retryFailed()
    startUpload()
  }, [queue, startUpload])

  /** The page's own view of the session. There is no endpoint that reads one. */
  const sessionStatus: ImportSessionStatus =
    railState === 'uploading' ? 'active'
    : railState === 'complete' ? 'finished'
    : 'not_started'

  return (
    <div className="space-y-4">
      {/* ── Workspace bar — one row, always mounted ── */}
      <ImportWorkspaceBar
        eventName={event?.name ?? null}
        galleryName={gallery?.name ?? null}
        albumName={album?.name ?? null}
        onChange={() => destinationRef.current?.focus()}
      />

      {/* ── Two-pane workspace. Tablet and mobile collapse to one column, rail last. ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">

        {/* ═══ LEFT · workflow ═══ */}
        <div className="min-w-0 space-y-4">

          {/* ── Destination ── */}
          <Panel
            label="Destination"
            dense
            action={event ? (
              <TextLink href={withEvent(ROUTES.MEDIA_STUDIO_GALLERIES, event.eventId, 'import')}>
                Manage galleries
              </TextLink>
            ) : undefined}
          >
            <div ref={destinationRef} tabIndex={-1} className="space-y-1.5 focus:outline-none">
              <EventContextBar dense />

              {!event ? (
                <p className="text-fs-sm text-muted-foreground">
                  Choose an event above to pick a gallery.
                </p>
              ) : galleries.length === 0 ? (
                <EmptyState
                  icon={Images} size="sm"
                  title={`No galleries yet for ${event.name}`}
                  description="Create one below — you stay right here."
                />
              ) : (
                // ONE row, scrolled horizontally. `flex-wrap` made Destination's height a
                // function of gallery count — thirty galleries was three rows and growing.
                <ScrollRow activeId={galleryId} aria-label="Galleries">
                  {galleries.map(g => (
                    <Button
                      key={g.galleryId}
                      data-chip-id={g.galleryId}
                      variant={galleryId === g.galleryId ? 'secondary' : 'outline'}
                      size="xs"
                      className="shrink-0"
                      onClick={() => { setGalleryId(g.galleryId); setAlbumId(null) }}
                      aria-pressed={galleryId === g.galleryId}
                    >
                      {g.name}
                    </Button>
                  ))}
                  {/* Template galleries stay VISIBLE in the same row — creating one is a
                      single click, not a click to reveal followed by a click to create.
                      Already-created presets drop out, so the row shrinks as it is used. */}
                  {template.suggestions
                    .filter(sg => !existingPresets.has(sg.key))
                    .map(sg => (
                      <Button
                        key={sg.key}
                        variant="outline" size="xs"
                        className="shrink-0 border-dashed text-muted-foreground"
                        disabled={creating}
                        onClick={() => void createGallery(sg.key, sg.name)}
                      >
                        <FolderPlus className="size-3.5" aria-hidden />
                        {sg.name}
                      </Button>
                    ))}

                  {/* Always last. */}
                  <Button
                    variant="ghost" size="xs" className="shrink-0"
                    disabled={creating}
                    onClick={() => void createCustomGallery()}
                  >
                    <Plus className="size-3.5" aria-hidden />
                    New Gallery
                  </Button>
                </ScrollRow>
              )}

              {/* Album — the row is reserved whenever a gallery is chosen, so albums
                  arriving from their async fetch never insert a new block. */}
              {gallery && (
                <ScrollRow
                  activeId={albumId ?? 'none'}
                  className="items-center"
                  aria-label="Albums"
                >
                  <span className="mr-1 shrink-0 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Album
                  </span>
                  <Button
                    data-chip-id="none"
                    variant={albumId === null ? 'secondary' : 'outline'} size="xs"
                    className="shrink-0"
                    onClick={() => setAlbumId(null)} aria-pressed={albumId === null}
                  >
                    None
                  </Button>
                  {albums.map(a => (
                    <Button
                      key={a.albumId}
                      data-chip-id={a.albumId}
                      variant={albumId === a.albumId ? 'secondary' : 'outline'} size="xs"
                      className="shrink-0"
                      onClick={() => setAlbumId(a.albumId)} aria-pressed={albumId === a.albumId}
                    >
                      {a.name}
                    </Button>
                  ))}
                </ScrollRow>
              )}

            </div>
          </Panel>

          {/* ── Branding ── */}
          <Panel
            label="Branding"
            title="Applied during import"
            action={event ? (
              <TextLink href={withEvent(ROUTES.MEDIA_STUDIO_BRANDING, event.eventId, 'import')}>
                Manage
              </TextLink>
            ) : undefined}
          >
            {event ? (
              // RD-MEDIA-IMPORT-UX — `compact` drops the Card that was nested inside this
              // Panel and lays the artwork beside its status rather than above it.
              <BrandingGate
                eventId={event.eventId}
                branding={branding}
                loading={brandingLoading}
                onDecide={decideBranding}
              />
            ) : (
              <p className="text-fs-sm text-muted-foreground">
                Choose an event to see its branding.
              </p>
            )}
          </Panel>

          {/* ── Photos ── */}
          <Panel
            label="Photos"
            title="Add files or a folder"
            action={queue.items.length > 0 ? (
              <StatusChip tone="info">
                {queue.items.length.toLocaleString('en-IN')} selected
              </StatusChip>
            ) : undefined}
          >
            {/* The primary action. Kept in position, given the visual weight the two panels
                above it just gave up. */}
            <div className="rounded-xl border-2 border-dashed border-border px-4 py-6 text-center transition-colors hover:border-border-strong">
              <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted" aria-hidden>
                <Upload className="size-5 text-muted-foreground" />
              </div>
              <p className="mt-2.5 text-fs-md font-semibold text-foreground">
                Add photos or a whole folder
              </p>
              <p className="mx-auto mt-0.5 max-w-sm text-fs-sm text-muted-foreground">
                JPEG, PNG, WebP or AVIF. Thousands at a time are fine.
              </p>

              <input
                ref={fileRef} type="file" multiple accept={ACCEPT} className="sr-only"
                onChange={e => { onPick(e.target.files); e.target.value = '' }}
              />
              {/* webkitdirectory is the only way to select a directory tree. It is not in
                  React's typings, so it is applied via a ref callback rather than a cast. */}
              <input
                ref={el => {
                  folderRef.current = el
                  if (el) {
                    el.setAttribute('webkitdirectory', '')
                    el.setAttribute('directory', '')
                  }
                }}
                type="file" multiple className="sr-only"
                onChange={e => { onPick(e.target.files); e.target.value = '' }}
              />

              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <Images className="size-4" aria-hidden /> Choose files
                </Button>
                <Button variant="outline" size="sm" onClick={() => folderRef.current?.click()}>
                  <FolderOpen className="size-4" aria-hidden /> Choose folder
                </Button>
              </div>
            </div>

            {/* Counts live in the panel that owns the files. */}
            {queue.items.length > 0 && (
              <dl className="flex flex-wrap gap-x-5 gap-y-1">
                <Stat label="Selected" value={estimate.photoCount.toLocaleString('en-IN')} />
                <Stat label="Original" value={formatBytes(estimate.currentBytes)} />
                <Stat label="After compression" value={formatBytes(estimate.estimatedBytes)} />
              </dl>
            )}

            {error && (
              <Banner tone="warning" title="Some files were skipped">
                {error}
              </Banner>
            )}
          </Panel>

          {/* ── Compression ── */}
          <Panel label="Compression" dense>
            <CompressionSelector
              profiles={COMPRESSION_PROFILES}
              selected={profile}
              onSelect={setProfileId}
            />
          </Panel>

          {/* ── Queue — the ONE panel gated on content, and it is the last node on the
               page, so mounting it inserts nothing above anything. ── */}
          {ready && (
            <Panel
              label="Queue"
              title={`${queue.items.length.toLocaleString('en-IN')} photos`}
              action={
                <div className="flex flex-wrap gap-1.5">
                  {queue.paused && (
                    <Button size="xs" variant="outline" onClick={queue.resume}>Resume</Button>
                  )}
                  {/* MC-10.5 · Hidden while the stop is a credit shortfall: retrying is
                      guaranteed to fail until credits are bought, and offering it is how an
                      organizer ends up clicking Retry six times and then contacting support.
                      It returns the moment the shortfall is cleared. */}
                  {queue.counts.failed > 0 && !creditStop && (
                    <Button size="xs" variant="outline" onClick={queue.retryFailed}>
                      <RefreshCw className="size-3.5" aria-hidden /> Retry {queue.counts.failed}
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={queue.clear}>
                    <X className="size-3.5" aria-hidden /> Clear
                  </Button>
                </div>
              }
            >
              {/* MC-10.6 · The organizer cancelled and the held credits are coming back.
                  Named explicitly, because "cancelled" alone leaves them wondering whether
                  the credits they paid for went with it. */}
              {queue.releasing && (
                <Banner tone="info" title="Finalising session…" className="mt-2">
                  Returning the credits this upload was holding. Photos already uploaded are
                  kept and charged; the rest is released.
                </Banner>
              )}

              <div className="flex flex-wrap gap-1.5">
                <StatusChip tone="neutral">{queue.counts.queued} queued</StatusChip>
                <StatusChip tone="info">{queue.counts.uploading + queue.counts.processing} in progress</StatusChip>
                <StatusChip tone="success">{queue.counts.completed} completed</StatusChip>
                {queue.counts.duplicate > 0 && (
                  <StatusChip tone="warning">{queue.counts.duplicate} already uploaded</StatusChip>
                )}
                {queue.counts.failed > 0 && <StatusChip tone="danger">{queue.counts.failed} failed</StatusChip>}
              </div>

              {/* MS-FINAL-01 · the pre-flight scan is running. Named, because hashing a
                  large folder takes a visible moment and silence reads as a hang. */}
              {queue.scanning && (
                <Banner tone="info" title="Checking for duplicates…" className="mt-2">
                  Comparing these photos against what is already in this event. Nothing has
                  been uploaded yet.
                </Banner>
              )}

              {/* MS-FINAL-01 · duplicates found. The decision is the organizer's, and until
                  they make it these photos hold no credit slot and upload nothing. */}
              {queue.counts.duplicate > 0 && (
                <Banner
                  tone="warning"
                  title={`${queue.counts.duplicate} photo${queue.counts.duplicate === 1 ? '' : 's'} already uploaded`}
                  className="mt-2"
                >
                  <p>
                    These match photos already in this event. Skipping them costs nothing —
                    they hold no credits and will not be uploaded.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <Button size="xs" onClick={() => queue.resolveDuplicates('skip')}>
                      <X className="size-3.5" aria-hidden />
                      Skip all duplicates
                    </Button>
                    <Button size="xs" variant="outline"
                            onClick={() => queue.resolveDuplicates('upload')}>
                      <Upload className="size-3.5" aria-hidden />
                      Upload them anyway
                    </Button>
                  </div>
                </Banner>
              )}

              {/* ── MC-10.5 · running out of credits gets its own answer ──────────────
                   The generic failure banner says "retry"; retrying is the one thing that
                   cannot work here. This states the numbers the server refused on and offers
                   the single action that changes them. */}
              {creditStop && (
                <Banner
                  tone="error"
                  title="Not enough Media Credits"
                  className="mt-2"
                >
                  <p>
                    {creditStopCleared
                      ? 'Your credits have been topped up. Resume to upload the remaining photos — the ones already uploaded are kept.'
                      : 'Uploads stopped because your available credits are lower than this upload requires. Photos already uploaded are kept.'}
                  </p>
                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-fs-2xs">
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Available</dt>
                      <dd className="font-semibold tabular-nums">{creditStop.available.toLocaleString('en-IN')}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Required</dt>
                      <dd className="font-semibold tabular-nums">{creditStop.required.toLocaleString('en-IN')}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Short by</dt>
                      <dd className="font-semibold tabular-nums text-destructive">{creditStop.shortfall.toLocaleString('en-IN')}</dd>
                    </div>
                  </dl>
                  {creditStopCleared ? (
                    <Button size="xs" className="mt-2.5" onClick={resumeAfterPurchase}>
                      <Upload className="size-3.5" aria-hidden />
                      Resume upload
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      className="mt-2.5"
                      onClick={() => setBuyingShortfall(creditStop.shortfall)}
                    >
                      <Wallet className="size-3.5" aria-hidden />
                      Buy credits
                    </Button>
                  )}
                </Banner>
              )}

              {/* RD-MEDIA-03: causes, not a count. Each says what to do about it. */}
              {queue.failures.filter(f => f.kind !== 'insufficient_credits').map(f => (
                <Banner
                  key={f.kind}
                  tone={f.retryable ? 'warning' : 'error'}
                  title={`Upload failed — ${f.count} photo${f.count === 1 ? '' : 's'}`}
                  className="mt-2"
                >
                  {f.reason} {f.action}
                </Banner>
              ))}

              <ul className="max-h-[300px] space-y-1 overflow-y-auto">
                {queue.items.slice(0, 200).map(item => (
                  <UploadRow
                    key={item.id}
                    name={item.file.name}
                    state={item.state}
                    stage={item.stage}
                    storedBytes={item.storedBytes}
                    reason={
                      item.duplicateOf
                        ? duplicateReason(item.duplicateOf)
                        : item.failure?.reason ?? null
                    }
                    formatBytes={formatBytes}
                  />
                ))}
              </ul>
              {queue.items.length > 200 && (
                <p className="mt-1.5 text-fs-2xs text-muted-foreground">
                  Showing the first 200 of {queue.items.length.toLocaleString('en-IN')} — all are queued.
                </p>
              )}
            </Panel>
          )}
        </div>

        {/* ═══ RIGHT · summary rail ═══ */}
        <div className={MEDIA_RAIL_COLUMN}>
          {/* Above the rail deliberately: 'can I afford this' is the question that gates
              the primary action, so it is answered before the action is offered. */}
          <ImportCreditsCard
            enabled={credits?.enabled ?? false}
            loading={creditsLoading}
            error={creditsError}
            balance={credits?.balance ?? 0}
            held={credits?.held ?? 0}
            available={credits?.available ?? 0}
            creditsPerPhoto={credits?.creditsPerPhoto ?? 1}
            photoCount={estimate.photoCount}
            sessionStatus={sessionStatus}
            onBuy={setBuyingShortfall}
          />
          <ImportSummaryRail
            state={railState}
            eventName={event?.name ?? null}
            galleryName={gallery?.name ?? null}
            albumName={album?.name ?? null}
            brandingLabel={brandingLabel}
            brandingTone={brandingTone}
            profileName={profile.name}
            hasEvent={Boolean(event)}
            hasGallery={Boolean(gallery)}
            brandingResolved={canImport}
            canStart={Boolean(gallery) && canImport && queue.items.length > 0 && canAffordImport}
            photoCount={estimate.photoCount}
            estimatedBytes={estimate.estimatedBytes}
            savingsPercent={estimate.savingsPercent}
            estimatedSeconds={estimate.estimatedSeconds}
            storedBytes={storedBytes}
            progress={queue.progress}
            counts={queue.counts}
            currentPhoto={currentPhoto}
            onStart={startUpload}
            onPause={queue.pause}
            onCancel={queue.cancelAll}
            onUploadMore={queue.clear}
            galleryHref={event ? withEvent(ROUTES.MEDIA_STUDIO_GALLERIES, event.eventId) : null}
            formatBytes={formatBytes}
            formatDuration={formatDuration}
          />
        </div>
      </div>

      {/* ── Mobile sticky action bar. The primary action must never require scrolling. ── */}
      {railState === 'ready' && queue.items.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-card/95 px-4 py-2.5 backdrop-blur pb-[max(0.625rem,env(safe-area-inset-bottom))] md:-mx-5 md:px-5 lg:hidden">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-fs-sm font-semibold text-foreground">
                {estimate.photoCount.toLocaleString('en-IN')} photos · {formatBytes(estimate.estimatedBytes)}
              </p>
            </div>
            <Button
              variant="primary" size="sm"
              disabled={!gallery || !canImport}
              onClick={startUpload}
            >
              Start Upload
            </Button>
          </div>
        </div>
      )}

      {/* MC-08.2 · The SAME purchase dialog the Credits dashboard uses. Mounted only while
          open, so each opening starts from a clean phase. On success the balance is re-read
          from the server rather than adjusted locally — the wallet stays the one source of
          truth for the number that gates the upload. */}
      {buyingShortfall !== false && (
        <BuyCreditsDialog
          open
          onClose={() => setBuyingShortfall(false)}
          unitPricePaise={unitPricePaise}
          creditsPerPhoto={credits?.creditsPerPhoto ?? 1}
          suggestedCredits={buyingShortfall}
          onPurchased={() => { void loadCredits() }}
        />
      )}
    </div>
  )
}

/** A label/value pair inside the Photos panel. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-fs-base font-bold tabular-nums text-foreground">{value}</dd>
    </div>
  )
}
