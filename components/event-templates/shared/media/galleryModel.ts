// Gallery data model — the legacy MediaAsset[] → GalleryItem[] adapter.
//
// RD-ST4.3 (ST41-I01): lifted verbatim out of GalleryShowcase.tsx so SERVER components
// can call it (a function exported from a 'use client' module becomes a client reference
// and throws when invoked on the server). Pure — no JSX, no hooks.

import type { GalleryItem, MediaAsset } from '@/components/wizard/eventDetailsConfig'

export function mediaToGallery(assets: MediaAsset[] | undefined): GalleryItem[] {
  return (assets ?? [])
    .filter(a => a?.value?.trim())
    .map((a, i) => ({ id: `m_${i}`, url: a.value, enabled: true, type: 'image' as const }))
}
