// Certificate Firestore operations — server-only.
// All reads and writes go through adminDb (Firebase Admin SDK).

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import type {
  CertificateTemplate,
  CertificateRecord,
  CertificateTemplateInput,
} from './types'

// ─── Template ─────────────────────────────────────────────────────────────────

/** Load the certificate template for an event. Returns null if not configured. */
export async function getTemplate(eventId: string): Promise<CertificateTemplate | null> {
  const snap = await adminDb.collection('certificateTemplates').doc(eventId).get()
  return snap.exists ? (snap.data() as CertificateTemplate) : null
}

/**
 * Create-or-update the certificate template for an event.
 * Only the organizer (createdBy) may save — ownership is enforced by the
 * API route, not here.
 */
export async function saveTemplate(
  eventId: string,
  input:   CertificateTemplateInput,
  uid:     string,
): Promise<void> {
  const ref    = adminDb.collection('certificateTemplates').doc(eventId)
  const exists = (await ref.get()).exists

  if (exists) {
    await ref.update({ ...input, updatedAt: FieldValue.serverTimestamp() })
  } else {
    await ref.set({
      ...input,
      eventId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    })
  }
}

// ─── Records ─────────────────────────────────────────────────────────────────

/** Load a certificate record by its public certificateId. */
export async function getCertificateById(
  certificateId: string,
): Promise<CertificateRecord | null> {
  const snap = await adminDb.collection('certificateRecords').doc(certificateId).get()
  return snap.exists ? (snap.data() as CertificateRecord) : null
}

/** Find the certificate for a specific registration (at most one). */
export async function getCertificateByRegistrationId(
  registrationId: string,
): Promise<CertificateRecord | null> {
  const snap = await adminDb
    .collection('certificateRecords')
    .where('registrationId', '==', registrationId)
    .limit(1)
    .get()
  return snap.empty ? null : (snap.docs[0].data() as CertificateRecord)
}

/** Create a new certificate record. Keyed by certificateId. */
export async function createCertificateRecord(
  record: Omit<CertificateRecord, 'issuedAt' | 'downloadCount' | 'status'>,
): Promise<void> {
  await adminDb.collection('certificateRecords').doc(record.certificateId).set({
    ...record,
    status:        'generated',
    downloadCount:  0,
    issuedAt:       FieldValue.serverTimestamp(),
  })
}

/** Atomically increment download counter. */
export async function incrementDownloadCount(certificateId: string): Promise<void> {
  await adminDb
    .collection('certificateRecords')
    .doc(certificateId)
    .update({ downloadCount: FieldValue.increment(1) })
}

/** Mark a certificate as emailed. */
export async function markCertificateEmailed(
  certificateId: string,
  success:       boolean,
): Promise<void> {
  await adminDb.collection('certificateRecords').doc(certificateId).update({
    status:      'emailed',
    emailStatus: success ? 'sent' : 'failed',
    emailedAt:   FieldValue.serverTimestamp(),
  })
}

/** All certificates for a specific event (organizer-scoped). */
export async function getCertificatesByEventId(
  eventId:     string,
  organizerUid: string,
): Promise<CertificateRecord[]> {
  const snap = await adminDb
    .collection('certificateRecords')
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .get()
  return snap.docs.map(d => d.data() as CertificateRecord)
}

/** All certificates for an organizer (across all events), newest first in memory. */
export async function getCertificatesByOrganizerUid(
  organizerUid: string,
  limitN = 100,
): Promise<CertificateRecord[]> {
  const snap = await adminDb
    .collection('certificateRecords')
    .where('organizerUid', '==', organizerUid)
    .limit(limitN)
    .get()
  return snap.docs.map(d => d.data() as CertificateRecord)
}
