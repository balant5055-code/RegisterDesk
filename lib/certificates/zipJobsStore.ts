// RD-CERT-ARTIFACT-01 · persistence for asynchronous bulk-ZIP jobs. Server-only.
//
// Deliberately SEPARATE from zipJobs.ts, which owns the processing strategy and therefore
// transitively imports the renderer and the ZIP engine. The create/poll routes need only
// to write and read a job document, and should not drag pdf-lib into their module graph.
//
// Storage is the SHARED job kernel — same leasing, fencing, cursor and counts as bulk
// certificate generation. No second job system is introduced.

import * as jobKernel from '@/lib/jobs/kernel'
import { generateJobId } from './id'
import { COLLECTIONS } from './constants'
import { CERTIFICATE_SCHEMA_VERSION } from './types'
import type { CertificateZipJob } from './zipJobs'

export interface ZipJobInput {
  organizerUid:   string
  createdBy:      string
  eventId:        string
  eventSlug:      string
  scope:          'all' | 'job' | 'selected'
  sourceJobId:    string | null
  certificateIds: string[] | null
}

export async function createZipJob(input: ZipJobInput, total: number): Promise<CertificateZipJob> {
  return jobKernel.createJob<CertificateZipJob>(
    COLLECTIONS.ZIP_JOBS,
    generateJobId(),
    {
      ...input,
      // Seeded EMPTY so every later write is an arrayUnion append — a shard record can
      // never overwrite a sibling written by a concurrent or retried chunk.
      shards:        [],
      failedIds:     [],
      manifestKey:   null,
      schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    },
    total,
  )
}

export async function getZipJob(jobId: string): Promise<CertificateZipJob | null> {
  return jobKernel.getJob<CertificateZipJob>(COLLECTIONS.ZIP_JOBS, jobId)
}

export async function listActiveZipJobs(limitN = 25): Promise<CertificateZipJob[]> {
  return jobKernel.listActiveJobs<CertificateZipJob>(COLLECTIONS.ZIP_JOBS, limitN)
}
