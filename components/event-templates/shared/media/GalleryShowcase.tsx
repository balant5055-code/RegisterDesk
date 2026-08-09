'use client'

// GalleryShowcase — the event's proof: an editorial reserved-aspect masonry plus a
// premium, fully accessible lightbox. Pure and reusable across every template.
//
// 100% data-driven from `gallery[]`: only enabled items with a URL render; every
// field shows only when present; zero items → the section returns null. Supports
// images and self-hosted / YouTube / Vimeo video (auto-detected, correct viewer in
// the lightbox). `mediaToGallery` adapts legacy MediaAsset[] so old events keep a
// gallery until they migrate.

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Play, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Camera, MapPin, Film } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { getVideoEmbed } from '@/components/event-templates/shared/utils/format'
import type { GalleryItem } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, EventSectionHeader, BRAND_GRADIENT, type SectionBg } from '@/components/event-templates/shared/ui/framework'

// ── legacy adapter ──
// ST41-I01: moved to shared/media/galleryModel.ts (directive-free) so Server Components
// can call it. Import mediaToGallery from there, not from this module.

// ── media kind detection ──
type Kind = 'image' | 'youtube' | 'vimeo' | 'video'
function kindOf(item: GalleryItem): Kind {
  const embed = getVideoEmbed(item.url)
  if (embed?.includes('youtube')) return 'youtube'
  if (embed?.includes('vimeo')) return 'vimeo'
  const t = item.type
  if (t === 'video' || t === 'reel' || t === 'drone' || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(item.url)) return 'video'
  return 'image'
}
function thumbFor(item: GalleryItem, kind: Kind): string {
  if (item.thumbnail?.trim()) return item.thumbnail
  if (kind === 'image') return item.url
  if (kind === 'youtube') {
    const id = getVideoEmbed(item.url)?.match(/embed\/([^?]+)/)?.[1]
    if (id) return `https://img.youtube.com/vi/${id}/hqdefault.jpg`
  }
  return ''
}
const typeChip = (item: GalleryItem): string => {
  const t = item.type
  if (!t || t === 'image') return ''
  return { video: 'Video', reel: 'Reel', drone: 'Drone', poster: 'Poster', banner: 'Banner' }[t] ?? ''
}

// ── Editorial composition (RD-ST11.0) ───────────────────────────────────────────
// The grid used to cycle an eight-entry SPAN array over `auto-rows` with
// `grid-auto-flow: dense`. Two faults: tile size had no relationship to the image (so
// sizing read as random, and nothing was the focal point), and `dense` back-fills gaps
// — which reorders the gallery away from the organiser's ordering AND away from
// DOM/focus order.
//
// It is now a fixed editorial composition, identical for every event:
//
//   ┌───────────────────────────┬─────────────┐
//   │                           │  support 1  │   feature  col-span-8, landscape
//   │        F E A T U R E      ├─────────────┤   supports col-span-4, stacked
//   │                           │  support 2  │
//   └───────────────────────────┴─────────────┘
//   ┌───────────┬───────────┬───────────┐
//   │   rest    │   rest    │   rest    │         rest     col-span-4, equal cards
//   └───────────┴───────────┴───────────┘
//
// The supporting column is a 1fr/1fr grid stretched to the feature's height, so the two
// stacked tiles always divide it exactly — the composition can never go ragged, at any
// container width. Every tile reserves its box via aspect-ratio (or, for the stacked
// pair, via the definite row height), so nothing shifts as images decode.
const GAP = 'gap-3 sm:gap-4'

// Aspect per role. Mobile keeps 4/3 — the least-cropping ratio, so faces survive at
// phone widths; the landscape ratios only apply once there is width to justify them.
const FEATURE_ASPECT = 'aspect-[4/3] sm:aspect-[16/9]'
const CARD_ASPECT    = 'aspect-[4/3] sm:aspect-[16/9]'
// Stacked pair: ratio on small screens, definite height from the 1fr rows on desktop.
const STACK_ASPECT   = 'aspect-[4/3] sm:aspect-[16/9] lg:aspect-auto lg:h-full lg:min-h-0'

// ── One tile ────────────────────────────────────────────────────────────────────
// One presentation for every role — the role only supplies span and aspect, so radius,
// elevation, hover and focus behaviour can never drift between the feature and a card.
function Tile({ item, index, total, span, aspect, onOpen }: {
  item:   GalleryItem
  index:  number
  total:  number
  span:   string
  aspect: string
  onOpen: (index: number, el: HTMLElement) => void
}) {
  const kind  = kindOf(item)
  const thumb = thumbFor(item, kind)
  const chip  = typeChip(item)

  return (
    <button
      type="button"
      onClick={e => onOpen(index, e.currentTarget)}
      aria-label={`Open ${item.title?.trim() || (kind === 'image' ? 'image' : 'video')} ${index + 1} of ${total}`}
      className={cn(
        'group relative overflow-hidden rounded-2xl bg-muted shadow-sm outline-none',
        'transition-shadow duration-300 hover:shadow-lg',
        'focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2',
        span, aspect,
      )}
    >
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt={item.alt?.trim() || item.title?.trim() || ''}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03] motion-reduce:transform-none"
        />
      ) : (
        <div className={cn('absolute inset-0 flex items-center justify-center', BRAND_GRADIENT)}>
          <Film className="size-8 text-white/40" aria-hidden />
        </div>
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

      {kind !== 'image' && (
        <span className="absolute left-1/2 top-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform duration-300 group-hover:scale-110 motion-reduce:transform-none">
          <Play className="size-5 translate-x-0.5" aria-hidden />
        </span>
      )}
      {chip && (
        <span className="absolute left-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-fs-2xs font-bold uppercase tracking-wide text-white backdrop-blur-sm">{chip}</span>
      )}
      {item.title?.trim() && (
        <span className="absolute inset-x-4 bottom-3.5 line-clamp-1 text-left text-fs-sm font-semibold text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          {item.title}
        </span>
      )}
    </button>
  )
}

export interface GalleryShowcaseProps {
  items:     GalleryItem[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
  /** RD-ST5.2 P0.2 — band background, chosen by the template. Defaults to the previous value. */
  bg?:       SectionBg
}

export function GalleryShowcase({ items, eyebrow = 'Gallery', title = 'Moments From the Event', subtitle, bg = 'white' }: GalleryShowcaseProps) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState<number | null>(null)
  const [zoom, setZoom] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const touchX = useRef<number | null>(null)

  const tiles = (items ?? [])
    .filter(i => i && i.enabled !== false && i.url?.trim())
    .sort((a, b) => {
      const af = a.featured ? 1 : 0, bf = b.featured ? 1 : 0
      if (af !== bf) return bf - af
      return (a.featuredOrder ?? a.displayOrder ?? 0) - (b.featuredOrder ?? b.displayOrder ?? 0)
    })

  const close = () => setOpen(null)
  const go = (dir: 1 | -1) => { setZoom(false); setOpen(o => (o === null ? o : (o + dir + tiles.length) % tiles.length)) }

  // lightbox: scroll lock, focus trap, keyboard, focus restore
  useEffect(() => {
    if (open === null) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const t = setTimeout(() => dialogRef.current?.focus(), 0)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'Tab') {
        const f = dialogRef.current?.querySelectorAll<HTMLElement>('button,[href],video,iframe,[tabindex]:not([tabindex="-1"])')
        if (!f || f.length === 0) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      clearTimeout(t)
      openerRef.current?.focus?.()
    }
  }, [open, tiles.length])   // eslint-disable-line react-hooks/exhaustive-deps

  if (tiles.length === 0) return null

  const active = open !== null ? tiles[open] : null
  const activeKind = active ? kindOf(active) : 'image'

  // Roles are assigned by position, so the organiser's ordering decides the focal point:
  // whatever they featured (or ordered first) becomes the feature image.
  const feature  = tiles[0]
  const supports = tiles.slice(1, 3)
  const rest     = tiles.slice(3)

  const openAt = (index: number, el: HTMLElement) => { openerRef.current = el; setZoom(false); setOpen(index) }

  return (
    <SectionShell id="gallery" maxW="6xl" bg={bg}>

        <EventSectionHeader eyebrow={eyebrow} title={title} description={subtitle} />

        <div className={cn('flex flex-col', GAP)}>

          {/* ── Feature composition — 8 / 4 on desktop, stacked on mobile ── */}
          <div className={cn('flex flex-col lg:grid lg:grid-cols-12', GAP)}>
            <Tile
              item={feature} index={0} total={tiles.length}
              // A gallery of one has no supporting column, so the feature takes the
              // full width rather than leaving a third of the row empty.
              span={supports.length > 0 ? 'lg:col-span-8' : 'lg:col-span-12'}
              aspect={FEATURE_ASPECT}
              onOpen={openAt}
            />

            {supports.length > 0 && (
              // Mobile: the 2-up row directly under the feature. Desktop: the supporting
              // column, its 1fr rows stretched to exactly the feature's height.
              <div
                className={cn(
                  'grid grid-cols-2 lg:col-span-4 lg:grid-cols-1', GAP,
                  supports.length === 2 ? 'lg:grid-rows-2' : 'lg:grid-rows-1',
                )}
              >
                {supports.map((item, i) => (
                  <Tile
                    key={item.id}
                    item={item} index={i + 1} total={tiles.length}
                    span="" aspect={STACK_ASPECT}
                    onOpen={openAt}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── Supporting content — equal cards, same size as the stacked pair ── */}
          {rest.length > 0 && (
            <div className={cn('grid grid-cols-2 lg:grid-cols-12', GAP)}>
              {rest.map((item, i) => (
                <Tile
                  key={item.id}
                  item={item} index={i + 3} total={tiles.length}
                  span="lg:col-span-4" aspect={CARD_ASPECT}
                  onOpen={openAt}
                />
              ))}
            </div>
          )}
        </div>

      {/* ── lightbox ── */}
      <AnimatePresence>
        {active && (
          <motion.div
            initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[120] flex flex-col bg-black/92 backdrop-blur-sm"
            onClick={close}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={active.title?.trim() || 'Gallery viewer'}
              tabIndex={-1}
              className="relative flex h-full flex-col outline-none"
              onClick={e => e.stopPropagation()}
            >
              {/* top bar */}
              <div className="flex items-center justify-between px-4 py-3 text-white/80">
                <span className="text-fs-sm font-medium tabular-nums">{open! + 1} / {tiles.length}</span>
                <div className="flex items-center gap-1">
                  {activeKind === 'image' && (
                    <button type="button" onClick={() => setZoom(z => !z)} aria-label={zoom ? 'Zoom out' : 'Zoom in'}
                      className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                      {zoom ? <ZoomOut className="size-5" aria-hidden /> : <ZoomIn className="size-5" aria-hidden />}
                    </button>
                  )}
                  <button type="button" onClick={close} aria-label="Close"
                    className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                    <X className="size-5" aria-hidden />
                  </button>
                </div>
              </div>

              {/* media */}
              <div
                className={cn('relative flex flex-1 items-center justify-center px-4 pb-2', zoom ? 'overflow-auto' : 'overflow-hidden')}
                onTouchStart={e => { touchX.current = e.touches[0].clientX }}
                onTouchEnd={e => {
                  if (touchX.current === null) return
                  const dx = e.changedTouches[0].clientX - touchX.current
                  if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1)
                  touchX.current = null
                }}
              >
                {activeKind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={active.url}
                    alt={active.alt?.trim() || active.title?.trim() || ''}
                    onClick={() => setZoom(z => !z)}
                    className={cn('max-h-full max-w-full rounded-lg object-contain transition-transform duration-200',
                      zoom ? 'scale-[1.8] cursor-zoom-out' : 'cursor-zoom-in')}
                  />
                ) : activeKind === 'video' ? (
                  <video src={active.url} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg" />
                ) : (
                  <div className="aspect-video w-full max-w-4xl overflow-hidden rounded-lg bg-black">
                    <iframe
                      src={`${getVideoEmbed(active.url)}${getVideoEmbed(active.url)?.includes('?') ? '&' : '?'}autoplay=1`}
                      title={active.title?.trim() || 'Video'}
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                      className="h-full w-full border-0"
                    />
                  </div>
                )}

                {/* prev / next */}
                {tiles.length > 1 && (
                  <>
                    <button type="button" onClick={() => go(-1)} aria-label="Previous"
                      className="absolute left-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                      <ChevronLeft className="size-6" aria-hidden />
                    </button>
                    <button type="button" onClick={() => go(1)} aria-label="Next"
                      className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                      <ChevronRight className="size-6" aria-hidden />
                    </button>
                  </>
                )}
              </div>

              {/* caption */}
              {(active.title?.trim() || active.description?.trim() || active.photographer?.trim() || active.location?.trim() || active.date?.trim() || (active.tags?.length ?? 0) > 0 || active.copyright?.trim()) && (
                <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-1 text-center text-white">
                  {active.title?.trim() && <p className="text-fs-md font-semibold">{active.title}</p>}
                  {active.description?.trim() && <p className="mt-1 text-fs-sm text-white/70">{active.description}</p>}
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-fs-xs text-white/55">
                    {active.photographer?.trim() && <span className="inline-flex items-center gap-1.5"><Camera className="size-3.5" aria-hidden />{active.photographer}</span>}
                    {active.location?.trim() && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" aria-hidden />{active.location}</span>}
                    {active.date?.trim() && <span>{active.date}</span>}
                    {active.copyright?.trim() && <span>© {active.copyright}</span>}
                  </div>
                  {active.tags && active.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                      {active.tags.filter(Boolean).map(tag => (
                        <span key={tag} className="rounded-full bg-white/10 px-2 py-0.5 text-fs-2xs font-medium text-white/70">#{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SectionShell>
  )
}
