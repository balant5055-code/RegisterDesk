// Integration platform types — API keys + organizer webhooks.
// Client-safe: pure types + label maps + the event/permission allowlists.

// ─── API keys ─────────────────────────────────────────────────────────────────

export type ApiKeyStatus = 'active' | 'revoked'

export type ApiKeyPermission =
  | 'registrations.read'
  | 'attendees.read'
  | 'donations.read'
  | 'events.read'

export const API_KEY_PERMISSIONS: ApiKeyPermission[] = [
  'registrations.read', 'attendees.read', 'donations.read', 'events.read',
]

export function isApiKeyPermission(v: unknown): v is ApiKeyPermission {
  return typeof v === 'string' && (API_KEY_PERMISSIONS as string[]).includes(v)
}

export interface ApiKeyDocument {
  keyId:        string
  organizerUid: string
  name:         string
  keyPrefix:    string              // first 16 chars (rd_live_ + 8) — indexed lookup
  keyHash:      string              // SHA-256(fullKey) hex — never the plaintext
  permissions:  ApiKeyPermission[]
  lastUsedAt:   unknown | null
  status:       ApiKeyStatus
  createdAt:    unknown
  revokedAt:    unknown | null
}

// Returned to clients — NEVER includes keyHash.
export interface ApiKeyView {
  keyId:       string
  name:        string
  keyPrefix:   string
  permissions: ApiKeyPermission[]
  status:      ApiKeyStatus
  lastUsedAt:  string | null
  createdAt:   string | null
  revokedAt:   string | null
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'registration.created'
  | 'registration.cancelled'
  | 'registration.checked_in'
  | 'donation.completed'
  | 'donation.refunded'
  | 'settlement.requested'
  | 'settlement.paid'
  | 'broadcast.sent'
  | 'certificate.issued'

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  'registration.created', 'registration.cancelled', 'registration.checked_in',
  'donation.completed', 'donation.refunded',
  'settlement.requested', 'settlement.paid',
  'broadcast.sent', 'certificate.issued',
]

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed'

export interface WebhookDeliveryDocument {
  deliveryId:   string
  organizerUid: string
  eventType:    WebhookEventType
  targetUrl:    string
  payload:      Record<string, unknown>   // the full signed body { event, data, timestamp, deliveryId }
  status:       WebhookDeliveryStatus
  attempts:     number
  responseCode: number | null
  responseBody: string | null              // truncated
  nextRetryAt:  unknown                     // Timestamp — when the cron should (re)try
  lastError:    string | null
  createdAt:    unknown
  updatedAt:    unknown
}

export interface WebhookDeliveryView {
  deliveryId:   string
  eventType:    WebhookEventType
  status:       WebhookDeliveryStatus
  attempts:     number
  responseCode: number | null
  responseBody: string | null
  createdAt:    string | null
}

// Organizer webhook config (stored on users/{uid}). Secret is the HMAC signing
// key the organizer uses to verify X-RegisterDesk-Signature.
export interface WebhookConfig {
  webhookUrl:    string | null
  webhookSecret: string | null
}

// Exponential backoff before each retry (ms). Max 5 attempts total.
export const WEBHOOK_BACKOFF_MS = [
  60_000,        // 1m
  300_000,       // 5m
  1_800_000,     // 30m
  7_200_000,     // 2h
  43_200_000,    // 12h
] as const
export const WEBHOOK_MAX_ATTEMPTS = 5
export const WEBHOOK_TIMEOUT_MS   = 10_000
