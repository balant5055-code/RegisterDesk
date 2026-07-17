// Cron execution health metrics (Phase G.4). Server-only.
//
// recordCronExecution writes a per-cron health document to operationsMetrics so the
// admin Operations dashboard can show last-success / last-failure / run + failure
// counts. Never throws — monitoring must never break a cron run.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export const OPERATIONS_METRICS = 'operationsMetrics'

export interface CronExecutionInput {
  ok:          boolean
  durationMs?: number
  detail?:     string   // short summary of the run (e.g. JSON of the result)
}

export interface CronMetricDoc {
  cronName:       string
  lastRunAt:      unknown
  lastSuccessAt?: unknown
  lastFailureAt?: unknown
  runCount:       number
  failureCount:   number
  lastOk:         boolean
  lastDurationMs?: number
  lastDetail?:    string
  updatedAt:      unknown
}

/** Records one cron run into operationsMetrics/{cronName}. Fire-and-forget safe. */
export async function recordCronExecution(cronName: string, input: CronExecutionInput): Promise<void> {
  try {
    const now = FieldValue.serverTimestamp()
    const update: Record<string, unknown> = {
      cronName,
      lastRunAt: now,
      runCount:  FieldValue.increment(1),
      lastOk:    input.ok,
      updatedAt: now,
    }
    if (input.durationMs !== undefined) update.lastDurationMs = input.durationMs
    if (input.detail !== undefined)     update.lastDetail = input.detail.slice(0, 500)
    if (input.ok) {
      update.lastSuccessAt = now
    } else {
      update.lastFailureAt = now
      update.failureCount  = FieldValue.increment(1)
    }
    await adminDb.collection(OPERATIONS_METRICS).doc(cronName).set(update, { merge: true })
  } catch (e) {
    console.error('[recordCronExecution] failed (non-fatal):', cronName, e)
  }
}
