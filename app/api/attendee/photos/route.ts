// GET /api/attendee/photos?eventSlug=&cursor=&limit=
//
// RD-RUNNER-01. The participant's own race photos, one page at a time.
//
// ─── Why here and not under /api/public ──────────────────────────────────────
// These are not public. This sits alongside `/api/attendee/registrations`, `/tickets`,
// `/certificates` and `/donations` because it has the identical contract: the attendee
// session cookie is the only credential, and every query is scoped to the email it carries.
// A parallel API with its own auth would be a second place for that rule to drift.
//
// The caller supplies an EVENT and nothing else. They cannot name a bib, a runner, an asset
// or an organizer — the platform derives all of that from their session.

import { NextRequest, NextResponse } from 'next/server'
import { listRunnerPhotos, resolveRunner } from '@/features/runner-photos/services/photoAccess'
import {
  PHOTOS_MAX_PAGE_SIZE, PHOTOS_PAGE_SIZE,
  type PhotoAccessDenial, type RunnerPhotoPage,
} from '@/features/runner-photos/types'

export type AttendeePhotosResponse =
  | (RunnerPhotoPage & { ok: true; bibNumber: string; eventName: string })
  | { ok: false; reason: PhotoAccessDenial }

/** Signed URLs expire, so a cached response would hand out dead links. */
const NO_STORE = { 'Cache-Control': 'no-store, private' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const eventSlug = req.nextUrl.searchParams.get('eventSlug')?.trim() ?? ''
  if (!eventSlug) {
    return NextResponse.json({ error: 'eventSlug is required' }, { status: 400, headers: NO_STORE })
  }

  const resolved = await resolveRunner(eventSlug)
  if (!resolved.ok) {
    const denial = resolved.outcome as { ok: false; reason: PhotoAccessDenial }
    // 200 with a reason, not a 4xx: "you have not verified yet" and "you did not run this
    // race" are normal states of a page a participant is allowed to open, and the page needs
    // to tell them which one they are in.
    return NextResponse.json(denial satisfies AttendeePhotosResponse, { headers: NO_STORE })
  }

  const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? PHOTOS_PAGE_SIZE)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.floor(rawLimit)), PHOTOS_MAX_PAGE_SIZE)
    : PHOTOS_PAGE_SIZE

  const page = await listRunnerPhotos({
    runner: resolved.runner,
    limit,
    cursor: req.nextUrl.searchParams.get('cursor'),
  })

  const body: AttendeePhotosResponse = {
    ok: true,
    bibNumber: resolved.runner.bibNumber,
    eventName: resolved.runner.eventName,
    ...page,
  }
  return NextResponse.json(body, { headers: NO_STORE })
}
