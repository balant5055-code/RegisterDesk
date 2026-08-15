// RD-CERT-EMAIL-BULK · persistence for asynchronous certificate EMAIL DELIVERY jobs.
// Server-only.
//
// Deliberately SEPARATE from emailJobs.ts, which owns the processing strategy and therefore
// transitively imports the email engine and the storage client. The create/poll routes need
// only to write and read a job document and should not drag those into their module graph —
// the same split zipJobsStore.ts makes for the ZIP jobs.
//
// Storage is the SHARED job kernel: same leasing, fencing, cursor and counts as bulk
// generation and bulk ZIP. No second job system is introduced.

import * as jobKernel from '@/lib/jobs/kernel'
import { adminDb } from '@/lib/firebase/admin'
import { generateJobId } from './id'
import { COLLECTIONS } from './constants'
import { CERTIFICATE_SCHEMA_VERSION } from './types'
import type { CertificateEmailJob, CertificateEmailJobInput } from './types'

export async function createEmailJob(
  input: CertificateEmailJobInput,
  total: number,
): Promise<CertificateEmailJob> {
  return jobKernel.createJob<CertificateEmailJob>(
    COLLECTIONS.EMAIL_JOBS,
    generateJobId(),
    {
      ...input,
      needsReview:   0,
      schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    },
    total,
  )
}

export async function getEmailJob(jobId: string): Promise<CertificateEmailJob | null> {
  return jobKernel.getJob<CertificateEmailJob>(COLLECTIONS.EMAIL_JOBS, jobId)
}

export async function listActiveEmailJobs(limitN = 25): Promise<CertificateEmailJob[]> {
  return jobKernel.listActiveJobs<CertificateEmailJob>(COLLECTIONS.EMAIL_JOBS, limitN)
}

/**
 * Delivery history for one event, newest first.
 *
 * Same shape as listJobs (generation), so it is served by an equivalent
 * (organizerUid, eventId, createdAt) index and needs no new query pattern. Bounded because
 * history is a UI list, not a dataset.
 */
export async function listEmailJobs(
  eventId: string,
  organizerUid: string,
  limitN = 20,
): Promise<CertificateEmailJob[]> {
  const snap = await adminDb.collection(COLLECTIONS.EMAIL_JOBS)
    .where('organizerUid', '==', organizerUid)
    .where('eventId',      '==', eventId)
    .orderBy('createdAt', 'desc')
    .limit(limitN)
    .get()
  return snap.docs.map(d => d.data() as CertificateEmailJob)
}
