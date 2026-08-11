// Certificate bulk ZIP packaging (GA-4 S2). Server-only.
//
// REUSES the existing Print Package ZIP engine primitives — buildStoredZip (shared
// with the print packager + XLSX writer) and the certificate SSRF url-guard — to
// bundle certificate PDFs into ONE ZIP. No second ZIP system is introduced.
//
// Entry sources are MIXED, because generated PDFs are no longer stored:
//   • legacy certificates (fileUrl set)  → read the stored file back, as before
//   • current certificates (fileUrl null)→ render on demand via renderCertificateOnDemand
// Nothing is ever uploaded here. Memory stays bounded by FETCH_CONCURRENCY in the
// streaming path — at most that many PDFs resident at once, never the whole archive.

import { buildStoredZip, streamStoredZip, type ZipEntry } from '@/lib/zip/store'
import { safeFetchBytes, validateGeneratedCertificateUrl } from './urlGuard'
import { renderCertificateOnDemand } from './generate'
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

  if (typeof c.fileUrl === 'string' && c.fileUrl) {
    const check = validateGeneratedCertificateUrl(c.fileUrl)
    if (!check.ok) return null
    const bytes = await safeFetchBytes(c.fileUrl, check, { maxBytes: MAX_FILE_BYTES }).catch(() => null)
    return bytes ? { name, data: Buffer.from(bytes) } : null
  }

  // On-demand: the SAME renderer the individual download uses, so a ZIP entry and a
  // single download of the same certificate are byte-identical. Nothing is uploaded.
  const rendered = await renderCertificateOnDemand(c.certificateId).catch(() => null)
  if (!rendered || !rendered.ok) return null
  return { name, data: Buffer.from(rendered.bytes) }
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
