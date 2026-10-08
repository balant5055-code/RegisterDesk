// RD-COMMS-P2-C — the name a broadcast calls its event, from the EVENT DOCUMENT (events/{slug}) only.
//
// The broadcast create route used to store whatever `eventName` the client sent, and the WhatsApp
// job put it into every message as {{eventName}} — so an organizer could title a message with any
// event's name. The name is now read from the event the broadcast is verified to belong to: at
// create (stored on the campaign) and again by the job at send time.

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')

/** The event's display name: eventDetails.info.name, else its stored eventName / name, else the slug. */
export function authoritativeEventName(event: Record<string, unknown> | null | undefined, slug: string): string {
  const info = ((event?.eventDetails as Record<string, unknown> | undefined)?.info ?? {}) as Record<string, unknown>
  return str(info.name) || str(event?.eventName) || str(event?.name) || slug
}
