'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight, X, Images } from 'lucide-react'
import type { MediaAsset } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalGalleryProps {
  gallery: MediaAsset[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalGallery({ gallery }: CulturalGalleryProps) {
  const [lightbox,  setLightbox]  = useState<number | null>(null)
  const [showAll,   setShowAll]   = useState(false)

  if (!gallery.length) return null

  const displayed = showAll ? gallery : gallery.slice(0, 10)
  const total     = gallery.length

  function prev() {
    setLightbox(lb => lb !== null ? (lb === 0 ? total - 1 : lb - 1) : null)
  }
  function next() {
    setLightbox(lb => lb !== null ? (lb === total - 1 ? 0 : lb + 1) : null)
  }

  return (
    <section className="bg-gray-950 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-8 flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Images className="size-4 text-amber-400" aria-hidden />
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
                Gallery
              </p>
            </div>
            <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
              Festival Moments
            </h2>
          </div>
          <p className="text-sm text-white/30">{total} photos</p>
        </motion.div>

        {/* Main gallery grid */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {displayed.map((asset, i) => (
            <motion.button
              key={i}
              type="button"
              onClick={() => setLightbox(i)}
              initial={{ opacity: 0, scale: 0.97 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.03 }}
              className={`group relative overflow-hidden rounded-xl bg-gray-800 ${
                i === 0 ? 'col-span-2 row-span-2' : ''
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={asset.value}
                alt={`Festival photo ${i + 1}`}
                className={`h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 ${
                  i === 0 ? 'min-h-[280px]' : 'min-h-[120px]'
                }`}
              />
              <div className="absolute inset-0 bg-black/0 transition-all duration-200 group-hover:bg-black/30" />
            </motion.button>
          ))}
        </div>

        {/* Show more */}
        {!showAll && total > 10 && (
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="mt-5 flex justify-center"
          >
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-6 py-2.5 text-sm font-semibold text-white/70 transition-all hover:border-white/30 hover:bg-white/10 hover:text-white"
            >
              View all {total} photos
            </button>
          </motion.div>
        )}

      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightbox !== null && (
          <motion.div
            key="lb"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
          >
            {/* Close */}
            <button
              type="button"
              onClick={() => setLightbox(null)}
              className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            >
              <X className="size-4" aria-hidden />
            </button>

            {/* Prev */}
            {total > 1 && (
              <button
                type="button"
                onClick={prev}
                className="absolute left-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
            )}

            {/* Image */}
            <motion.div
              key={lightbox}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="mx-16 max-h-[85vh] max-w-4xl overflow-hidden rounded-xl"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={gallery[lightbox]!.value}
                alt={`Festival photo ${lightbox + 1}`}
                className="max-h-[85vh] w-full object-contain"
              />
            </motion.div>

            {/* Next */}
            {total > 1 && (
              <button
                type="button"
                onClick={next}
                className="absolute right-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
              >
                <ChevronRight className="size-5" aria-hidden />
              </button>
            )}

            {/* Counter */}
            <p className="absolute bottom-4 text-sm text-white/40">
              {lightbox + 1} / {total}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
