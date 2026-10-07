// RD-EVENT-COMMERCE-03 · the base photo cap a prepaid media allowance sits on. Server-only.
//
// RD-PHOTO-01 (2026-10-06) — there is NO free photo base any more. Photos are a paid event service:
// an event's photo capacity is exactly the photo units paid for on it (lib/licensing/photoCapacity.ts),
// so the base every media unit sits on is 0. The legacy `mediaStudio.maxPhotosPerEvent` / licence-tier
// photo limits grant nothing and are not read here. Kept as a function (rather than inlined) because
// every purchase path stamps `baseCapAtPurchase` from it, which now records 0 on every new media line.

/** The event's free base photo cap: always 0 (photo capacity is paid only). */
export async function mediaBasePhotoCap(args: { organizerUid: string; draftId: string; eventSlug?: string | null }): Promise<number> {
  void args   // the event no longer matters: no event has a free photo base
  return 0
}

/** Retained for callers that still name it; with a base of 0 media units are always sellable. */
export const MEDIA_UNLIMITED_MESSAGE = 'This event has no photo limit, so additional photo capacity cannot be bought.'
