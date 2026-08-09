'use client'

// RD-MEDIA-03 · The Media Studio workspace context.
//
// ═══ ONE EVENT, CHOSEN ONCE ═══════════════════════════════════════════════════
// Before this, every Media Studio page owned its own `useState<MediaEventRow>`. Import,
// Galleries, Albums and Storage each asked the organizer the same question, and walking
// from one to another lost the answer — plus the gallery, the compression profile and the
// files already selected.
//
// This provider is mounted in the Media Studio LAYOUT, which does not unmount as the
// organizer moves between its pages. So the selection survives navigation, and so does the
// upload queue — including the `File` objects, which cannot be serialised and so could never
// have been restored any other way.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── The active event is DERIVED, never stored ───────────────────────────────
//   1. `?eventId=` in the URL — set by `setEvent`, so a link is shareable and a reload keeps
//      its place. This wins.
//   2. localStorage — so arriving from the sidebar with no parameter resumes the last event.
//   3. neither — the organizer picks, exactly as before.
//
// Deriving rather than mirroring into state is deliberate: a `useEffect` that copies the URL
// into state is a cascading render and, worse, a second source of truth that can disagree
// with the address bar. localStorage is read through `useSyncExternalStore`, which is the
// sanctioned way to read a browser store without breaking hydration.
//
// An id that does not match a loaded event is ignored rather than held — pinning the
// workspace to an event that cannot be loaded shows an empty gallery list with no
// explanation.
//
// NO Firestore schema change, NO new collection, NO new event model. One client-side context
// over the EXISTING `GET /api/organizer/events` response.

import {
  createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore,
  type ReactNode,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
// RD-MS-CLOSURE-01 · the resolved upload defaults for the active event.
import { useMediaDefaults, type RenditionPlan } from '@/features/media-studio/hooks/useMediaDefaults'
import { useMediaEvents, type MediaEventRow } from '@/features/media-studio/hooks/useMediaEvents'
import { useUploadQueue, type UploadQueue } from '@/features/media-studio/hooks/useUploadQueue'
// RD-MEDIA-UI-04 — every Media Studio page loads its events client-side, so the document
// grows AFTER hydration. Automatic scroll restoration would aim at content that does not
// exist yet and land mid-page.
import { useManualScrollRestoration } from '@/features/media-studio/hooks/useScrollRestoration'

const STORAGE_KEY = 'registerdesk.mediaStudio.eventId'

/** The query parameter every Media Studio page understands. */
export const EVENT_PARAM = 'eventId'

/** Set when a page was opened FROM Import Media, so it can lock the event. */
export const FROM_PARAM = 'from'

export interface MediaStudioContextValue {
  /** Every published event this workspace owns. */
  events:  MediaEventRow[]
  loading: boolean
  error:   string | null

  /** The workspace's active event. Null until one is chosen. */
  event:    MediaEventRow | null
  setEvent: (event: MediaEventRow | null) => void

  /** Selections carried between pages so nothing is asked twice. */
  galleryId: string | null
  setGalleryId: (id: string | null) => void
  albumId:   string | null
  setAlbumId: (id: string | null) => void
  profileId: string
  setProfileId: (id: string) => void
  /**
   * RD-MS-CLOSURE-01 · which renditions an upload produces, resolved global → plan → event.
   *
   * Read-only: renditions are a platform/plan decision about storage cost, not a per-batch
   * choice. The compression PROFILE stays selectable — `profileId` above merely starts at the
   * resolved default instead of at a hardcoded constant.
   */
  renditionPlan: RenditionPlan

  /**
   * THE upload queue. One instance for the whole workspace, held here rather than inside
   * Import Media, so leaving for Galleries and coming back does not discard it.
   */
  queue: UploadQueue
}

const MediaStudioCtx = createContext<MediaStudioContextValue | null>(null)

// ─── localStorage, read the way React wants it read ───────────────────────────

function readStoredEventId(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY) } catch { return null }
}

function writeStoredEventId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch { /* a blocked or full storage quota must not break the workspace */ }
}

/** Another tab switching event is worth following; nothing else changes this key. */
function subscribeToStoredEventId(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

/** Null on the server, so hydration matches and React re-reads on the client. */
const serverEventId = () => null

export function MediaStudioProvider({ children }: { children: ReactNode }) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const { events, loading, error } = useMediaEvents()
  const queue = useUploadQueue()

  useManualScrollRestoration()

  const storedEventId = useSyncExternalStore(
    subscribeToStoredEventId, readStoredEventId, serverEventId,
  )
  const urlEventId = searchParams.get(EVENT_PARAM)

  /**
   * Gallery and album, tagged with the event they belong to.
   *
   * Storing the owning event alongside them is what makes switching event safe: a gallery id
   * from another event would 404 on the next request, and silently carrying it is how a
   * workspace ends up uploading into the wrong place. The check is a derivation below, so
   * there is no effect to forget.
   */
  const [selection, setSelection] = useState<{
    eventId: string | null; galleryId: string | null; albumId: string | null
  }>({ eventId: null, galleryId: null, albumId: null })

  /**
   * RD-MS-CLOSURE-01 · the organizer's EXPLICIT profile choice, tagged with its event.
   *
   * Not `useState(DEFAULT_PROFILE_ID)` any more. The starting point is now the resolved
   * default, and this records only a deliberate change away from it — so a plan-level or
   * event-level default actually takes effect, and switching event returns to that event's
   * own default rather than carrying the last one across.
   *
   * A derivation rather than an effect, matching how gallery and album selection already
   * work here: syncing state in an effect would fight the resolved value on every load.
   */
  const [profileChoice, setProfileChoice] = useState<{ eventId: string | null; id: string } | null>(null)

  const event = useMemo(() => {
    const find = (id: string | null) =>
      (id ? events.find(e => e.eventId === id) : undefined) ?? null
    return find(urlEventId) ?? find(storedEventId)
  }, [events, urlEventId, storedEventId])

  const eventId = event?.eventId ?? null
  // Selections only apply to the event they were made in.
  const galleryId = selection.eventId === eventId ? selection.galleryId : null
  const albumId   = selection.eventId === eventId ? selection.albumId   : null

  // RD-MS-CLOSURE-01 · resolved global → plan → event, from the EXISTING /limits route.
  const defaults = useMediaDefaults(eventId)
  // The organizer's choice wins for the event they made it in; otherwise the resolved
  // default does. `DEFAULT_PROFILE_ID` survives only as the hook's offline fallback.
  const profileId = profileChoice?.eventId === eventId
    ? profileChoice.id
    : defaults.profileId
  const setProfileId = useCallback((id: string) => {
    setProfileChoice({ eventId, id })
  }, [eventId])

  const setEvent = useCallback((next: MediaEventRow | null) => {
    writeStoredEventId(next?.eventId ?? null)
    setSelection({ eventId: next?.eventId ?? null, galleryId: null, albumId: null })

    // Keep the address bar in step, so a refresh, a bookmark and a shared link all agree
    // with what is on screen. `replace` — switching event is not a step to go back through.
    //
    // Files already queued are NOT cleared: they are the organizer's work, not the event's,
    // and discarding them unasked would be the exact data loss this sprint removes.
    const params = new URLSearchParams(searchParams.toString())
    if (next) params.set(EVENT_PARAM, next.eventId)
    else params.delete(EVENT_PARAM)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const setGalleryId = useCallback((id: string | null) => {
    setSelection(prev => ({ eventId, galleryId: id, albumId: prev.eventId === eventId ? prev.albumId : null }))
  }, [eventId])

  const setAlbumId = useCallback((id: string | null) => {
    setSelection(prev => ({
      eventId,
      galleryId: prev.eventId === eventId ? prev.galleryId : null,
      albumId:   id,
    }))
  }, [eventId])

  const value = useMemo<MediaStudioContextValue>(() => ({
    events, loading, error,
    event, setEvent,
    galleryId, setGalleryId,
    albumId, setAlbumId,
    profileId, setProfileId,
    renditionPlan: defaults.plan,
    queue,
  }), [events, loading, error, event, setEvent, galleryId, setGalleryId, albumId, setAlbumId,
       profileId, setProfileId, defaults.plan, queue])

  return <MediaStudioCtx.Provider value={value}>{children}</MediaStudioCtx.Provider>
}

/**
 * The workspace context.
 *
 * Throws when used outside the Media Studio layout — a silent null would surface much later
 * as an event that mysteriously will not stick.
 */
export function useMediaStudio(): MediaStudioContextValue {
  const ctx = useContext(MediaStudioCtx)
  if (!ctx) {
    throw new Error('useMediaStudio must be used inside the Media Studio layout.')
  }
  return ctx
}

/** A Media Studio href that carries the active event, so the next page inherits it. */
export function withEvent(href: string, eventId: string | null, from?: string): string {
  if (!eventId) return href
  const [base, existing] = href.split('?')
  const params = new URLSearchParams(existing ?? '')
  params.set(EVENT_PARAM, eventId)
  if (from) params.set(FROM_PARAM, from)
  return `${base}?${params.toString()}`
}
