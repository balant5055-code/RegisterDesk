// Server-only: Firebase Admin SDK reads — never import from client components.

import { adminDb } from '@/lib/firebase/admin'
import type { CapacityPlan, PlanType } from '@/lib/registrations/types'
import type { RegistrationFormDraft } from '@/components/wizard/registrationFormConfig'
import type { EventLifecycleStatus }  from '@/types/events'
import { deriveLifecycleStatus }       from '@/lib/events/lifecycle'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PublishedEvent {
  slug:          string
  uid:           string
  draftId:       string
  eventType:     string | null
  eventSubtype:  string | null
  visibility:    string | null
  pricing:       Record<string, unknown> | null
  eventDetails:  Record<string, unknown>
  planType:          PlanType        // 'free_event' | 'paid_event' — set at publish time
  capacityPlan:      CapacityPlan   // free events start at 'free'; paid events start at 'unlimited'
  totalCapacity:     number | null  // null = unlimited; derived from capacityPlan at publish
  registrationForm:  RegistrationFormDraft | null  // form config written at publish time
  lifecycleStatus:   EventLifecycleStatus          // authoritative lifecycle state
  publishedAt:       FirebaseFirestore.Timestamp | null
  updatedAt:         FirebaseFirestore.Timestamp | null
  // Cancellation fields — present when lifecycleStatus = 'cancelled'
  cancelledAt?:   FirebaseFirestore.Timestamp
  cancelledBy?:   string
  cancelReason?:  string
  // Completion / archive timestamps
  completedAt?:   FirebaseFirestore.Timestamp
  archivedAt?:    FirebaseFirestore.Timestamp
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getEventBySlug(slug: string): Promise<PublishedEvent | null> {
  const snap = await adminDb.collection('events').doc(slug).get()
  if (!snap.exists) return null
  const raw  = snap.data() as Record<string, unknown>
  const data = raw as unknown as PublishedEvent
  // Back-fill registrationForm for events published before this field was added.
  data.registrationForm = data.registrationForm ?? null
  // Back-fill for events published before planType/capacityPlan fields existed.
  // Derive from pricing.eventType so paid events aren't incorrectly capped at 100.
  if (!data.capacityPlan) {
    const isPaid       = (data.pricing as Record<string, unknown> | null)?.eventType !== 'free'
    data.planType      = isPaid ? 'paid_event'  : 'free_event'
    data.capacityPlan  = isPaid ? 'unlimited'   : 'free'
    data.totalCapacity = isPaid ? null           : 100
  }
  // Back-fill lifecycleStatus for events published before this field was added.
  data.lifecycleStatus = deriveLifecycleStatus(raw)
  return data
}
