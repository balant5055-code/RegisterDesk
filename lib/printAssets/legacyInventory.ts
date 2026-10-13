// RD-PRINT-P0 · READ-ONLY inventory of the print output that was stored before
// on-demand rendering. Server-only.
//
// Before RD-PRINT-P0, generation uploaded one PDF per registration to
// `printAssets/{owner}/{job}/{reg}.pdf` and packaging uploaded ZIPs to
// `printPackages/{owner}/{job}/…`, each with a PERMANENT download-token URL saved on the
// Firestore record. The app no longer writes or reads either prefix. This module
// MEASURES what is left so a deletion can be reviewed — it never deletes, rewrites or
// downloads anything:
//   • Storage: `getFiles` listing only (names + metadata). No object body is read.
//   • Firestore: `count()` aggregations and `select()`-ed field reads only.
//
// Its output is COUNTS and BYTES only: no object paths (they embed workspace uids and
// registration ids), no URLs, no download tokens, no attendee data.

import { getStorage } from 'firebase-admin/storage'
import { adminApp, adminDb } from '@/lib/firebase/admin'
import { FIREBASE_STORAGE_BUCKET } from '@/lib/env'

export const LEGACY_PRINT_PREFIXES = ['printAssets/', 'printPackages/'] as const
const LIST_PAGE = 1000

export interface PrefixInventory {
  prefix:              string
  objects:             number
  totalBytes:          number
  /** Objects carrying a `firebaseStorageDownloadTokens` capability (token NOT reported). */
  withDownloadToken:   number
  /** Objects some Firestore print record still references (by stored path). */
  referencedByRecords: number
  /** Objects no print record references. */
  unreferenced:        number
  oldestCreated:       string | null
  newestCreated:       string | null
}

export interface PrintLegacyInventory {
  bucket:  string
  storage: PrefixInventory[]
  generationJobs: {
    total:    number
    byStatus: Record<string, number>
    items: {
      total:                  number
      /** Items with a stored legacy `output` (path + permanent token URL). */
      withLegacyOutput:       number
      /** Of those, past their recorded 24 h `expiresAt` (the token URL still works). */
      legacyOutputExpired:    number
      /** Items still carrying a legacy attendee copy (name/contact/ticket/QR/form answers). */
      withLegacyAttendeeCopy: number
    }
  }
  packageJobs: {
    total:            number
    byStatus:         Record<string, number>
    withLegacyOutput: number
  }
  /** Facts that decide whether deleting the objects is safe (see the cleanup plan). */
  safety: {
    appReadsStoredObjects:  false
    appWritesStoredObjects: false
    recordsReferencingObjects: number
  }
}

const tsMillis = (v: unknown): number =>
  v && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis(): number }).toMillis() : 0

async function inventoryPrefix(prefix: string, referenced: Set<string>): Promise<PrefixInventory> {
  const bucket = getStorage(adminApp).bucket(FIREBASE_STORAGE_BUCKET)
  const inv: PrefixInventory = {
    prefix, objects: 0, totalBytes: 0, withDownloadToken: 0,
    referencedByRecords: 0, unreferenced: 0, oldestCreated: null, newestCreated: null,
  }
  let pageToken: string | undefined
  do {
    const [files, next] = await bucket.getFiles({ prefix, maxResults: LIST_PAGE, autoPaginate: false, pageToken })
    for (const f of files) {
      const md = (f.metadata ?? {}) as { size?: string | number; timeCreated?: string; metadata?: Record<string, unknown> }
      inv.objects++
      inv.totalBytes += Number(md.size ?? 0) || 0
      if (md.metadata && typeof md.metadata.firebaseStorageDownloadTokens === 'string' && md.metadata.firebaseStorageDownloadTokens) {
        inv.withDownloadToken++
      }
      if (referenced.has(f.name)) inv.referencedByRecords++; else inv.unreferenced++
      if (md.timeCreated) {
        if (!inv.oldestCreated || md.timeCreated < inv.oldestCreated) inv.oldestCreated = md.timeCreated
        if (!inv.newestCreated || md.timeCreated > inv.newestCreated) inv.newestCreated = md.timeCreated
      }
    }
    pageToken = (next as { pageToken?: string } | null)?.pageToken
  } while (pageToken)
  return inv
}

const tally = (m: Record<string, number>, k: unknown) => { const key = typeof k === 'string' ? k : 'unknown'; m[key] = (m[key] ?? 0) + 1 }

/** The read-only inventory. Never writes; reports counts and bytes only. */
export async function inventoryLegacyPrintOutputs(now = Date.now()): Promise<PrintLegacyInventory> {
  const referenced = new Set<string>()

  // ── Generation jobs + their items ──
  const gen = { total: 0, byStatus: {} as Record<string, number>, items: { total: 0, withLegacyOutput: 0, legacyOutputExpired: 0, withLegacyAttendeeCopy: 0 } }
  for (const job of (await adminDb.collection('printGenerationJobs').select('status').get()).docs) {
    gen.total++
    tally(gen.byStatus, job.get('status'))
    const items = job.ref.collection('items')
    gen.items.total += (await items.count().get()).data().count
    // `!=` excludes documents where the field is missing, so these count presence.
    gen.items.withLegacyAttendeeCopy += (await items.where('email', '!=', null).count().get()).data().count
    const withOutput = await items.where('output.path', '!=', null).select('output.path', 'output.expiresAt').get()
    for (const it of withOutput.docs) {
      gen.items.withLegacyOutput++
      const path = it.get('output.path')
      if (typeof path === 'string') referenced.add(path)
      const exp = tsMillis(it.get('output.expiresAt'))
      if (exp && exp < now) gen.items.legacyOutputExpired++
    }
  }

  // ── Package jobs ──
  const pkg = { total: 0, byStatus: {} as Record<string, number>, withLegacyOutput: 0 }
  for (const job of (await adminDb.collection('printPackageJobs').select('status', 'output.path').get()).docs) {
    pkg.total++
    tally(pkg.byStatus, job.get('status'))
    const path = job.get('output.path')
    if (typeof path === 'string' && path) { pkg.withLegacyOutput++; referenced.add(path) }
  }

  const storage: PrefixInventory[] = []
  for (const prefix of LEGACY_PRINT_PREFIXES) storage.push(await inventoryPrefix(prefix, referenced))

  return {
    bucket: FIREBASE_STORAGE_BUCKET ?? '',
    storage,
    generationJobs: gen,
    packageJobs: pkg,
    safety: {
      appReadsStoredObjects:  false,
      appWritesStoredObjects: false,
      recordsReferencingObjects: gen.items.withLegacyOutput + pkg.withLegacyOutput,
    },
  }
}
