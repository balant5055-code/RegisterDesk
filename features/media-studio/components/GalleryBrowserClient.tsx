'use client'

// RD-MEDIA-06 · The organizer's photo browser.
//
// ═══ WHAT WAS MISSING ═════════════════════════════════════════════════════════
// `GET /api/organizer/media-studio/assets` has existed since RD-MEDIA-01 and had ZERO
// callers. So an organizer could upload photos, watch the counter go up, and never see one:
// the Galleries page listed metadata, and nothing anywhere rendered a thumbnail.
//
// This is the missing consumer. It adds no repository, no query and no endpoint — it calls
// the asset list, the visibility PATCH and the delete that RD-MEDIA-01 and RD-MEDIA-04
// already built.
// ══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react'
import {
  Download, Eye, EyeOff, Images, Loader2, Lock, Search, Trash2,
} from 'lucide-react'
import {
  Banner, Button, Card, EmptyState, StatusChip, useConfirm, useToast,
} from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { Panel } from './MediaStudioShell'
// RD-MEDIA-11 — the SAME download helper the public gallery uses. One implementation.
// RD-PHOTO-03 — an ORDINARY download. The stored photo already carries the branding.
import { downloadFile, photoFilename } from '@/features/media-studio/utils/downloadFile'
import { GALLERY_BADGE } from '@/features/photo-branding/utils/brandingCopy'
import type { BrandingResponse } from '@/app/api/organizer/media-studio/branding/route'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import { BulkActionsPanel } from './BulkActionsPanel'
import { PhotoDetailDrawer } from './PhotoDetailDrawer'
import type { AlbumView, GalleryView, MediaAssetView } from '@/features/media-studio/types'
import type { AssetListResponse } from '@/app/api/organizer/media-studio/assets/route'
import type { AlbumListResponse, } from '@/app/api/organizer/media-studio/albums/route'
import type { GalleryListResponse } from '@/app/api/organizer/media-studio/galleries/route'
import type { AssetPatchResponse } from '@/app/api/organizer/media-studio/assets/[assetId]/route'

const API = '/api/organizer/media-studio'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

/** What each visibility means to an organizer, in one word plus a tone. */
const VISIBILITY_LABEL = {
  PUBLIC:     { label: 'Public',  tone: 'success' as const, icon: Eye },
  SIGNED_URL: { label: 'Gated',   tone: 'info'    as const, icon: Lock },
  PRIVATE:    { label: 'Private', tone: 'neutral' as const, icon: EyeOff },
}

export interface GalleryBrowserClientProps {
  galleryId: string
}

export function GalleryBrowserClient({ galleryId }: GalleryBrowserClientProps) {
  const { getToken } = useAuth()
  const { showToast } = useToast()
  const { confirm }   = useConfirm()
  // The workspace's event (RD-MEDIA-03). The gallery is resolved from the EXISTING list
  // endpoint rather than a new by-id route — one fewer API for the same answer.
  const { event } = useMediaStudio()

  const [gallery, setGallery] = useState<GalleryView | null>(null)
  const [assets,  setAssets]  = useState<MediaAssetView[]>([])
  const [albums,  setAlbums]  = useState<AlbumView[]>([])
  const [albumId, setAlbumId] = useState<string | null>(null)
  const [cursor,  setCursor]  = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)

  // ── RD-MS-CLOSURE-01 · view refinements ──────────────────────────────────
  // `visibility` and `sort` are applied SERVER-SIDE in the query; `search` narrows the
  // loaded page only, and the UI says so. See the assets route header for why.
  const [visibilityFilter, setVisibilityFilter] = useState<'' | 'PUBLIC' | 'SIGNED_URL' | 'PRIVATE'>('')
  const [sort,   setSort]   = useState<'newest' | 'oldest'>('newest')
  const [search, setSearch] = useState('')
  /** The photo whose detail drawer is open, or null. */
  const [detail, setDetail] = useState<MediaAssetView | null>(null)

  /**
   * The query for one page. ONE builder, used by the first-page effect and by `loadMore`,
   * because a cursor page that dropped a filter would return photos the grid is not showing.
   */
  const buildQuery = useCallback((next?: string | null) => {
    const q = new URLSearchParams({ galleryId })
    if (albumId) q.set('albumId', albumId)
    if (visibilityFilter) q.set('visibility', visibilityFilter)
    if (sort === 'oldest') q.set('sort', sort)
    if (search.trim()) q.set('q', search.trim())
    if (next) q.set('cursor', next)
    return q.toString()
  }, [galleryId, albumId, visibilityFilter, sort, search])

  // MS-FINAL-02 · Bumped when a bulk job finishes, so the photos AND the scope counters
  // re-read. A bulk delete changes both the grid and the gallery/album totals the panel
  // shows, and refreshing only one of them would leave the page contradicting itself.
  const [reloadKey, setReloadKey] = useState(0)
  const reloadAfterBulk = useCallback(() => { setReloadKey(k => k + 1) }, [])
  // RD-PHOTO-04: whether these stored photos carry branding. One badge, no explanation.
  const [branding, setBranding] = useState<BrandingResponse | null>(null)

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

  // ── The gallery itself ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) setGallery(null); return }
      try {
        const data = await call<GalleryListResponse>(`/galleries?eventId=${encodeURIComponent(event.eventId)}`)
        if (cancelled) return
        setGallery(data.galleries.find(g => g.galleryId === galleryId) ?? null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load this gallery.')
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, galleryId, call, reloadKey])

  // ── The event's branding status, once ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) setBranding(null); return }
      try {
        const data = await call<BrandingResponse>(`/branding?eventId=${encodeURIComponent(event.eventId)}`)
        if (!cancelled) setBranding(data)
      } catch {
        // A badge is informational. Without it the browser behaves exactly as before.
        if (!cancelled) setBranding(null)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  // ── Albums, once ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const data = await call<AlbumListResponse>(`/albums?galleryId=${encodeURIComponent(galleryId)}`)
        if (!cancelled) setAlbums(data.albums)
      } catch { /* albums are a filter, not a requirement — a failure must not hide photos */ }
    }
    void run()
    return () => { cancelled = true }
  }, [galleryId, call, reloadKey])

  // ── Photos: first page, and again whenever the album filter changes ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const data = await call<AssetListResponse>(`/assets?${buildQuery()}`)
        if (!cancelled) { setAssets(data.assets); setCursor(data.nextCursor) }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load photos.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
    // RD-MS-CLOSURE-01 · `buildQuery` closes over every refinement, so changing a filter,
    // the sort or the search term re-runs this and resets to page one — which is the only
    // correct behaviour: a cursor from the old view means nothing in the new one.
  }, [buildQuery, call, reloadKey])

  const loadMore = useCallback(async () => {
    if (!cursor || busy) return
    setBusy(true)
    try {
      const data = await call<AssetListResponse>(`/assets?${buildQuery(cursor)}`)
      setAssets(prev => {
        const seen = new Set(prev.map(a => a.assetId))
        return [...prev, ...data.assets.filter(a => !seen.has(a.assetId))]
      })
      setCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more photos.')
    } finally {
      setBusy(false)
    }
  }, [cursor, busy, buildQuery, call])

  /** Reuses the RD-MEDIA-04 visibility PATCH. No new endpoint, no new logic. */
  const setVisibility = useCallback(async (
    asset: MediaAssetView, visibility: 'PUBLIC' | 'SIGNED_URL',
  ) => {
    try {
      const data = await call<AssetPatchResponse>(`/assets/${asset.assetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility }),
      })
      setAssets(prev => prev.map(a => (a.assetId === asset.assetId ? data.asset : a)))
      showToast(
        visibility === 'PUBLIC'
          ? 'Photo published to the public gallery.'
          : 'Photo withdrawn from the public gallery.',
        'success',
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not change visibility.', 'error')
    }
  }, [call, showToast])

  /**
   * Saves the photo instead of navigating to it.
   *
   * This control used to be `<a href={thumbnailUrl} target="_blank">` — it opened the image
   * in a new tab, which is the behaviour this refinement removes.
   */
  const download = useCallback(async (asset: MediaAssetView) => {
    if (!asset.thumbnailUrl || downloading) return
    setDownloading(asset.assetId)
    try {
      const outcome = await downloadFile(
        asset.thumbnailUrl,
        asset.originalFilename ?? photoFilename(gallery?.name ?? 'photo', asset.assetId, asset.mimeType),
      )
      if (outcome === 'failed') {
        showToast('That photo could not be downloaded.', 'error')
      } else if (outcome === 'opened') {
        showToast('Your browser opened the photo instead of saving it.', 'error')
      }
    } finally {
      setDownloading(null)
    }
  }, [downloading, gallery, showToast])

  const removePhoto = useCallback(async (asset: MediaAssetView) => {
    const ok = await confirm({
      title: 'Delete this photo?',
      message: 'The image is removed from storage and cannot be recovered.',
      confirmLabel: 'Delete photo',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await call(`/assets/${asset.assetId}`, { method: 'DELETE' })
      setAssets(prev => prev.filter(a => a.assetId !== asset.assetId))
      showToast('Photo deleted.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not delete the photo.', 'error')
    }
  }, [call, confirm, showToast])

  return (
    <div className="space-y-6">
      {error && <Banner tone="error" title="Something went wrong">{error}</Banner>}

      {albums.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={albumId === null ? 'primary' : 'outline'} size="sm"
            onClick={() => setAlbumId(null)} aria-pressed={albumId === null}
          >
            All photos
          </Button>
          {albums.map(album => (
            <Button
              key={album.albumId}
              variant={albumId === album.albumId ? 'primary' : 'outline'} size="sm"
              onClick={() => setAlbumId(album.albumId)} aria-pressed={albumId === album.albumId}
            >
              {album.name}
              <span className="ml-1 text-muted-foreground">{album.assetCount}</span>
            </Button>
          ))}
        </div>
      )}

      {/* MS-FINAL-02 · Bulk actions for the CURRENT SCOPE — the whole gallery, or the album
          selected above. The jobs engine works on a scope rather than a selection, so the
          panel follows the filter the organizer has already set rather than introducing a
          second, different way to choose photos. */}
      {gallery && (
        <BulkActionsPanel
          galleryId={galleryId}
          albumId={albumId}
          scopeName={albumId ? (albums.find(a => a.albumId === albumId)?.name ?? gallery.name) : gallery.name}
          scopeCount={albumId
            ? (albums.find(a => a.albumId === albumId)?.assetCount ?? 0)
            : gallery.assetCount}
          albums={albums.filter(a => a.albumId !== albumId)}
          onJobSettled={reloadAfterBulk}
        />
      )}

      <Panel label="Photos"
        action={branding ? (
          <StatusChip tone={branding.workflow.brandingApplies ? 'success' : 'neutral'}>
            {branding.workflow.brandingApplies ? GALLERY_BADGE.branded : GALLERY_BADGE.unbranded}
          </StatusChip>
        ) : undefined}
        title={
          gallery
            ? (albumId ? `Showing one album of "${gallery.name}".` : `Every photo in "${gallery.name}".`)
            : 'Loading this gallery…'
        }
      >
        {/* RD-MS-CLOSURE-01 · view refinements. Until this sprint the only way to reach
            photo #40,000 was 667 sequential pages in upload order.

            Visibility and sort are applied in the QUERY, so they narrow the whole gallery.
            Search narrows the LOADED PAGE only — Firestore cannot substring-match, and a
            search index is infrastructure this sprint may not add — so the hint below says
            exactly that rather than letting "3 results" read as a gallery-wide count. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[12rem] flex-1">
            <span className="sr-only">Search loaded photos by filename</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search filenames on this page…"
              className={cn(
                'w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3',
                'text-fs-sm text-foreground placeholder:text-muted-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            />
          </label>

          <label className="flex items-center gap-1.5">
            <span className="sr-only">Filter by visibility</span>
            <select
              value={visibilityFilter}
              onChange={e => setVisibilityFilter(e.target.value as typeof visibilityFilter)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-fs-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All visibility</option>
              <option value="PUBLIC">Public</option>
              <option value="SIGNED_URL">Gated</option>
              <option value="PRIVATE">Private</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="sr-only">Sort order</span>
            <select
              value={sort}
              onChange={e => setSort(e.target.value as 'newest' | 'oldest')}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-fs-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>

          {(visibilityFilter || search.trim() || sort !== 'newest') && (
            <Button
              variant="ghost" size="xs"
              onClick={() => { setVisibilityFilter(''); setSearch(''); setSort('newest') }}
            >
              Clear
            </Button>
          )}
        </div>

        {search.trim() && !loading && (
          <p className="mb-3 text-fs-2xs text-muted-foreground">
            Showing {assets.length} match{assets.length === 1 ? '' : 'es'} on the photos loaded
            so far. Load more to search further into the gallery.
          </p>
        )}

        {loading ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true">
            {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
              <li key={i} className="aspect-square animate-pulse rounded-xl bg-muted" />
            ))}
          </ul>
        ) : assets.length === 0 ? (
          <EmptyState
            icon={Images}
            title={
              search.trim() || visibilityFilter
                ? 'No photos match these filters'
                : albumId ? 'No photos in this album' : 'No photos in this gallery yet'
            }
            description={
              search.trim() || visibilityFilter
                ? 'Try clearing the filters, or load more photos and search again.'
                : 'Photos appear here as soon as an upload finishes.'
            }
            action={
              search.trim() || visibilityFilter
                ? undefined
                : { label: 'Import media', href: '/dashboard/media-studio/import' }
            }
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {assets.map(asset => {
              const vis = VISIBILITY_LABEL[asset.visibility] ?? VISIBILITY_LABEL.PRIVATE
              const VisIcon = vis.icon
              return (
                <li key={asset.assetId}>
                  <Card padded={false} className="h-full overflow-hidden">
                    {/* RD-MS-CLOSURE-01 · the tile itself opens the detail drawer. A real
                        <button> rather than a click handler on the div, so it is reachable by
                        keyboard and announced as an action. The inline controls below stay
                        outside it — a button inside a button is invalid and would swallow
                        their clicks. */}
                    <button
                      type="button"
                      onClick={() => setDetail(asset)}
                      aria-label={`View details for ${asset.originalFilename ?? 'this photo'}`}
                      className="relative block aspect-square w-full bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {asset.thumbnailUrl ? (
                        /* A plain <img>: the source is an object-storage URL already sized by
                           Media Studio, and next/image would re-optimise an optimised file. */
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={asset.thumbnailUrl}
                          alt={asset.originalFilename ?? 'Uploaded photo'}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover"
                        />
                      ) : (
                        // A PRIVATE photo has no URL by design, and an unconfigured public
                        // base URL yields none either. Say so rather than showing a broken
                        // image icon.
                        <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center" aria-hidden>
                          <VisIcon className="size-5 text-muted-foreground/50" />
                          <span className="text-fs-2xs text-muted-foreground">
                            No preview
                          </span>
                        </div>
                      )}
                      <span className="absolute left-1.5 top-1.5">
                        <StatusChip tone={vis.tone}>{vis.label}</StatusChip>
                      </span>
                    </button>

                    <div className="space-y-2 p-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-fs-sm font-medium text-foreground">
                          {asset.originalFilename ?? 'Untitled'}
                        </p>
                        <p className="text-fs-2xs text-muted-foreground">
                          {formatBytes(asset.bytesStored)}
                          {asset.width && asset.height && ` · ${asset.width}×${asset.height}`}
                        </p>
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Reuses the RD-MEDIA-04 publish control, which nothing surfaced. */}
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => void setVisibility(
                            asset, asset.visibility === 'PUBLIC' ? 'SIGNED_URL' : 'PUBLIC',
                          )}
                          title={asset.visibility === 'PUBLIC'
                            ? 'Withdraw from the public gallery'
                            : 'Publish to the public gallery'}
                        >
                          {asset.visibility === 'PUBLIC'
                            ? <EyeOff className="size-3.5" aria-hidden />
                            : <Eye className="size-3.5" aria-hidden />}
                          {asset.visibility === 'PUBLIC' ? 'Withdraw' : 'Publish'}
                        </Button>

                        {asset.thumbnailUrl && (
                          <button
                            type="button"
                            onClick={() => void download(asset)}
                            disabled={downloading === asset.assetId}
                            aria-label={`Download ${asset.originalFilename ?? 'photo'}`}
                            className={cn(
                              'ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors',
                              'hover:bg-muted hover:text-foreground disabled:opacity-60',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                            )}
                          >
                            {downloading === asset.assetId
                              ? <Loader2 className="size-4 animate-spin" aria-hidden />
                              : <Download className="size-4" aria-hidden />}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void removePhoto(asset)}
                          aria-label={`Delete ${asset.originalFilename ?? 'photo'}`}
                          className={cn(
                            'rounded-lg p-1.5 text-muted-foreground transition-colors',
                            !asset.thumbnailUrl && 'ml-auto',
                            'hover:bg-destructive/10 hover:text-destructive',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          )}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                    </div>
                  </Card>
                </li>
              )
            })}
          </ul>
        )}

        {cursor && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadMore()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {busy ? 'Loading…' : 'Load more photos'}
            </Button>
          </div>
        )}
      </Panel>

      {/* RD-MS-CLOSURE-01 · mounted only while open, so it always shows the photo that was
          clicked. The asset is re-read from `assets` by id rather than held in state, so a
          visibility change made while the drawer is open is reflected in it immediately
          instead of showing a stale copy. */}
      {detail && (() => {
        const live = assets.find(a => a.assetId === detail.assetId)
        if (!live) return null          // deleted underneath the drawer
        return (
          <PhotoDetailDrawer
            asset={live}
            downloading={downloading === live.assetId}
            onDownload={a => void download(a)}
            onClose={() => setDetail(null)}
          />
        )
      })()}
    </div>
  )
}
