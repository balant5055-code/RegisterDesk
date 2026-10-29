// lib/events/editorPath.ts
// RD-REVIEW-03 — the ONE link to an event's editor. PURE (no Firebase), safe on client and server.
//
// A changes-requested event is corrected and resubmitted in the editor: it opens on the Review step,
// shows the Super Admin's exact request and its deadline, and "Submit for review" resubmits through the
// review workflow (POST /api/organizer/events/[eventId]/resubmit). Every surface that asks the
// organizer to act on requested changes — the events card, the Command Center, the dashboard, the
// bell notification and the email — links here, never to the Setup tab (which does not show the request).

/** The event editor for a draft id. */
export function eventEditorPath(draftId: string): string {
  return `/dashboard/events/new/visibility?draftId=${encodeURIComponent(draftId)}`
}
