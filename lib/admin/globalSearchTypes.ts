// Client-safe DTOs for the Enterprise Global Search (GA-2 S6).
// NO firebase-admin / server imports.
//
// Global search is a REUSE-first aggregator: the palette/page call the EXISTING
// bounded admin list endpoints directly —
//   Organizers → GET /api/admin/organizers?search=      (in-memory per-page filter)
//   Licenses   → GET /api/admin/licenses?search=          (listLicenses)
//   Coupons    → GET /api/admin/license-coupons           (listCoupons, ≤500)
// — and this ONE new thin endpoint for events (no event-search endpoint existed):
//   Events     → GET /api/admin/search/events?q=
// Entities with no global text index (participants, payments, jobs) are OMITTED
// per the honesty rule — they are never scanned; the palette links to the workspace
// that scopes them instead.

export interface EventSearchHit {
  slug:            string
  name:            string
  organizerUid:    string | null
  lifecycleStatus: string | null
  eventType:       string | null
}

export interface EventSearchResponse { events: EventSearchHit[] }
