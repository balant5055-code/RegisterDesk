// Phase P.1.3 — Screenshot registry.
//
// Declares the REAL product screenshots the marketing site will use. No images
// exist yet → every entry is `status: 'pending'` with `imagePath: null`, so the
// ScreenshotFrame renders a skeleton. No fake/illustrated screenshots are ever
// shipped; real captures replace these (set status 'available' + imagePath).

import type { ScreenshotDef } from '@/lib/marketing/types'

const DESK_W = 2400, DESK_H = 1500
const PHONE_W = 1080, PHONE_H = 2160

export const SCREENSHOTS: ScreenshotDef[] = [
  { id: 'dashboard-home',    title: 'Organizer dashboard',     description: 'The executive overview an organizer sees on login.', imagePath: null, alt: 'RegisterDesk organizer dashboard overview',  status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'event-home',        title: 'Event operating center',  description: 'The command center for a single event.',            imagePath: null, alt: 'RegisterDesk event operating center',     status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'identifier-center', title: 'Identifier Center',       description: 'Assign and manage participant identifiers.',         imagePath: null, alt: 'RegisterDesk identifier center',          status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'checkin',           title: 'QR check-in',             description: 'Fast, offline-capable gate check-in.',               imagePath: null, alt: 'RegisterDesk QR check-in screen',         status: 'pending', frame: 'mobile',    width: PHONE_W, height: PHONE_H },
  { id: 'certificates',      title: 'Certificate builder',     description: 'Design and issue certificates.',                     imagePath: null, alt: 'RegisterDesk certificate builder',        status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'public-event',      title: 'Public event page',       description: 'The page attendees register on.',                    imagePath: null, alt: 'RegisterDesk public event page',          status: 'pending', frame: 'browser',   width: DESK_W, height: DESK_H },
  { id: 'finance',           title: 'Finance & settlements',   description: 'Revenue, fees, and payouts.',                        imagePath: null, alt: 'RegisterDesk finance and settlements',    status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'setup-center',      title: 'Event Setup Center',      description: 'Guided setup for a new event.',                      imagePath: null, alt: 'RegisterDesk event setup center',         status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'participant-360',   title: 'Participant Workspace',   description: 'The 360° view of a single participant.',             imagePath: null, alt: 'RegisterDesk participant 360 workspace',  status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'crm',               title: 'CRM & Audience',          description: 'Unified contacts across events.',                    imagePath: null, alt: 'RegisterDesk CRM and audience',           status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'sessions',          title: 'Sessions & Agenda',       description: 'Multi-track session scheduling.',                    imagePath: null, alt: 'RegisterDesk sessions and agenda',        status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'ticket',            title: 'Digital ticket',          description: "The attendee's ticket with QR and identifier.",      imagePath: null, alt: 'RegisterDesk digital ticket with QR code', status: 'pending', frame: 'browser',   width: DESK_W, height: DESK_H },
  { id: 'attendee-email',    title: 'Attendee email',          description: 'Confirmation and event update emails.',              imagePath: null, alt: 'RegisterDesk attendee confirmation email', status: 'pending', frame: 'browser',   width: DESK_W, height: DESK_H },
  { id: 'developer-api',     title: 'Developer API',           description: 'API keys, webhooks, and the metadata platform.',     imagePath: null, alt: 'RegisterDesk developer API and webhooks', status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
  { id: 'security-center',   title: 'Security & trust',        description: 'Roles, audit history, and workspace controls.',      imagePath: null, alt: 'RegisterDesk security and trust controls', status: 'pending', frame: 'dashboard', width: DESK_W, height: DESK_H },
]

export function getScreenshot(id: string): ScreenshotDef | undefined {
  return SCREENSHOTS.find(s => s.id === id)
}
