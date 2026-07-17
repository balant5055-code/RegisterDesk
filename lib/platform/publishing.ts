// Server-only: platform publishing mode configuration.
//
// Controls whether a submitted event goes live immediately ('auto_publish') or
// waits for admin approval ('manual_approval'). The value is stored in Firestore
// (platformSettings/publishing) so it is configurable at runtime — it is NOT
// hard-coded. The default is manual_approval (safest: nothing goes live without
// review) and is also the fail-safe when the setting cannot be read.

import { adminDb } from '@/lib/firebase/admin'
import { FieldValue } from 'firebase-admin/firestore'

export type PublishingMode = 'auto_publish' | 'manual_approval'

export const PUBLISHING_MODES: PublishingMode[] = ['auto_publish', 'manual_approval']
export const DEFAULT_PUBLISHING_MODE: PublishingMode = 'manual_approval'

// Target turnaround for reviewing a submitted event, in hours. Informational
// (drives the admin "SLA" display / overdue highlighting), configurable at runtime.
export const DEFAULT_APPROVAL_SLA_HOURS = 24

const PUBLISHING_SETTINGS_DOC = 'platformSettings/publishing'

export interface PublishingSettings {
  mode:      PublishingMode
  slaHours:  number
}

export function isPublishingMode(v: unknown): v is PublishingMode {
  return typeof v === 'string' && (PUBLISHING_MODES as string[]).includes(v)
}

/** Read the full publishing settings. Falls back to defaults on any error. */
export async function getPublishingSettings(): Promise<PublishingSettings> {
  try {
    const snap = await adminDb.doc(PUBLISHING_SETTINGS_DOC).get()
    const d    = snap.data() as { mode?: unknown; slaHours?: unknown } | undefined
    const mode = isPublishingMode(d?.mode) ? d!.mode : DEFAULT_PUBLISHING_MODE
    const slaHours = typeof d?.slaHours === 'number' && d.slaHours > 0 ? d.slaHours : DEFAULT_APPROVAL_SLA_HOURS
    return { mode, slaHours }
  } catch {
    return { mode: DEFAULT_PUBLISHING_MODE, slaHours: DEFAULT_APPROVAL_SLA_HOURS }
  }
}

/** Read the current publishing mode. Falls back to the default (manual_approval). */
export async function getPublishingMode(): Promise<PublishingMode> {
  return (await getPublishingSettings()).mode
}

/** Update the publishing settings (admin only). Only provided fields are changed. */
export async function setPublishingSettings(
  patch: Partial<Pick<PublishingSettings, 'mode' | 'slaHours'>>,
  adminUid: string,
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), updatedBy: adminUid }
  if (patch.mode !== undefined)     update.mode     = patch.mode
  if (patch.slaHours !== undefined) update.slaHours = patch.slaHours
  await adminDb.doc(PUBLISHING_SETTINGS_DOC).set(update, { merge: true })
}

/** Set the publishing mode (admin only). */
export async function setPublishingMode(mode: PublishingMode, adminUid: string): Promise<void> {
  await setPublishingSettings({ mode }, adminUid)
}
