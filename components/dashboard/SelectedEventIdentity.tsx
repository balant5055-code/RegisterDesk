'use client'

// RD-DASHBOARD-12 · The selected event's identity, beside the control that chose it.
//
// ═══ WHY IT LIVES IN THE TOP BAR ═════════════════════════════════════════════
// The dashboard used to restate the event name as a large heading a third of the way down
// the page. That is the same fact twice, and the second copy is the one that goes stale in
// a reader's mind when they scroll back up. Putting the identity next to the selector
// makes the scope legible from the top bar on EVERY page, and lets the dashboard drop its
// duplicate title entirely.
//
// It reads the shared EventContext and renders nothing of its own — this is emphatically
// NOT a second selector. There is no click target here.

import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { eventTaxonomyLine } from '@/lib/events/taxonomy'

export function SelectedEventIdentity() {
  const { selectedEvent, isAllEvents, loading } = useEventContext()

  // Nothing to state yet, or nothing selectable. The selector itself already says so.
  if (loading || (!selectedEvent && !isAllEvents)) return null

  const taxonomy = selectedEvent
    ? eventTaxonomyLine(selectedEvent.eventType, selectedEvent.eventSubtype)
    : null

  return (
    <div className="hidden min-w-0 flex-col justify-center lg:flex" aria-hidden>
      <span className="truncate text-fs-2xs font-semibold uppercase tracking-wide text-foreground">
        {isAllEvents ? 'All events' : selectedEvent?.name}
      </span>
      {/* The event's OWN configured taxonomy. Absent ⇒ nothing rendered; an invented
          category would be a lie about the organizer's own setup. */}
      {taxonomy && (
        <span className="truncate text-fs-2xs text-muted-foreground">{taxonomy}</span>
      )}
    </div>
  )
}
