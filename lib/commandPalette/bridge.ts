// Command Palette event bridge (Phase H.4.2).
//
// Tiny, dependency-free window-event contract shared between the palette, the
// dashboard header, and ManageEventClient — kept separate so the event page does
// not have to bundle the palette component just to read these constants.

export const OPEN_EVENT     = 'registerdesk:open-command-palette'
export const SET_TAB_EVENT  = 'registerdesk:set-event-tab'
export const REFRESH_EVENT  = 'registerdesk:refresh-event'

export interface SetTabDetail  { eventId: string; tab: string }
export interface RefreshDetail { eventId: string }

/** Open the palette from anywhere (e.g. the header search button). */
export function openCommandPalette(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}
