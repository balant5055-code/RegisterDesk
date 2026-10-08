// lib/wallet/communicationBalance.ts
// Where an organizer reviews COMMUNICATION USAGE — Communication Center › Usage (read-only,
// event-scoped).
//
// RD-COMMS-P1 — the old "communication balance" (organizerWallets) is LEGACY and in controlled
// drain: no funds can be added (the top-up route is retired) and communication capacity is bought
// per event on License & Services. Links that used to open the balance's top-up (Communications ›
// Billing) now open Usage; `?tab=billing` remains an alias so old links keep working.

export const COMMUNICATION_USAGE_HREF = '/dashboard/communications?tab=usage'

/** @deprecated Kept for existing imports — the balance is no longer a top-up destination. */
export const COMMUNICATION_BALANCE_HREF = COMMUNICATION_USAGE_HREF
