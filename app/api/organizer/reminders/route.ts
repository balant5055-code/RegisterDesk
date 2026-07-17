// /api/organizer/reminders — the organizer Reminder Center backend.
//   GET  → this workspace's reminders (history) + analytics.
//   POST → { action: 'create' | 'cancel' | 'setEventPref', ... }. Owner-scoped.
//
// Reuses the reminder service; sends nothing itself (the cron dispatches).

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { adminDb }             from '@/lib/firebase/admin'
import {
  listRemindersForOrganizer, createCustomReminder, cancelReminder, ReminderError,
} from '@/lib/reminders/service'
import { setEventRemindersEnabled } from '@/lib/reminders/config'
import type { ReminderAudience } from '@/lib/reminders/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)
  try {
    const { items, analytics } = await listRemindersForOrganizer(ctx.workspaceUid)
    return NextResponse.json({ reminders: items, analytics }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[organizer/reminders] list failed', e)
    return NextResponse.json({ error: 'Failed to load reminders' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)
  const uid = ctx.workspaceUid

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  const action = body.action

  try {
    if (action === 'create') {
      const audience = (body.audience === 'organizer' ? 'organizer' : 'attendees') as ReminderAudience
      const id = await createCustomReminder({
        organizerUid: uid,
        audience,
        eventId:  typeof body.eventId === 'string' ? body.eventId : null,
        subject:  typeof body.subject === 'string' ? body.subject : '',
        message:  typeof body.message === 'string' ? body.message : '',
        sendAtMs: typeof body.sendAtMs === 'number' ? body.sendAtMs : NaN,
      })
      return NextResponse.json({ ok: true, id })
    }

    if (action === 'cancel') {
      if (typeof body.id !== 'string') return NextResponse.json({ error: 'id is required' }, { status: 400 })
      await cancelReminder(body.id, uid)
      return NextResponse.json({ ok: true })
    }

    if (action === 'setEventPref') {
      const eventId = typeof body.eventId === 'string' ? body.eventId : ''
      const enabled = body.enabled !== false
      if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
      const ev = await adminDb.doc(`events/${eventId}`).get()
      const owner = ev.exists ? ((ev.data() as Record<string, unknown>).uid ?? (ev.data() as Record<string, unknown>).organizerUid) : null
      if (owner !== uid) return NextResponse.json({ error: 'You do not own this event' }, { status: 403 })
      await setEventRemindersEnabled(eventId, uid, enabled)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (e) {
    if (e instanceof ReminderError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('[organizer/reminders] action failed', e)
    return NextResponse.json({ error: 'Action failed' }, { status: 500 })
  }
}
