// PA-5 — Print asset loader. Server-only.
//
// Mirrors the certificate pipeline's "fetch once, pass a Map<url,bytes>" seam: the
// RENDERER NEVER fetches a URL. Callers resolve each image element's source, fetch
// the bytes here (SSRF-guarded, owner-scoped, download-once), and hand the renderer
// a byte map. Reuses lib/certificates/urlGuard (validateStorageUrl + safeFetchBytes)
// — no new image-loading system.

import { validateStorageUrl, safeFetchBytes } from '@/lib/certificates/urlGuard'
import { resolvePrintText, buildVariableMap, type PrintVariableSources } from './variables'
import type { RenderDocument } from './types'

/** null = fetch was attempted and failed/blocked (don't retry within the cache). */
export type PrintAssetMap = ReadonlyMap<string, Uint8Array | null>

const MAX_IMAGE_BYTES = 5 * 1024 * 1024   // 5 MB per image
const IMAGE_TIMEOUT_MS = 8000

// An organizer may only reference their OWN Storage objects (logos, event assets,
// certificate builder assets). Anything else is refused before fetch.
function ownedByOrganizer(objectPath: string, uid: string): boolean {
  return objectPath.startsWith(`organizer-assets/${uid}/`)
    || objectPath.startsWith(`event-assets/${uid}/`)
    || objectPath.startsWith(`certificates/templates/${uid}/`)
}

/** Resolve every image element's source (`properties.text`) to a URL string. */
export function collectImageSources(document: RenderDocument, map: Map<string, string>): string[] {
  const urls = new Set<string>()
  for (const el of document.elements) {
    if (el.type !== 'image' || el.visible === false) continue
    const src = resolvePrintText(el.properties.text ?? '', map).trim()
    if (src) urls.add(src)
  }
  return [...urls]
}

/**
 * Ensures each URL's bytes are present in `cache` — downloading each unique URL
 * at most once (STEP 7: reuse byte arrays across every registration in a chunk).
 * Only SSRF-validated Storage objects the organizer owns are fetched; anything
 * else caches `null` (the renderer draws nothing for it).
 */
export async function ensurePrintAssets(
  urls: string[], cache: Map<string, Uint8Array | null>, organizerUid: string,
): Promise<void> {
  const pending = urls.filter(u => !cache.has(u))
  await Promise.all(pending.map(async url => {
    const check = validateStorageUrl(url)
    if (!check.ok || !check.objectPath || !ownedByOrganizer(check.objectPath, organizerUid)) {
      cache.set(url, null); return
    }
    const bytes = await safeFetchBytes(url, check, { timeoutMs: IMAGE_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES }).catch(() => null)
    cache.set(url, bytes)
  }))
}

/** Convenience for single renders (preview): resolves + fetches into a fresh cache. */
export async function loadPrintAssets(
  document: RenderDocument, sources: PrintVariableSources, organizerUid: string,
): Promise<Map<string, Uint8Array | null>> {
  const map   = buildVariableMap(sources)
  const cache = new Map<string, Uint8Array | null>()
  await ensurePrintAssets(collectImageSources(document, map), cache, organizerUid)
  return cache
}
