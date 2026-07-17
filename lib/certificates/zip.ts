// Certificate bulk ZIP packaging (GA-4 S2). Server-only.
//
// REUSES the existing Print Package ZIP engine primitives — buildStoredZip (shared
// with the print packager + XLSX writer) and the certificate SSRF url-guard — to
// bundle already-generated certificate PDFs into ONE ZIP. It NEVER re-renders: it
// reads the stored files back from Storage (owner-scoped) and archives them, exactly
// like lib/printAssets/packageJob.ts. No second ZIP system is introduced.

import { buildStoredZip, streamStoredZip, type ZipEntry } from '@/lib/zip/store'
import { safeFetchBytes, validateGeneratedCertificateUrl } from './urlGuard'
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
  skipped:   number         // selected certs with no stored file (legacy/revoked)
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
 * Selection = non-revoked certs that actually have a stored file, capped at
 * MAX_FILES. `skipped` = eligible certs with no stored file (legacy on-demand
 * records). Computed WITHOUT fetching, so callers can set response headers upfront.
 */
export function selectZipCertificates(certs: Certificate[]): { usable: Certificate[]; skipped: number } {
  const eligible = certs.filter(c => c.status !== 'revoked')
  const usable   = eligible.filter(c => typeof c.fileUrl === 'string' && c.fileUrl).slice(0, MAX_FILES)
  return { usable, skipped: eligible.length - usable.length }
}

// Fetch one certificate's stored PDF (SSRF-guarded). Returns null on a read failure
// or a URL that fails validation — non-fatal, the entry is simply omitted.
async function fetchEntry(c: Certificate): Promise<ZipEntry | null> {
  const check = validateGeneratedCertificateUrl(c.fileUrl as string)
  if (!check.ok) return null
  const bytes = await safeFetchBytes(c.fileUrl as string, check, { maxBytes: MAX_FILE_BYTES }).catch(() => null)
  if (!bytes) return null
  return { name: `${safeName(c.attendeeName)}-${c.certificateId}.pdf`, data: Buffer.from(bytes) }
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
      const fetched = await Promise.all(usable.slice(i, i + FETCH_CONCURRENCY).map(fetchEntry))
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
  const results = await mapLimit(usable, FETCH_CONCURRENCY, fetchEntry)

  const seen = new Set<string>()
  const entries: ZipEntry[] = []
  let missing = 0
  for (const r of results) {
    if (!r) { missing++; continue }
    entries.push({ name: dedupeName(r.name, seen, entries.length), data: r.data })
  }

  return { zip: buildStoredZip(entries), fileCount: entries.length, missing, skipped }
}
