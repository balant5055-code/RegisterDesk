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
import { X, Download, ChevronLeft, ChevronRight } from 'lucide-react'

export interface ImageLightboxProps {
  open:          boolean
  src:           string
  alt?:          string
  onClose:       () => void
  downloadHref?: string
  downloadName?: string
  /**
   * RD-MEDIA-10 — optional sequence navigation.
   *
   * Supply both to get arrows, ←/→ keys and a counter. Supply neither (the Event Details
   * case) and the viewer behaves exactly as it did before they existed.
   */
  onPrev?:       () => void
  onNext?:       () => void
  /** 1-based position, shown only when a total is also given. */
  index?:        number
  total?:        number
  /**
   * RD-MEDIA-11 — take over the download control.
   *
   * Supplied, the button calls this instead of being an anchor. The public gallery needs
   * that because its download route 302s to another origin, where the `download` attribute
   * is ignored and the browser navigates to the image instead of saving it.
   *
   * Absent (every Event Details call site), the anchor renders exactly as before.
   */
  onDownload?:   () => void
}

export function ImageLightbox({
  open, src, alt = '', onClose, downloadHref, downloadName,
  onPrev, onNext, index, total, onDownload,
}: ImageLightboxProps) {
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
      // Only bound when a caller supplied navigation — a single-image viewer must not
      // swallow arrow keys the page may be using.
      else if (e.key === 'ArrowLeft'  && onPrev) { e.preventDefault(); onPrev() }
      else if (e.key === 'ArrowRight' && onNext) { e.preventDefault(); onNext() }
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
  }, [open, onClose, onPrev, onNext])

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
            <div className="flex items-center justify-between gap-1 px-4 py-3">
              <p className="min-w-0 truncate text-[13px] text-white/70">
                {typeof index === 'number' && typeof total === 'number'
                  ? `${index} of ${total}`
                  : ''}
              </p>
              <div className="flex items-center gap-1">
              {downloadHref && (
                onDownload ? (
                  // A button, not an anchor: the caller saves the bytes itself, so there is
                  // no navigation to suppress and nothing opens in a new tab.
                  <button
                    type="button"
                    onClick={onDownload}
                    aria-label="Download image"
                    className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    <Download className="size-5" aria-hidden />
                  </button>
                ) : (
                  <a
                    href={downloadHref} download={downloadName} target="_blank" rel="noopener noreferrer"
                    aria-label="Download image"
                    className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    <Download className="size-5" aria-hidden />
                  </a>
                )
              )}
              <button
                type="button" onClick={onClose} aria-label="Close"
                className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <X className="size-5" aria-hidden />
                </button>
              </div>
            </div>

            {/* image */}
            <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 pb-6 sm:px-14">
              {onPrev && (
                <button
                  type="button" onClick={onPrev} aria-label="Previous image"
                  className="absolute left-1 z-10 flex size-11 items-center justify-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:left-3"
                >
                  <ChevronLeft className="size-6" aria-hidden />
                </button>
              )}
              {onNext && (
                <button
                  type="button" onClick={onNext} aria-label="Next image"
                  className="absolute right-1 z-10 flex size-11 items-center justify-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:right-3"
                >
                  <ChevronRight className="size-6" aria-hidden />
                </button>
              )}
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
