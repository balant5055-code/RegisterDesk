'use client'

// RD-PHOTO-03 · Getting the overlay ready for an import run.
//
// ═══ ONCE PER BATCH ═══════════════════════════════════════════════════════════
// Called exactly once before an import starts, never per photo. Importing 4,000 photos
// fetches and decodes the artwork ONCE and draws that one bitmap 12,000 times (three
// renditions each) — which is why `PreparedOverlay` carries a decoded bitmap rather than
// bytes or a URL.
//
// ═══ WHY A SAME-ORIGIN ROUTE, NOT THE STORAGE URL ═════════════════════════════
// Reading pixels into a canvas is a cross-origin read. RD-PHOTO-02 fetched the artwork
// straight from object storage, which made the entire feature depend on bucket CORS being
// configured — and when it was not, branding silently did nothing.
//
// That was survivable when branding happened at download time (the visitor still got their
// photo). It is NOT survivable now: a silent failure here would permanently store thousands
// of unbranded photos. So the bytes come from OUR origin, through an authenticated route,
// and the failure is loud.
// ══════════════════════════════════════════════════════════════════════════════

import type { PreparedOverlay } from '@/features/media-studio/utils/browserImage'
import type { BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'

export const ARTWORK_ENDPOINT = '/api/organizer/media-studio/branding/artwork'

export interface OverlayHandle {
  overlay: PreparedOverlay
  /** Frees the bitmap. Must be called when the run finishes, whatever the outcome. */
  release: () => void
}

/**
 * Fetches and decodes the event's artwork.
 *
 * FAIL-CLOSED — this throws rather than resolving to null. An import that cannot brand must
 * not proceed and store unbranded photos that no later action can fix; refusing to start is
 * recoverable, a half-branded gallery is not.
 */
export async function prepareOverlay(params: {
  eventId: string
  style:   BrandingStyle
  token:   string
  signal?: AbortSignal
}): Promise<OverlayHandle> {
  const res = await fetch(
    `${ARTWORK_ENDPOINT}?eventId=${encodeURIComponent(params.eventId)}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      cache:   'no-store',
      signal:  params.signal,
    },
  )
  if (!res.ok) {
    throw new Error('The event branding could not be loaded, so the import was not started.')
  }

  const blob = await res.blob()
  const { image, width, height } = await decodeOverlay(blob)

  if (width <= 0 || height <= 0) {
    releaseImage(image)
    throw new Error('The event branding artwork could not be read as an image.')
  }

  return {
    overlay: { image, width, height, style: params.style },
    release: () => releaseImage(image),
  }
}

async function decodeOverlay(
  blob: Blob,
): Promise<{ image: ImageBitmap | HTMLImageElement; width: number; height: number }> {
  // `createImageBitmap` decodes off the main thread and preserves the PNG's alpha, which is
  // the whole point of a transparent overlay.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return { image: bitmap, width: bitmap.width, height: bitmap.height }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('The event branding artwork could not be read as an image.'))
    }
    img.src = url
  })
}

function releaseImage(image: ImageBitmap | HTMLImageElement): void {
  // ImageBitmaps hold native memory that GC does not reclaim promptly — the same discipline
  // `processImage` applies to each photo.
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close()
}
