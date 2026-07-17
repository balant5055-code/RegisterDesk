'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import type { MediaAsset } from '@/components/wizard/eventDetailsConfig'

export function CommunityMasonry({ gallery }: { gallery: MediaAsset[] }) {
  const images  = gallery.filter(img => img.value?.trim()).slice(0, 9)
  const [lb, setLb] = useState<string | null>(null)

  if (images.length === 0) return null

  const cols = images.length === 1 ? 'grid-cols-1'
    : images.length === 2 ? 'grid-cols-2'
    : 'grid-cols-3'

  return (
    <>
      <section className="overflow-hidden">
        <div className={`grid gap-1 ${cols}`}>
          {images.map((img, i) => (
            <motion.button
              key={i}
              type="button"
              onClick={() => setLb(img.value)}
              aria-label={`View photo ${i + 1}`}
              initial={{ opacity: 0, scale: 0.98 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.1 }}
              transition={{ delay: i * 0.04, duration: 0.5 }}
              className="group relative overflow-hidden bg-gray-100"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.value}
                alt={img.originalFileName ?? `Photo ${i + 1}`}
                className={`w-full object-cover transition-transform duration-700 group-hover:scale-105 ${
                  i === 0 && images.length >= 3 ? 'aspect-[4/3]' : 'aspect-square'
                }`}
                loading={i < 3 ? 'eager' : 'lazy'}
              />
              <div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
            </motion.button>
          ))}
        </div>
      </section>

      {/* Lightbox */}
      <AnimatePresence>
        {lb && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4"
            onClick={() => setLb(null)}
          >
            <button
              onClick={() => setLb(null)}
              aria-label="Close"
              className="absolute right-5 top-5 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            >
              <X className="size-5" />
            </button>
            <motion.img
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              src={lb}
              alt=""
              className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
              onClick={e => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
