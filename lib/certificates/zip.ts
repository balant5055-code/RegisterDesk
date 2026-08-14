// Certificate bulk ZIP packaging (GA-4 S2). Server-only.
//
// REUSES the existing Print Package ZIP engine primitives — buildStoredZip (shared
// with the print packager + XLSX writer) and the certificate SSRF url-guard — to
// bundle certificate PDFs into ONE ZIP. No second ZIP system is introduced.
//
// Entry sources are MIXED, in strict preference order:
//   • fileKey set (current)  → read the CANONICAL persisted artifact from object storage
//   • fileUrl set (legacy)   → read the stored Firebase file back, SSRF-guarded, as before
//   • neither (legacy/MVP)   → render on demand via renderCertificateOnDemand
// Nothing is ever uploaded from buildEntry. Memory stays bounded — by FETCH_CONCURRENCY in
// the streaming path, and by BYTES in buildZipShard, which is what the async job uses.

import { buildStoredZip, streamStoredZip, type ZipEntry } from '@/lib/zip/store'
import { safeFetchBytes, validateGeneratedCertificateUrl } from './urlGuard'
import { renderCertificateOnDemand } from './generate'
import { storage } from '@/features/platform-storage'
import { ZIP_INFLIGHT_MAX_BYTES, ZIP_SHARD_MAX_FILES, ZIP_SHARD_MAX_BYTES } from './constants'
import type { Certificate } from './types'

// Synchronous-ZIP ceiling. The route rejects selections above this with a clear
// error (GA-5 S2) rather than silently truncating; narrow the scope to stay under it.
export const CERTIFICATE_ZIP_MAX_FILES = 5000
const MAX_FILES        = CERTIFICATE_ZIP_MAX_FILES
const MAX_FILE_BYTES   = 25 * 1024 * 1024     // per-PDF read cap
const FETCH_CONCURRENCY = 8

export interface CertificateZipResult {
  zip:       Uint8Array
  fileCount: number
  missing:   number         // selected certs whose stored PDF couldn't be read
  skipped:   number         // selected certs beyond the MAX_FILES ceiling
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function safeName(raw: string): string {
  return (raw || 'certificate').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}

/**
 * Selection = non-revoked certs, capped at MAX_FILES. `skipped` = eligible certs beyond
 * the cap. Computed WITHOUT fetching or rendering, so the route can set response headers
 * upfront and reject an oversized selection before any work is done.
 */
export function selectZipCertificates(certs: Certificate[]): { usable: Certificate[]; skipped: number } {
  const eligible = certs.filter(c => c.status !== 'revoked')
  // A stored file is NO LONGER required. Generated PDFs are not persisted any more, so
  // every newly issued certificate has fileUrl=null and would previously have been
  // filtered out here — emptying the archive and 409-ing the route. Eligibility is now
  // exactly "not revoked", and the only `skipped` are those past the synchronous ceiling.
  const usable = eligible.slice(0, MAX_FILES)
  return { usable, skipped: eligible.length - usable.length }
}

/**
 * One archive entry. Two sources, one output shape:
 *   • fileUrl set (legacy)  → read the stored PDF back, SSRF-guarded, exactly as before.
 *   • fileUrl null (current)→ render on demand from the certificate's `data` snapshot.
 *
 * Legacy records deliberately keep the cheap stored read rather than re-rendering: the
 * bytes already exist, and re-rendering them would cost ~500ms each for no benefit.
 *
 * Returns null on any failure — non-fatal by contract, the entry is simply omitted and
 * counted as `missing`, so one unreadable certificate cannot fail the whole archive.
 */
async function buildEntry(c: Certificate): Promise<ZipEntry | null> {
  const name = `${safeName(c.attendeeName)}-${c.certificateId}.pdf`

  // RD-CERT-ARTIFACT-01 — the canonical persisted artifact, and the reason a bulk archive
  // is now an I/O problem rather than a rendering one: a stored read is milliseconds where
  // a re-render is ~155 ms of CPU that does not parallelise.
  if (typeof c.fileKey === 'string' && c.fileKey) {
    const got = await storage.download(c.fileKey).catch(() => null)
    if (got) return { name, data: Buffer.from(got.body) }
    // Object missing despite a key — fall through and re-render rather than drop a
    // certificate the caller explicitly asked for.
  }

  if (typeof c.fileUrl === 'string' && c.fileUrl) {
    const check = validateGeneratedCertificateUrl(c.fileUrl)
    if (!check.ok) return null
    const bytes = await safeFetchBytes(c.fileUrl, check, { maxBytes: MAX_FILE_BYTES }).catch(() => null)
    return bytes ? { name, data: Buffer.from(bytes) } : null
  }

  // Last resort — a legacy record with no artifact at all. The SAME renderer the individual
  // download uses, so a ZIP entry and a single download are byte-identical.
  const rendered = await renderCertificateOnDemand(c.certificateId).catch(() => null)
  if (!rendered || !rendered.ok) return null
  return { name, data: Buffer.from(rendered.bytes) }
}

// ─── RD-CERT-ARTIFACT-01 · shard building for the ASYNC bulk-ZIP job ──────────

export interface ZipShardResult {
  /** The finished shard archive. */
  zip:        Uint8Array
  /** certificateIds actually inside `zip`, in archive order. */
  includedIds: string[]
  /** certificateIds that were requested for this shard but could not be read. */
  failedIds:   string[]
  /** Uncompressed payload bytes, for the caller's budget accounting. */
  bytes:       number
}

/**
 * Builds ONE self-contained shard archive from an already-sized slice of certificates.
 *
 * ═══ WHY SHARDS, NOT ONE STREAMED ARCHIVE ══════════════════════════════════
 * A synchronous 10,000-file archive cannot be made reliable: the response commits its
 * status and headers before the first entry is written, so a timeout mid-stream yields a
 * TRUNCATED zip that the browser reports as a successful download. A shard is atomic —
 * it is uploaded whole or not at all — independently retryable, and bounded in memory.
 *
 * ═══ MEMORY IS BOUNDED BY BYTES, NOT BY FILE COUNT ═════════════════════════
 * Certificate PDFs are not a fixed size; this asset type permits up to 25 MB. Admitting a
 * fixed NUMBER of concurrent fetches would mean anywhere from a few hundred KB to hundreds
 * of MB in flight. Instead a fetch is admitted only while the in-flight payload is under
 * ZIP_INFLIGHT_MAX_BYTES, so an oversized artifact simply runs with less company.
 *
 * ═══ NOTHING DISAPPEARS ════════════════════════════════════════════════════
 * Every requested id lands in `includedIds` or `failedIds`. The two together always equal
 * the input set, which is what lets the job's manifest be honest instead of silently short.
 */
/**
 * How many certificates go in the NEXT shard, bounded by BOTH file count and byte size.
 *
 * Pure — no I/O, no Firestore — so the job's cursor arithmetic can be reasoned about (and
 * tested for gap/duplicate freedom across interruptions) without a database.
 *
 * The byte bound is not optional. `event-certificate` permits artifacts up to 25 MB, so a
 * count-only rule could ask for 500 × 25 MB = 12.5 GB in a single shard. `fileSize` is on
 * the record for persisted artifacts; legacy records without one are charged a
 * conservative estimate, so an unknown size can never be treated as free.
 */
const UNKNOWN_SIZE_ESTIMATE = 2 * 1024 * 1024

export function planShard(certs: Certificate[], start: number): Certificate[] {
  const out: Certificate[] = []
  let bytes = 0
  for (let i = start; i < certs.length && out.length < ZIP_SHARD_MAX_FILES; i++) {
    const size = typeof certs[i].fileSize === 'number' && certs[i].fileSize! > 0
      ? certs[i].fileSize!
      : UNKNOWN_SIZE_ESTIMATE
    // Always take at least one: an artifact larger than the whole shard budget must get a
    // shard to itself, or the job would stall forever planning an empty slice.
    if (out.length > 0 && bytes + size > ZIP_SHARD_MAX_BYTES) break
    out.push(certs[i])
    bytes += size
  }
  return out
}

export async function buildZipShard(certs: Certificate[]): Promise<ZipShardResult> {
  const seen        = new Set<string>()
  const entries: ZipEntry[] = []
  const includedIds: string[] = []
  const failedIds:   string[] = []
  let   bytes = 0

  let cursor   = 0
  let inFlight = 0

  // Bounded-by-bytes worker pool. Each worker claims the next certificate, waits until the
  // in-flight budget can accommodate a worst-case artifact, then fetches.
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++
      if (idx >= certs.length) return
      const c = certs[idx]

      // Reserve pessimistically (we cannot know the size before reading); release the
      // difference once the real size is known.
      while (inFlight > 0 && inFlight + MAX_FILE_BYTES > ZIP_INFLIGHT_MAX_BYTES) {
        await new Promise(r => setTimeout(r, 5))
      }
      inFlight += MAX_FILE_BYTES

      try {
        const entry = await buildEntry(c).catch(() => null)
        if (!entry) { failedIds.push(c.certificateId); continue }
        entries.push({ name: dedupeName(entry.name, seen, entries.length), data: entry.data })
        includedIds.push(c.certificateId)
        bytes += entry.data.byteLength
      } finally {
        inFlight -= MAX_FILE_BYTES
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, certs.length) }, worker))

  return { zip: await buildStoredZip(entries), includedIds, failedIds, bytes }
}

// Dedupe a candidate archive name against those already emitted.
function dedupeName(name: string, seen: Set<string>, index: number): string {
  const unique = seen.has(name) ? name.replace(/(\.pdf)?$/i, `-${index}.pdf`) : name
  seen.add(unique)
  return unique
}

/**
 * GA-7C P1-2: streams a ZIP of the given certificates' stored PDFs with BOUNDED
 * memory. PDFs are fetched in concurrency-limited batches and piped straight into
 * the streaming STORED-zip writer, so at most FETCH_CONCURRENCY PDFs are resident at
 * once — never the whole archive (the former buildCertificatesZip buffered every PDF
 * plus a full concat copy → multi-GB peak at the 5000-file cap). Pass the already-
 * selected `usable` list from selectZipCertificates. Per-file read failures are
 * skipped (non-fatal), exactly as before.
 */
export function streamCertificatesZip(usable: Certificate[]): ReadableStream<Uint8Array> {
  async function* entries(): AsyncGenerator<ZipEntry> {
    const seen = new Set<string>()
    let emitted = 0
    for (let i = 0; i < usable.length; i += FETCH_CONCURRENCY) {
      const fetched = await Promise.all(usable.slice(i, i + FETCH_CONCURRENCY).map(buildEntry))
      for (const r of fetched) {
        if (!r) continue
        yield { name: dedupeName(r.name, seen, emitted++), data: r.data }
      }
    }
  }
  return streamStoredZip(entries())
}

/**
 * Buffered variant (retained for backward compatibility / small selections and
 * non-streaming callers). Shares the selection + fetch logic with the streaming
 * path. NOTE: holds every PDF in memory — the download route uses the streaming
 * path instead for large selections.
 */
export async function buildCertificatesZip(certs: Certificate[]): Promise<CertificateZipResult> {
  const { usable, skipped } = selectZipCertificates(certs)
  const results = await mapLimit(usable, FETCH_CONCURRENCY, buildEntry)

  const seen = new Set<string>()
  const entries: ZipEntry[] = []
  let missing = 0
  for (const r of results) {
    if (!r) { missing++; continue }
    entries.push({ name: dedupeName(r.name, seen, entries.length), data: r.data })
  }

  return { zip: buildStoredZip(entries), fileCount: entries.length, missing, skipped }
}
