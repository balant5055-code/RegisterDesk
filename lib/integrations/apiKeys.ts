// API key engine — server-only. Plaintext keys are NEVER stored or logged: only
// SHA-256(key) is persisted, and the plaintext is returned exactly once at
// creation. Lookup is by an indexed prefix, then a timing-safe hash compare.

import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { getClientIp } from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import {
  type ApiKeyDocument, type ApiKeyView, type ApiKeyPermission, isApiKeyPermission,
} from '@/lib/integrations/types'

const COLLECTION = 'apiKeys'
const KEY_RE     = /^rd_live_[A-Za-z0-9_-]{20,}$/

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function toApiKeyView(d: ApiKeyDocument): ApiKeyView {
  return {
    keyId:       d.keyId,
    name:        d.name,
    keyPrefix:   d.keyPrefix,
    permissions: d.permissions,
    status:      d.status,
    lastUsedAt:  tsToISO(d.lastUsedAt),
    createdAt:   tsToISO(d.createdAt),
    revokedAt:   tsToISO(d.revokedAt),
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateApiKeyResult { view: ApiKeyView; plaintextKey: string }

/**
 * Generates a 32-byte key (`rd_live_…`), stores only its SHA-256 hash, and
 * returns the plaintext exactly once. The caller must surface plaintextKey to the
 * user immediately and never persist it.
 */
export async function createApiKey(
  organizerUid: string, name: string, permissions: ApiKeyPermission[],
): Promise<CreateApiKeyResult> {
  const raw       = randomBytes(32).toString('base64url')   // ≈43 url-safe chars
  const fullKey   = `rd_live_${raw}`
  const keyPrefix = fullKey.slice(0, 16)                     // rd_live_ + 8 chars (indexed)
  const keyHash   = sha256Hex(fullKey)

  const ref: FirebaseFirestore.DocumentReference = adminDb.collection(COLLECTION).doc()
  const doc: ApiKeyDocument = {
    keyId:        ref.id,
    organizerUid,
    name:         name.trim().slice(0, 120) || 'API key',
    keyPrefix,
    keyHash,
    permissions,
    lastUsedAt:   null,
    status:       'active',
    createdAt:    FieldValue.serverTimestamp(),
    revokedAt:    null,
  }
  await ref.set(doc)
  const snap = await ref.get()
  return { view: toApiKeyView({ ...(snap.data() as ApiKeyDocument), keyId: ref.id }), plaintextKey: fullKey }
}

export async function listApiKeys(organizerUid: string): Promise<ApiKeyView[]> {
  const snap = await adminDb.collection(COLLECTION)
    .where('organizerUid', '==', organizerUid)
    .get()
  return snap.docs
    .map(d => toApiKeyView({ ...(d.data() as ApiKeyDocument), keyId: d.id }))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

export async function revokeApiKey(organizerUid: string, keyId: string): Promise<boolean> {
  const ref  = adminDb.collection(COLLECTION).doc(keyId)
  const snap = await ref.get()
  if (!snap.exists) return false
  const d = snap.data() as ApiKeyDocument
  if (d.organizerUid !== organizerUid) return false   // ownership check
  if (d.status === 'revoked') return true
  await ref.update({ status: 'revoked', revokedAt: FieldValue.serverTimestamp() })
  return true
}

// ─── Verify (authenticate an incoming API request) ───────────────────────────

export interface ApiKeyAuth { organizerUid: string; permissions: ApiKeyPermission[]; keyId: string }

/**
 * Resolves an `Authorization: Bearer rd_live_…` header to its organizer +
 * permissions, or null on any failure (malformed / unknown / revoked). Updates
 * lastUsedAt best-effort. Lookup is by indexed prefix then timing-safe hash
 * compare so a wrong key can't be distinguished by timing.
 */
export async function verifyApiKey(req: Request): Promise<ApiKeyAuth | null> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!KEY_RE.test(token)) return null

  const prefix = token.slice(0, 16)
  const snap = await adminDb.collection(COLLECTION)
    .where('keyPrefix', '==', prefix)
    .where('status', '==', 'active')
    .limit(5)
    .get()
  if (snap.empty) return null

  const presented = Buffer.from(sha256Hex(token), 'hex')
  for (const doc of snap.docs) {
    const d = doc.data() as ApiKeyDocument
    const stored = Buffer.from(d.keyHash, 'hex')
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      // Best-effort usage stamp — never blocks auth.
      void doc.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {})
      const perms = (d.permissions ?? []).filter(isApiKeyPermission)
      return { organizerUid: d.organizerUid, permissions: perms, keyId: d.keyId }
    }
  }
  return null
}

// ─── Route helper: authenticate + permission + rate limit ─────────────────────

export type ApiAuthResult =
  | { ok: true; organizerUid: string; permissions: ApiKeyPermission[]; keyId: string }
  | { ok: false; status: number; error: string; headers?: Record<string, string> }

/**
 * Single entry point for public API routes. Rate-limits by client IP, verifies
 * the key, and enforces the required permission. Returns the organizer scope on
 * success or a ready-to-return error.
 */
export async function authenticateApiKey(
  req: Request, required: ApiKeyPermission,
): Promise<ApiAuthResult> {
  const ip = getClientIp({ headers: { get: (k: string) => (req.headers as Headers).get(k) } })
  // 120 req/min/IP, distributed. Fail-CLOSED: a Redis outage must not remove the
  // throttle on the public API surface.
  const rl = await checkDistributedRateLimit({ key: `api-key-auth:${ip}`, limit: 120, windowSeconds: 60 })
  if (!rl.allowed) {
    return {
      ok: false, status: 429, error: 'Rate limit exceeded.',
      headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
    }
  }

  const auth = await verifyApiKey(req)
  if (!auth) return { ok: false, status: 401, error: 'Invalid or revoked API key.' }
  if (!auth.permissions.includes(required)) {
    return { ok: false, status: 403, error: `API key is missing the ${required} permission.` }
  }
  return { ok: true, ...auth }
}
