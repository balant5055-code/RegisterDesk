// Event License repository CONTRACTS — FOUNDATION ONLY (Phase D3.1).
//
// Interface definitions for the data-access layer over the Event License schema
// (lib/licensing/schema). These are contracts only: there is NO implementation
// here, and nothing implements or calls them yet. A concrete Firestore-backed
// implementation arrives in a later phase (D3.2+). Every method is async because
// the eventual implementation will touch Firestore; here they are signatures only.
//
// This module emits zero JavaScript — every export is a `type`/`interface` and all
// imports are `import type`.

import type {
  EventLicenseDoc,
  LicenseOrderDoc,
  LicenseHistoryDoc,
} from './schema'

/** Data access over eventLicenses/{eventId}. */
export interface EventLicenseRepository {
  /** Read the license attached to an event, or null if none exists. */
  getByEventId(eventId: string): Promise<EventLicenseDoc | null>
  /** Create or replace the license for an event. */
  save(doc: EventLicenseDoc): Promise<void>
  /** List the organizer's currently-active licenses (drives workspace resolution). */
  listActiveByOrganizer(organizerUid: string): Promise<EventLicenseDoc[]>
}

/** Data access over licenseOrders/{orderId}. */
export interface LicenseOrderRepository {
  /** Read an order by id, or null if none exists. */
  getById(orderId: string): Promise<LicenseOrderDoc | null>
  /** Create a new order record. */
  create(doc: LicenseOrderDoc): Promise<void>
  /** Transition an order to a new status (e.g. created → paid / failed / refunded). */
  updateStatus(orderId: string, status: LicenseOrderDoc['status']): Promise<void>
}

/** Append-only access over licenseHistory/{autoId}. */
export interface LicenseHistoryRepository {
  /** Append an immutable history entry. */
  append(entry: LicenseHistoryDoc): Promise<void>
  /** List the history for an event, most recent first. */
  listByEvent(eventId: string): Promise<LicenseHistoryDoc[]>
}

/** Aggregate of the three repositories, for dependency injection in later phases. */
export interface LicenseRepositories {
  licenses: EventLicenseRepository
  orders:   LicenseOrderRepository
  history:  LicenseHistoryRepository
}
