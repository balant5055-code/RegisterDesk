// Custom domain service — server-only. Validates + normalizes hostnames, enforces
// uniqueness + a reserved list, and verifies ownership via real DNS lookups
// (CNAME → DNS target, TXT → verification token).

import { promises as dns } from 'node:dns'
import { randomBytes }      from 'crypto'
import { FieldValue }       from 'firebase-admin/firestore'
import { adminDb }          from '@/lib/firebase/admin'
import {
  DOMAIN_DNS_TARGET, DOMAIN_TXT_PREFIX,
  type DomainConfig, type DnsRecord, type CustomDomainStatus, type CustomDomainSslStatus, type AdminDomainRow,
} from '@/lib/domains/types'

// Hostnames an organizer may NOT claim (platform-owned / unsafe).
const RESERVED_SUFFIXES = ['registerdesk.in', 'vercel.app', 'vercel.com', 'localhost']
const RESERVED_EXACT    = new Set(['registerdesk.in', 'www.registerdesk.in', 'localhost'])

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Normalizes user input to a bare lowercase hostname (strips scheme/path/port). */
export function normalizeHostname(input: string): string {
  let h = input.trim().toLowerCase()
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:.*$/, '').replace(/\.$/, '')
  return h
}

function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false
  const labels = h.split('.')
  if (labels.length < 2) return false   // must be a FQDN with a TLD
  return labels.every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
}

export function isReservedHostname(h: string): boolean {
  if (RESERVED_EXACT.has(h)) return true
  return RESERVED_SUFFIXES.some(suf => h === suf || h.endsWith(`.${suf}`))
}

export type ValidateResult = { ok: true; hostname: string } | { ok: false; error: string }

export function validateHostname(input: string): ValidateResult {
  const h = normalizeHostname(input)
  if (!isValidHostname(h))  return { ok: false, error: 'Enter a valid domain, e.g. events.yourbrand.com' }
  if (isReservedHostname(h)) return { ok: false, error: 'This domain is reserved and cannot be used.' }
  return { ok: true, hostname: h }
}

function buildRecords(hostname: string, token: string): DnsRecord[] {
  return [
    { type: 'CNAME', name: hostname, value: DOMAIN_DNS_TARGET },
    { type: 'TXT',   name: `${DOMAIN_TXT_PREFIX}.${hostname}`, value: token },
  ]
}

// ─── Read ─────────────────────────────────────────────────────────────────────

interface DomainFields {
  customDomain?:           string | null
  customDomainStatus?:     CustomDomainStatus | null
  customDomainVerifiedAt?: unknown
  customDomainSslStatus?:  CustomDomainSslStatus | null
  customDomainToken?:      string | null
  customDomainError?:      string | null
}

export async function getDomainConfig(uid: string): Promise<DomainConfig> {
  const snap = await adminDb.doc(`users/${uid}`).get()
  const d = (snap.data() as DomainFields | undefined) ?? {}
  const domain = typeof d.customDomain === 'string' ? d.customDomain : null
  return {
    customDomain:           domain,
    customDomainStatus:     d.customDomainStatus ?? null,
    customDomainVerifiedAt: tsToISO(d.customDomainVerifiedAt),
    customDomainDnsTarget:  domain ? DOMAIN_DNS_TARGET : null,
    customDomainSslStatus:  d.customDomainSslStatus ?? null,
    records:                domain && d.customDomainToken ? buildRecords(domain, d.customDomainToken) : [],
    lastError:              typeof d.customDomainError === 'string' ? d.customDomainError : null,
  }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export type DomainResult = { ok: true; config: DomainConfig } | { ok: false; status: number; error: string }

/** Sets (or replaces) the organizer's custom domain. Validates, checks the
 *  reserved list, and enforces global uniqueness across organizers. */
export async function setDomain(uid: string, input: string): Promise<DomainResult> {
  const v = validateHostname(input)
  if (!v.ok) return { ok: false, status: 400, error: v.error }
  const hostname = v.hostname

  // Uniqueness — no other organizer may already own this domain.
  const dup = await adminDb.collection('users').where('customDomain', '==', hostname).limit(2).get()
  if (dup.docs.some(doc => doc.id !== uid)) {
    return { ok: false, status: 409, error: 'This domain is already in use by another organizer.' }
  }

  const token = `rdv_${randomBytes(16).toString('hex')}`
  await adminDb.doc(`users/${uid}`).set({
    customDomain:           hostname,
    customDomainStatus:     'pending' satisfies CustomDomainStatus,
    customDomainSslStatus:  'pending' satisfies CustomDomainSslStatus,
    customDomainToken:      token,
    customDomainVerifiedAt: null,
    customDomainError:      null,
    customDomainUpdatedAt:  FieldValue.serverTimestamp(),
  }, { merge: true })

  return { ok: true, config: await getDomainConfig(uid) }
}

export async function removeDomain(uid: string): Promise<DomainConfig> {
  await adminDb.doc(`users/${uid}`).set({
    customDomain:           null,
    customDomainStatus:     null,
    customDomainSslStatus:  null,
    customDomainToken:      null,
    customDomainVerifiedAt: null,
    customDomainError:      null,
    customDomainUpdatedAt:  FieldValue.serverTimestamp(),
  }, { merge: true })
  return getDomainConfig(uid)
}

// ─── Verification (real DNS lookup) ───────────────────────────────────────────

export type VerifyResult =
  | { ok: true; config: DomainConfig }
  | { ok: false; status: number; error: string; config?: DomainConfig }

async function cnameMatches(hostname: string): Promise<boolean> {
  try {
    const records = await dns.resolveCname(hostname)
    return records.some(r => r.toLowerCase().replace(/\.$/, '') === DOMAIN_DNS_TARGET)
  } catch { return false }
}

async function txtMatches(hostname: string, token: string): Promise<boolean> {
  try {
    const records = await dns.resolveTxt(`${DOMAIN_TXT_PREFIX}.${hostname}`)
    return records.some(chunks => chunks.join('').trim() === token)
  } catch { return false }
}

/** Checks DNS propagation. On success → status 'verified' + sslStatus 'active'. */
export async function verifyDomain(uid: string): Promise<VerifyResult> {
  const snap = await adminDb.doc(`users/${uid}`).get()
  const d = (snap.data() as DomainFields | undefined) ?? {}
  const hostname = typeof d.customDomain === 'string' ? d.customDomain : null
  const token    = typeof d.customDomainToken === 'string' ? d.customDomainToken : null
  if (!hostname || !token) return { ok: false, status: 404, error: 'No custom domain is configured.' }

  const [cnameOk, txtOk] = await Promise.all([cnameMatches(hostname), txtMatches(hostname, token)])
  if (cnameOk && txtOk) {
    await adminDb.doc(`users/${uid}`).set({
      customDomainStatus:     'verified' satisfies CustomDomainStatus,
      customDomainSslStatus:  'active'   satisfies CustomDomainSslStatus,
      customDomainVerifiedAt: FieldValue.serverTimestamp(),
      customDomainError:      null,
      customDomainUpdatedAt:  FieldValue.serverTimestamp(),
    }, { merge: true })
    return { ok: true, config: await getDomainConfig(uid) }
  }

  const missing = [!cnameOk ? 'CNAME' : null, !txtOk ? 'TXT' : null].filter(Boolean).join(' + ')
  await adminDb.doc(`users/${uid}`).set({
    customDomainStatus: 'failed' satisfies CustomDomainStatus,
    customDomainError:  `DNS not propagated yet (${missing} record not found).`,
    customDomainUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  return { ok: false, status: 422, error: `DNS records not found yet (${missing}). Propagation can take up to 48h.`, config: await getDomainConfig(uid) }
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export async function listAllDomains(): Promise<AdminDomainRow[]> {
  const snap = await adminDb.collection('users')
    .where('customDomainStatus', 'in', ['pending', 'verified', 'failed'])
    .limit(500)
    .get()
  return snap.docs.map(doc => {
    const d = doc.data() as DomainFields
    return {
      organizerUid: doc.id,
      customDomain: typeof d.customDomain === 'string' ? d.customDomain : '',
      status:       (d.customDomainStatus ?? 'pending') as CustomDomainStatus,
      sslStatus:    d.customDomainSslStatus ?? null,
      verifiedAt:   tsToISO(d.customDomainVerifiedAt),
    }
  }).filter(r => r.customDomain)
    .sort((a, b) => a.customDomain.localeCompare(b.customDomain))
}
