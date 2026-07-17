'use client'

// ImageLightbox — the reusable single-image viewer the project was missing.
//
// The existing lightboxes (GalleryShowcase, SharedGallery) are welded inside full
// gallery sections and can't be reused standalone, so this is the shared primitive:
// a controlled, accessible, dark-backdrop viewer for one image. ESC + click-out close,
// focus is trapped and restored, body scroll is locked, and motion respects
// prefers-reduced-motion. Optional download action in the top bar.

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X, Download } from 'lucide-react'

export interface ImageLightboxProps {
  open:          boolean
  src:           string
  alt?:          string
  onClose:       () => void
  downloadHref?: string
  downloadName?: string
}

export function ImageLightbox({ open, src, alt = '', onClose, downloadHref, downloadName }: ImageLightboxProps) {
  const reduce    = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const t = setTimeout(() => dialogRef.current?.focus(), 0)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'Tab') {
        const f = dialogRef.current?.querySelectorAll<HTMLElement>('button,[href],[tabindex]:not([tabindex="-1"])')
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
      ;(openerRef.current as HTMLElement | null)?.focus?.()
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[120] flex flex-col bg-black/92 backdrop-blur-sm"
          onClick={onClose}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={alt || 'Image viewer'}
            tabIndex={-1}
            className="relative flex h-full flex-col outline-none"
            onClick={e => e.stopPropagation()}
          >
            {/* top bar */}
            <div className="flex items-center justify-end gap-1 px-4 py-3">
              {downloadHref && (
                <a
                  href={downloadHref} download={downloadName} target="_blank" rel="noopener noreferrer"
                  aria-label="Download image"
                  className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <Download className="size-5" aria-hidden />
                </a>
              )}
              <button
                type="button" onClick={onClose} aria-label="Close"
                className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            {/* image */}
            <div className="flex flex-1 items-center justify-center overflow-hidden px-4 pb-6">
              <motion.div
                key={src}
                initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.2 }}
                className="flex max-h-full max-w-full"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" />
              </motion.div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
