// /api/admin/reminders — Admin Reminder console backend. Admin-only.
//   GET   → all reminders (cursor-paginated) + analytics + global settings.
//   PATCH → update global reminder settings (enable / per-kind / offsets / retry).
//   POST  → { action:'cancel', id } cancel any scheduled reminder.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { listRemindersForAdmin, cancelReminder, ReminderError } from '@/lib/reminders/service'
import { getReminderSettings, updateReminderSettings, type ReminderSettings } from '@/lib/reminders/config'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const pageSize = Math.min(Math.max(parseInt(sp.get('pageSize') ?? '25', 10) || 25, 1), 100)
  try {
    const [list, settings] = await Promise.all([
      listRemindersForAdmin({ pageSize, cursor: sp.get('cursor'), status: sp.get('status') ?? '' }),
      getReminderSettings(),
    ])
    return NextResponse.json({ ...list, settings }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/reminders] list failed', e)
    return NextResponse.json({ error: 'Failed to load reminders' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let patch: Partial<ReminderSettings>
  try { patch = await req.json() as Partial<ReminderSettings> }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  try {
    const settings = await updateReminderSettings(patch, adminUid)
    return NextResponse.json({ ok: true, settings })
  } catch (e) {
    console.error('[admin/reminders] settings update failed', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  if (body.action !== 'cancel' || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
  try {
    await cancelReminder(body.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof ReminderError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: 'Action failed' }, { status: 500 })
  }
}
