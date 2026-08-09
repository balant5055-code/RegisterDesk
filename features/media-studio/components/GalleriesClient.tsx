'use client'

// RD-MEDIA-01 · Galleries + Albums management.
//
// One client for both, because an album only exists inside a gallery — splitting them would
// mean two event pickers and two selection states for one mental model.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { FolderPlus, Images, Layers, Plus, Trash2 } from 'lucide-react'
import { Banner, Button, Card, useConfirm, useToast } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { Panel } from './MediaStudioShell'
// RD-MEDIA-UX-04 — the canonical Media Studio UI layer. Galleries is the first page
// converted; Albums renders through this same component, so it converts with it.
import {
  MEDIA_PAGE_STACK, MEDIA_RAIL_COLUMN, MEDIA_WORKSPACE_GRID, MediaEmptyState, MediaFilterBar,
  MediaLoadingState, MediaMetricCard, MediaMetricRow, MediaSummaryRail, MediaWorkspaceBar,
  RailMetric,
} from './workspace'
import { EventContextBar } from './EventContextBar'
import {
  FROM_PARAM, useMediaStudio, withEvent,
} from '@/features/media-studio/context/MediaStudioContext'
import { ROUTES } from '@/config/navigation'
import { ALBUM_SUGGESTIONS, type AlbumView, type GalleryView } from '@/features/media-studio/types'
// RD-MEDIA-02: gallery suggestions are resolved from the EVENT's template. Media Studio is a
// PLATFORM module and holds no event-specific names of its own.
import { CUSTOM_GALLERY_KEY, resolveGalleryTemplate } from '@/lib/events/galleryTemplates'
import type { GalleryListResponse, GalleryCreateResponse } from '@/app/api/organizer/media-studio/galleries/route'
import type { AlbumListResponse, AlbumCreateResponse } from '@/app/api/organizer/media-studio/albums/route'

const API = '/api/organizer/media-studio'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

export interface GalleriesClientProps {
  /** 'galleries' shows gallery management; 'albums' focuses the album half. */
  focus: 'galleries' | 'albums'
}

export function GalleriesClient({ focus }: GalleriesClientProps) {
  const { getToken } = useAuth()
  const { showToast } = useToast()
  const { confirm, prompt } = useConfirm()

  const router       = useRouter()
  const searchParams = useSearchParams()

  // The workspace's event — chosen once, on whichever page the organizer started from.
  const { event, setGalleryId, setAlbumId } = useMediaStudio()

  /**
   * True when this page was opened FROM Import Media.
   *
   * The organizer is mid-upload and was sent here for one job. Letting them switch event
   * from this screen would silently change what they are uploading into, so the event is
   * locked and creating a gallery returns them to where they came from.
   */
  const fromImport = searchParams.get(FROM_PARAM) === 'import'

  const [galleries, setGalleries] = useState<GalleryView[]>([])
  const [gallery,   setGallery]   = useState<GalleryView | null>(null)
  const [albums,    setAlbums]    = useState<AlbumView[]>([])
  const [busy,      setBusy]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  // RD-MEDIA-UX-04 · search and filter.
  //
  // Both operate on the list ALREADY in memory — no query parameter, no extra request, no
  // repository change. The audit found Media Studio shipped no search at all while
  // `SearchInput` and `FilterTabs` sat unused in components/admin.
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'withPhotos' | 'empty'>('all')

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

  // ── Load galleries when an event is chosen ──
  useEffect(() => {
    if (!event) return
    let cancelled = false
    const run = async () => {
      setBusy(true); setError(null)
      try {
        const data = await call<GalleryListResponse>(`/galleries?eventId=${encodeURIComponent(event.eventId)}`)
        if (!cancelled) { setGalleries(data.galleries); setGallery(null); setAlbums([]) }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load galleries.')
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  // ── Load albums when a gallery is chosen ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!gallery) {
        // Cleared inside the async body rather than synchronously in the effect: a
        // synchronous setState here cascades a second render on every selection change.
        if (!cancelled) setAlbums([])
        return
      }
      try {
        const data = await call<AlbumListResponse>(`/albums?galleryId=${encodeURIComponent(gallery.galleryId)}`)
        if (!cancelled) setAlbums(data.albums)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load albums.')
      }
    }
    void run()
    return () => { cancelled = true }
  }, [gallery, call])

  async function addGallery(preset: string, name?: string) {
    if (!event) return
    setBusy(true)
    try {
      const created = await call<GalleryCreateResponse>('/galleries', {
        method: 'POST',
        body: JSON.stringify({ eventId: event.eventId, preset, name }),
      })
      setGalleries(prev => [...prev, created.gallery])
      showToast(`Gallery "${created.gallery.name}" created.`, 'success')

      // RD-MEDIA-03 · Auto-return. The organizer came from Import Media because a gallery
      // was missing; the moment it exists, that reason is gone. The new gallery is set as
      // the upload target FIRST, so they land back on a screen that is ready to go — and
      // the queue, the profile and the files they already chose are all still there,
      // because the workspace layout never unmounted.
      if (fromImport && event) {
        setGalleryId(created.gallery.galleryId)
        setAlbumId(null)
        router.push(withEvent(ROUTES.MEDIA_STUDIO_IMPORT, event.eventId))
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not create the gallery.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function addAlbum(name: string) {
    if (!gallery) return
    setBusy(true)
    try {
      const created = await call<AlbumCreateResponse>('/albums', {
        method: 'POST',
        body: JSON.stringify({ galleryId: gallery.galleryId, name }),
      })
      setAlbums(prev => [...prev, created.album])
      setGalleries(prev => prev.map(g =>
        g.galleryId === gallery.galleryId ? { ...g, albumCount: g.albumCount + 1 } : g))
      showToast(`Album "${created.album.name}" created.`, 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not create the album.', 'error')
    } finally {
      setBusy(false)
    }
  }

  /** An organizer-named gallery, always available regardless of the resolved template. */
  async function addCustomGallery() {
    const name = await prompt({
      title: 'Create a custom gallery',
      message: 'Name it however you like — for example a sponsor zone, a specific camera position, or a moment the suggestions do not cover.',
      placeholder: 'Gallery name',
      confirmLabel: 'Create gallery',
      required: true,
    })
    if (!name) return
    await addGallery(CUSTOM_GALLERY_KEY, name)
  }

  async function removeGallery(g: GalleryView) {
    const ok = await confirm({
      title: `Delete "${g.name}"?`,
      message: 'A gallery can only be deleted when it is empty, so no photos are lost.',
      confirmLabel: 'Delete gallery',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await call(`/galleries/${g.galleryId}`, { method: 'DELETE' })
      setGalleries(prev => prev.filter(x => x.galleryId !== g.galleryId))
      if (gallery?.galleryId === g.galleryId) setGallery(null)
      showToast('Gallery deleted.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not delete the gallery.', 'error')
    }
  }

  async function removeAlbum(a: AlbumView) {
    const ok = await confirm({
      title: `Delete "${a.name}"?`,
      message: 'An album can only be deleted when it is empty, so no photos are lost.',
      confirmLabel: 'Delete album',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await call(`/albums/${a.albumId}`, { method: 'DELETE' })
      setAlbums(prev => prev.filter(x => x.albumId !== a.albumId))
      showToast('Album deleted.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not delete the album.', 'error')
    }
  }

  // Recomputed whenever the selected event changes, so the suggestions follow the event
  // automatically. Media Studio passes the type straight through and never interprets it.
  const template = resolveGalleryTemplate(event?.eventType, event?.eventSubtype)

  // Suggestions already taken. Keyed on the persisted `preset`, which is why the marathon
  // keys were kept identical — a gallery created before RD-MEDIA-02 still de-duplicates.
  const existingPresets = new Set(galleries.map(g => g.preset))

  /** Presentation-only narrowing of the fetched list. */
  const visible = galleries.filter(g => {
    if (filter === 'withPhotos' && g.assetCount === 0) return false
    if (filter === 'empty' && g.assetCount > 0) return false
    const q = search.trim().toLowerCase()
    return q === '' || g.name.toLowerCase().includes(q)
  })

  const totalPhotos = galleries.reduce((n, g) => n + g.assetCount, 0)

  return (
    <div className={MEDIA_PAGE_STACK}>
      {/* RD-MEDIA-UX-04 — the same bar Import uses, so every Media Studio page answers
          "where am I working?" identically. */}
      <MediaWorkspaceBar
        eventName={event?.name ?? null}
        galleryName={gallery?.name ?? null}
      />

      <Panel label="Event" title="Media is organised per event">
        <EventContextBar
          locked={fromImport}
          backHref={event ? withEvent(ROUTES.MEDIA_STUDIO_IMPORT, event.eventId) : ROUTES.MEDIA_STUDIO_IMPORT}
          backLabel="Back to Import Media"
        />
      </Panel>

      {error && <Banner tone="error" title="Something went wrong">{error}</Banner>}

      <div className={MEDIA_WORKSPACE_GRID}>
        <div className="min-w-0 space-y-4">

      {event && (
        <Panel
          label="Galleries"
          title="Group photos by race, location or moment"
        >
          <div className="mb-3">
            <MediaFilterBar
              search={search}
              onSearch={setSearch}
              placeholder="Search galleries…"
              filters={[
                { value: 'all' as const,        label: 'All',        count: galleries.length },
                { value: 'withPhotos' as const, label: 'With photos', count: galleries.filter(g => g.assetCount > 0).length },
                { value: 'empty' as const,      label: 'Empty',      count: galleries.filter(g => g.assetCount === 0).length },
              ]}
              filter={filter}
              onFilter={setFilter}
            />
          </div>

          {busy ? (
            <MediaLoadingState rows={3} />
          ) : galleries.length === 0 ? (
            <MediaEmptyState
              icon={Images}
              title={`No galleries yet for ${event.name}`}
              description="Add one of the suggested galleries below, or create your own."
            />
          ) : visible.length === 0 ? (
            <MediaEmptyState
              icon={Images}
              title="No galleries match"
              description="Try a different search or filter."
            />
          ) : (
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {visible.map(g => {
                const selected = g.galleryId === gallery?.galleryId
                return (
                  <li key={g.galleryId}>
                    <div className={cn(
                      'flex items-center gap-3 rounded-xl border bg-card p-3.5 transition-colors',
                      selected ? 'border-primary/50 bg-primary/[0.04]' : 'border-border',
                    )}>
                      {/* RD-MEDIA-06: the counts are now a LINK. They used to only toggle
                          album management, so "1 photo" was a dead end with nowhere to go
                          and no way to see the photo. */}
                      <Link
                        href={`${ROUTES.MEDIA_STUDIO_GALLERIES}/${g.galleryId}`}
                        className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <p className="truncate text-fs-base font-semibold text-foreground">{g.name}</p>
                        <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                          {g.assetCount.toLocaleString('en-IN')} photos · {g.albumCount} albums · {formatBytes(g.bytesStored)}
                        </p>
                      </Link>
                      <button
                        type="button"
                        onClick={() => setGallery(selected ? null : g)}
                        aria-pressed={selected}
                        aria-label={selected ? `Hide albums in ${g.name}` : `Manage albums in ${g.name}`}
                        className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Layers className="size-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeGallery(g)}
                        aria-label={`Delete ${g.name}`}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-fs-sm font-semibold text-foreground">
                Suggested Galleries
              </h3>
              {/* Which template resolved — so an organizer can see WHY these names appeared,
                  rather than wondering where "Keynote" came from. */}
              <span className="text-fs-2xs text-muted-foreground">
                Based on your event type · {template.label}
              </span>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-2">
              {template.suggestions.map(suggestion => (
                <Button
                  key={suggestion.key}
                  variant="outline"
                  size="sm"
                  disabled={busy || existingPresets.has(suggestion.key)}
                  onClick={() => void addGallery(suggestion.key, suggestion.name)}
                >
                  <FolderPlus className="size-3.5" aria-hidden />
                  {suggestion.name}
                </Button>
              ))}

              {/* Always available, whatever the template suggests. */}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void addCustomGallery()}
              >
                <Plus className="size-3.5" aria-hidden />
                Create Custom Gallery
              </Button>
            </div>

            <p className="mt-2 text-fs-2xs text-muted-foreground">
              Suggestions are only defaults — rename, reorder or delete any gallery, and add
              your own at any time.
            </p>
          </Card>
        </Panel>
      )}

      {gallery && (
        <Panel
          label="Albums"
          title={`Subdivide "${gallery.name}" by camera or vantage point`}
        >
          {albums.length === 0 ? (
            <MediaEmptyState
              icon={Layers}
              title="No albums yet"
              description="Albums are optional. Photos can sit directly in the gallery."
            />
          ) : (
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {albums.map(a => (
                <li key={a.albumId}>
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-fs-base font-semibold text-foreground">{a.name}</p>
                      <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                        {a.assetCount.toLocaleString('en-IN')} photos · {formatBytes(a.bytesStored)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeAlbum(a)}
                      aria-label={`Delete ${a.name}`}
                      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Card>
            <h3 className="text-fs-sm font-semibold text-foreground">Add an album</h3>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {ALBUM_SUGGESTIONS.map(name => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  disabled={busy || albums.some(a => a.name === name)}
                  onClick={() => void addAlbum(name)}
                >
                  <FolderPlus className="size-3.5" aria-hidden />
                  {name}
                </Button>
              ))}
            </div>
          </Card>
        </Panel>
      )}

      {focus === 'albums' && !gallery && event && (
        <Banner tone="info" title="Choose a gallery">
          Albums live inside a gallery. Pick one above to manage its albums.
        </Banner>
      )}
        </div>

        {/* ═══ Summary rail — the same one Import uses ═══ */}
        <div className={MEDIA_RAIL_COLUMN}>
          <MediaSummaryRail>
            <div className="space-y-4">
              <h2 className="text-fs-md font-semibold text-foreground">At a glance</h2>

              <MediaMetricRow>
                <MediaMetricCard label="Galleries" value={galleries.length.toLocaleString('en-IN')} />
                <MediaMetricCard label="Photos" value={totalPhotos.toLocaleString('en-IN')} />
              </MediaMetricRow>

              <dl className="space-y-1.5 border-t border-border pt-3">
                <RailMetric label="Event" value={event?.name ?? '—'} truncate />
                <RailMetric label="Selected" value={gallery?.name ?? 'None'} truncate />
                {gallery && (
                  <RailMetric label="Albums" value={albums.length.toLocaleString('en-IN')} />
                )}
              </dl>

              {/* Kept from the original page: the one rule an organizer needs before
                  reaching for a delete button. */}
              <p className="border-t border-border pt-3 text-fs-2xs leading-relaxed text-muted-foreground">
                A gallery or album can only be deleted once it is empty — that keeps the
                database and object storage in step, so no photo is ever orphaned.
              </p>
            </div>
          </MediaSummaryRail>
        </div>
      </div>
    </div>
  )
}
