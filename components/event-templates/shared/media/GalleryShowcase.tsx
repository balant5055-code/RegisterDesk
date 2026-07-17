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
import type { GalleryItem, MediaAsset } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'

// ── legacy adapter (temporary) ──
export function mediaToGallery(assets: MediaAsset[] | undefined): GalleryItem[] {
  return (assets ?? [])
    .filter(a => a?.value?.trim())
    .map((a, i) => ({ id: `m_${i}`, url: a.value, enabled: true, type: 'image' as const }))
}

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

// Reserved-aspect masonry rhythm (fixed row height → no CLS). Featured overrides.
const SPAN = ['row-span-2', '', 'sm:col-span-2', '', 'row-span-2', 'sm:col-span-2 row-span-2', '', 'row-span-2']

export interface GalleryShowcaseProps {
  items:     GalleryItem[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}

export function GalleryShowcase({ items, eyebrow = 'Gallery', title = 'Moments From the Event', subtitle }: GalleryShowcaseProps) {
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

  return (
    <SectionShell id="gallery" maxW="6xl">

        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />

        {/* reserved-aspect masonry */}
        <div className="grid auto-rows-[9rem] grid-cols-2 gap-3 [grid-auto-flow:dense] sm:auto-rows-[10rem] sm:grid-cols-3 lg:grid-cols-4">
          {tiles.map((item, i) => {
            const kind  = kindOf(item)
            const thumb = thumbFor(item, kind)
            const chip  = typeChip(item)
            const span  = item.featured ? 'col-span-2 row-span-2' : SPAN[i % SPAN.length]
            return (
              <button
                key={item.id}
                type="button"
                onClick={e => { openerRef.current = e.currentTarget; setZoom(false); setOpen(i) }}
                aria-label={`Open ${item.title?.trim() || (kind === 'image' ? 'image' : 'video')} ${i + 1} of ${tiles.length}`}
                className={cn('group relative overflow-hidden rounded-xl bg-muted outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2', span)}
              >
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt={item.alt?.trim() || item.title?.trim() || ''}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transform-none"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundImage: 'var(--primary-gradient)' }}>
                    <Film className="size-8 text-white/40" aria-hidden />
                  </div>
                )}

                <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

                {kind !== 'image' && (
                  <span className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform duration-200 group-hover:scale-110">
                    <Play className="size-5 translate-x-0.5" aria-hidden />
                  </span>
                )}
                {chip && (
                  <span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">{chip}</span>
                )}
                {item.title?.trim() && (
                  <span className="absolute inset-x-2.5 bottom-2.5 line-clamp-1 text-left text-[12.5px] font-semibold text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    {item.title}
                  </span>
                )}
              </button>
            )
          })}
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
                <span className="text-[13px] font-medium tabular-nums">{open! + 1} / {tiles.length}</span>
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
                  {active.title?.trim() && <p className="text-[15px] font-semibold">{active.title}</p>}
                  {active.description?.trim() && <p className="mt-1 text-[13px] text-white/70">{active.description}</p>}
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-white/55">
                    {active.photographer?.trim() && <span className="inline-flex items-center gap-1.5"><Camera className="size-3.5" aria-hidden />{active.photographer}</span>}
                    {active.location?.trim() && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" aria-hidden />{active.location}</span>}
                    {active.date?.trim() && <span>{active.date}</span>}
                    {active.copyright?.trim() && <span>© {active.copyright}</span>}
                  </div>
                  {active.tags && active.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                      {active.tags.filter(Boolean).map(tag => (
                        <span key={tag} className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/70">#{tag}</span>
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
