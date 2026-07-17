// Conference management for one event (Phase G.3).
//   GET  ?                          → schedule bundle + analytics       (perm: events)
//   GET  ?sessionId=&format=csv     → session attendee export           (perm: registrations)
//   GET  ?speakerId=&format=csv     → speaker schedule export           (perm: events)
//   POST { action, ... }            → session/track/hall/speaker CRUD   (perm: events)
//        action 'set_registration_sessions'                            (perm: registrations)
//
// [eventId] = draftId; the slug + ownership are resolved via resolveOwnedEvent.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { resolveOwnedEvent } from '@/lib/sessions/eventScope'
import { getSchedule, computeAnalytics, listSessionAttendees, speakerSchedule } from '@/lib/sessions/queries'
import {
  createSession, updateSession, cancelSession,
  createTrack, createHall, createSpeaker, deleteTrack, deleteHall, deleteSpeaker,
  setRegistrationSessions,
} from '@/lib/sessions/service'
import { SessionError } from '@/lib/sessions/types'
import { tableToCsv } from '@/lib/reports/csv'
import type { ReportTable } from '@/lib/reports/types'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ eventId: string }> }

function csvResponse(table: ReportTable, filename: string): NextResponse {
  return new NextResponse(tableToCsv(table), {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
  })
}

// ─── GET ────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, ctx: Params): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const p = req.nextUrl.searchParams
  const wantAttendees = !!p.get('sessionId') && p.get('format') === 'csv'

  const authz = await authorizeWorkspace(req, wantAttendees ? 'registrations' : 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  // Session attendee export
  if (wantAttendees) {
    const sessionId = p.get('sessionId')!
    const rows = await listSessionAttendees(authz.workspaceUid, event.slug, sessionId)
    const table: ReportTable = {
      id: 'attendees', title: 'Session Attendees',
      columns: [
        { key: 'name', label: 'Name', type: 'text' }, { key: 'email', label: 'Email', type: 'text' },
        { key: 'phone', label: 'Phone', type: 'text' }, { key: 'ticketCode', label: 'Ticket', type: 'text' },
        { key: 'checkedIn', label: 'Checked In', type: 'text' },
      ],
      rows: rows.map(r => ({ name: r.name, email: r.email, phone: r.phone, ticketCode: r.ticketCode, checkedIn: r.checkedIn ? 'Yes' : 'No' })),
    }
    return csvResponse(table, `session-attendees-${sessionId}.csv`)
  }

  const bundle = await getSchedule(authz.workspaceUid, event.slug)

  // Speaker schedule export
  if (p.get('speakerId') && p.get('format') === 'csv') {
    const speakerId = p.get('speakerId')!
    const sessions = speakerSchedule(bundle, speakerId)
    const table: ReportTable = {
      id: 'speaker-schedule', title: 'Speaker Schedule',
      columns: [
        { key: 'title', label: 'Session', type: 'text' }, { key: 'start', label: 'Start', type: 'date' },
        { key: 'end', label: 'End', type: 'date' }, { key: 'registered', label: 'Registered', type: 'number' },
      ],
      rows: sessions.map(s => ({ title: s.title, start: new Date(s.startTime).toISOString(), end: new Date(s.endTime).toISOString(), registered: s.registeredCount })),
    }
    return csvResponse(table, `speaker-schedule-${speakerId}.csv`)
  }

  const analytics = computeAnalytics(bundle)
  return NextResponse.json({ ...bundle, analytics, eventName: event.eventName }, { headers: { 'Cache-Control': 'no-store' } })
}

// ─── POST (action dispatch) ───────────────────────────────────────────────────
export async function POST(req: NextRequest, ctx: Params): Promise<NextResponse> {
  const { eventId } = await ctx.params
  let body: { action?: string; [k: string]: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const action = body.action

  const perm = action === 'set_registration_sessions' ? 'registrations' : 'events'
  const authz = await authorizeWorkspace(req, perm)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const event = await resolveOwnedEvent(uid, eventId)
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const slug = event.slug

  try {
    switch (action) {
      case 'create_session': {
        const id = await createSession(uid, slug, body.session as Parameters<typeof createSession>[2])
        return NextResponse.json({ success: true, sessionId: id }, { status: 201 })
      }
      case 'update_session':
        await updateSession(uid, slug, String(body.sessionId), body.patch as Record<string, never>)
        return NextResponse.json({ success: true })
      case 'cancel_session':
        await cancelSession(uid, slug, String(body.sessionId))
        return NextResponse.json({ success: true })
      case 'create_track':
        return NextResponse.json({ success: true, trackId: await createTrack(uid, slug, String(body.name ?? ''), body.color as string | undefined) }, { status: 201 })
      case 'delete_track':
        await deleteTrack(uid, slug, String(body.trackId)); return NextResponse.json({ success: true })
      case 'create_hall':
        return NextResponse.json({ success: true, hallId: await createHall(uid, slug, String(body.name ?? ''), body.capacity as number | null | undefined) }, { status: 201 })
      case 'delete_hall':
        await deleteHall(uid, slug, String(body.hallId)); return NextResponse.json({ success: true })
      case 'create_speaker':
        return NextResponse.json({ success: true, speakerId: await createSpeaker(uid, slug, body.speaker as Parameters<typeof createSpeaker>[2]) }, { status: 201 })
      case 'delete_speaker':
        await deleteSpeaker(uid, slug, String(body.speakerId)); return NextResponse.json({ success: true })
      case 'set_registration_sessions': {
        const result = await setRegistrationSessions(String(body.registrationId), (body.sessionIds as string[]) ?? [], { expectedOrganizerUid: uid, expectedEventSlug: slug })
        return NextResponse.json({ success: true, ...result })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof SessionError) {
      const status = err.code === 'SESSION_FULL' || err.code === 'SESSION_CONFLICT' || err.code === 'HALL_CONFLICT' ? 409 : 400
      return NextResponse.json({ error: err.code, detail: err.detail ?? null }, { status })
    }
    console.error('[organizer/sessions] action failed:', action, err)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
