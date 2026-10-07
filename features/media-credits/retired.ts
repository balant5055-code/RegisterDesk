// RD-LEGACY-01 · Media Credits are RETIRED (RD-PHOTO-01, 2026-10-06).
//
// Photos are a paid per-event service bought on License & Services (max 3,000 per event). The
// routes that could CREATE credit value — an organizer purchase, an organizer refund request and
// a Super Admin grant — answer with this explicit 410 BEFORE any read or write, so their refusal
// no longer rests on a single policy constant (`MEDIA_CREDITS_RETIRED`) that a future edit could
// flip. Historical reads and the wind-down actions (reject a pending refund, retry an approved
// payout, settle old sessions) are unaffected.

import { NextResponse } from 'next/server'

export const MEDIA_CREDITS_RETIRED_CODE = 'MEDIA_CREDITS_RETIRED'

export function mediaCreditsRetiredResponse(): NextResponse {
  return NextResponse.json({
    error: 'Media Credits are no longer sold or granted. Photo capacity is purchased per event on License & Services (up to 3,000 photos).',
    code: MEDIA_CREDITS_RETIRED_CODE,
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } })
}
