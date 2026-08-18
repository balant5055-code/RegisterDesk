// RD-EVENT-DELETE · the wording shown before an event is permanently deleted. PURE.
//
// Two surfaces can start this: the event detail page (EventActionsPanel) and the Archived
// tab's card menu (EventsClient). They use different confirmation primitives — a local
// ConfirmModal and the shared useConfirm() hook — but the PROMISE made to the operator has
// to be identical, because it is the only place the retention rule is stated.
//
// Keeping the sentence here means the two cannot drift: an edit reaches both, and a test can
// assert one string rather than hoping two copies stayed in sync. Client-safe by design — no
// Firestore, no server imports — so a client component can import it without pulling the
// Admin SDK into the bundle.

export const PERMANENT_DELETE_TITLE = 'Delete Permanently'

/**
 * States all three things the operator needs before an irreversible action: what goes, that
 * it cannot be undone, and — the part that surprises people — what deliberately stays.
 */
export const PERMANENT_DELETE_DESCRIPTION =
  'This permanently deletes the archived event and its event-specific operational data. This cannot be undone. Financial and audit records are retained.'
