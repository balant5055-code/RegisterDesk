'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Images, ChevronLeft, ChevronRight } from 'lucide-react'
import type { MediaAsset } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface SharedGalleryProps {
  gallery:      MediaAsset[]
  title:        string
  description?: string
  accentColor?: string   // CSS color value, e.g. '#7c3aed'
  variant?:     'light' | 'dark'
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function SharedGallery({
  gallery,
  title,
  description,
  accentColor = '#6b7280',
  variant = 'light',
}: SharedGalleryProps) {
  const images = gallery.filter(a => a.value?.trim())
  if (!images.length) return null

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [showAll, setShowAll]         = useState(false)

  const visibleImages = showAll ? images : images.slice(0, 9)
  const hasMore       = images.length > 9 && !showAll

  const prev = () => setLightboxIdx(i => i !== null ? (i - 1 + images.length) % images.length : 0)
  const next = () => setLightboxIdx(i => i !== null ? (i + 1) % images.length : 0)

  const isDark = variant === 'dark'

  return (
    <section id="gallery" className={isDark ? 'bg-gray-950 py-14 sm:py-18' : 'bg-white py-16 sm:py-20'}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p
            className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em]"
            style={{ color: accentColor }}
          >
            Gallery
          </p>
          <h2 className={`text-2xl font-black tracking-tight sm:text-[2rem] ${isDark ? 'text-white' : 'text-gray-950'}`}>
            {title}
          </h2>
          <p className={`mt-2 text-base ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
            {description ?? `${images.length} photo${images.length !== 1 ? 's' : ''} from the event`}
          </p>
        </motion.div>

        {/* Photo grid */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {visibleImages.map((asset, i) => (
            <motion.button
              key={i}
              type="button"
              onClick={() => setLightboxIdx(i)}
              initial={{ opacity: 0, scale: 0.97 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: Math.min(i, 8) * 0.04 }}
              className={`group relative aspect-square overflow-hidden rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
                isDark ? 'bg-gray-800' : 'bg-gray-100'
              }`}
              aria-label={`View photo ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={asset.value}
                alt={asset.originalFileName ?? `Photo ${i + 1}`}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/0 transition-all duration-300 group-hover:bg-black/20" />
            </motion.button>
          ))}
        </div>

        {/* Show more / show less */}
        {(hasMore || (showAll && images.length > 9)) && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              className={`inline-flex items-center gap-2 rounded-full border px-6 py-2.5 text-sm font-semibold transition-all duration-150 ${
                isDark
                  ? 'border-white/20 bg-white/5 text-white/70 hover:border-white/30 hover:bg-white/10 hover:text-white'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              <Images className="size-4" aria-hidden />
              {showAll ? 'Show less' : `View all ${images.length} photos`}
            </button>
          </div>
        )}

      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxIdx !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
            onClick={() => setLightboxIdx(null)}
          >
            {/* Close */}
            <button
              type="button"
              onClick={() => setLightboxIdx(null)}
              className="absolute right-4 top-4 z-10 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:bg-white/20"
              aria-label="Close gallery"
            >
              <X className="size-5" aria-hidden />
            </button>

            {/* Prev */}
            {images.length > 1 && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); prev() }}
                className="absolute left-4 top-1/2 z-10 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:bg-white/20"
                aria-label="Previous photo"
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
            )}

            {/* Image */}
            <motion.div
              key={lightboxIdx}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="relative max-h-[90vh] max-w-5xl"
              onClick={e => e.stopPropagation()}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={images[lightboxIdx]!.value}
                alt={images[lightboxIdx]!.originalFileName ?? `Photo ${lightboxIdx + 1}`}
                className="max-h-[90vh] max-w-full rounded-xl object-contain"
              />
              <p className="mt-2 text-center text-xs text-white/50">
                {lightboxIdx + 1} / {images.length}
              </p>
            </motion.div>

            {/* Next */}
            {images.length > 1 && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); next() }}
                className="absolute right-4 top-1/2 z-10 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:bg-white/20"
                aria-label="Next photo"
              >
                <ChevronRight className="size-5" aria-hidden />
              </button>
            )}

          </motion.div>
        )}
      </AnimatePresence>

    </section>
  )
}
