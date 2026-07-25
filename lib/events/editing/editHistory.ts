// RD-PRODUCT-01F — enterprise edit history + attendee change-notice preview.
//
// Every post-publish content edit appends an immutable record to
//   events/{slug}/editHistory
// capturing WHO edited, WHEN, WHICH fields, WHY (reason), whether attendees were notified,
// and the before/after values of the changed SAFE fields (so a change can be rolled back).
// This supersedes the minimal write-only `changeLog` (kept intact for backward compat).
//
// The record shape is Firestore-safe (no undefined). The notice-preview builder is PURE.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { emailShell, metaRow } from '@/lib/email/templates/base'
import type { EmailBranding } from '@/lib/email/templates/base'
import type { EventEditPayload } from '@/types/events'

export interface EditHistoryRecord {
  id?:               string
  editedAt:          unknown                 // Firestore Timestamp (serverTimestamp on write)
  editorUid:         string
  editorName:        string
  changedFields:     string[]
  impactfulFields:   string[]
  reason:            string | null
  attendeesNotified: boolean
  isRollback:        boolean
  before:            Partial<EventEditPayload>
  after:             Partial<EventEditPayload>
}

const HISTORY_LIMIT_DEFAULT = 50

/** Append one edit-history record. Best-effort (never blocks the edit); returns the id or null. */
export async function writeEditHistory(
  slug: string,
  record: Omit<EditHistoryRecord, 'editedAt' | 'id'>,
): Promise<string | null> {
  try {
    const ref = await adminDb.collection('events').doc(slug).collection('editHistory').add({
      ...record,
      editedAt: FieldValue.serverTimestamp(),
    })
    return ref.id
  } catch (err) {
    console.error('[editHistory] write failed:', err)
    return null
  }
}

/** Read the most recent edit-history records (newest first). */
export async function loadEditHistory(slug: string, limit = HISTORY_LIMIT_DEFAULT): Promise<EditHistoryRecord[]> {
  try {
    const snap = await adminDb.collection('events').doc(slug)
      .collection('editHistory').orderBy('editedAt', 'desc').limit(limit).get()
    return snap.docs.map(d => {
      const data = d.data() as EditHistoryRecord
      const editedAt = data.editedAt as { toMillis?: () => number } | null
      return { ...data, id: d.id, editedAt: editedAt?.toMillis?.() ?? null }
    })
  } catch (err) {
    console.error('[editHistory] read failed:', err)
    return []
  }
}

/** Fetch one history record by id (for rollback). */
export async function getEditHistoryRecord(slug: string, recordId: string): Promise<EditHistoryRecord | null> {
  try {
    const snap = await adminDb.collection('events').doc(slug).collection('editHistory').doc(recordId).get()
    if (!snap.exists) return null
    return { ...(snap.data() as EditHistoryRecord), id: snap.id }
  } catch (err) {
    console.error('[editHistory] getRecord failed:', err)
    return null
  }
}

// ─── Attendee change-notice preview (PURE) ─────────────────────────────────────────

/** Human labels for the impactful fields, for the notice body. */
const FIELD_LABELS: Record<string, string> = {
  startDate: 'Start date', startTime: 'Start time', endDate: 'End date', endTime: 'End time',
  venueType: 'Venue type', venueName: 'Venue', venueCity: 'City', venueAddress: 'Address',
  onlinePlatform: 'Online platform', onlineMeetingUrl: 'Joining link',
}

export interface ChangeNoticeInput {
  eventName:       string
  impactfulFields: string[]
  after:           Partial<EventEditPayload>
  eventUrl?:       string
  branding?:       EmailBranding
}

export interface ChangeNotice { subject: string; html: string }

/**
 * Build the "your event details have changed" email an organizer can send to registered
 * attendees (Phase 3 preview). PURE — renders through the existing emailShell, no send.
 * The organizer dispatches it via the existing broadcast engine (the billed, audited
 * attendee-messaging path); this only produces the preview content.
 */
export function buildChangeNotice(input: ChangeNoticeInput): ChangeNotice {
  const { eventName, impactfulFields, after } = input
  const rows = impactfulFields
    .map(f => {
      const val = (after as Record<string, unknown>)[f]
      return typeof val === 'string' && val ? metaRow(FIELD_LABELS[f] ?? f, val) : ''
    })
    .filter(Boolean)
    .join('')

  const subject = `Update to ${eventName}`
  const body = `
    <p style="font-size:15px;color:#111827;margin:0 0 6px;">Hello,</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 18px;">
      Some details for <strong>${eventName}</strong>, which you're registered for, have been updated.
      Your registration and ticket remain valid — please note the change${impactfulFields.length > 1 ? 's' : ''} below.
    </p>
    ${rows ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 18px;">${rows}</table>` : ''}
    <p style="font-size:13px;color:#6b7280;line-height:1.6;margin:0;">
      No action is needed — this is a courtesy update. Reach out to the organizer with any questions.
    </p>
  `
  return { subject, html: emailShell(subject, body, undefined, input.branding) }
}
