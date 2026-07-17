// Server-only helpers for writing to the emailLogs collection.
// Never import from client components.

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import type { WriteEmailLogInput, EmailLogStatus } from './types'

const COLLECTION = 'emailLogs'

/**
 * Creates a new emailLogs document.
 * Returns the document ID so callers can update it later (e.g. on retry).
 * Never throws — failures are swallowed to avoid breaking the primary flow.
 */
export async function writeEmailLog(input: WriteEmailLogInput): Promise<string> {
  try {
    const now = FieldValue.serverTimestamp()
    const ref = adminDb.collection(COLLECTION).doc()
    // LS2.1: NEVER write undefined — the Admin SDK rejects undefined values and
    // the throw was being swallowed, silently dropping failed/skipped log rows.
    // Omit any undefined key (providerMessageId, providerResponse, error, …).
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) clean[k] = v
    }
    await ref.set({ ...clean, createdAt: now, updatedAt: now })
    return ref.id
  } catch (err) {
    console.error('[emailLogs] write failed:', err)
    return ''
  }
}

/**
 * Updates status (and optionally providerMessageId / error) on an existing log doc.
 * Call after a retry succeeds or fails.
 * Never throws.
 */
export async function updateEmailLog(
  logId:    string,
  status:   EmailLogStatus,
  opts?: { providerMessageId?: string; error?: string },
): Promise<void> {
  if (!logId) return
  try {
    await adminDb.collection(COLLECTION).doc(logId).update({
      status,
      ...(opts?.providerMessageId ? { providerMessageId: opts.providerMessageId } : {}),
      ...(opts?.error             ? { error:             opts.error             } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    console.error('[emailLogs] update failed:', err)
  }
}
