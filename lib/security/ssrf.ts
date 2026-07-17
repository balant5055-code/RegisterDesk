// SSRF protection for outbound organizer webhooks (P0-3). Server-only.
//
// Defense model (DNS-rebinding resistant):
//   1. validateWebhookTarget(url) — parse, require https, resolve ALL A+AAAA
//      records and reject if ANY resolves to a private/internal address. Used at
//      save-time and as a fast pre-fetch gate. Fails CLOSED on DNS errors.
//   2. ssrfSafeLookup — a custom DNS lookup wired into the undici connector so the
//      ACTUAL address undici connects to is re-validated at connection time. This
//      closes the TOCTOU window a save-time-only check leaves open (an attacker's
//      DNS can return a public IP at save/validate and an internal IP at connect).
//
// We validate RESOLVED ADDRESSES, never just the hostname, and handle IPv4, IPv6,
// IPv4-mapped/compat IPv6, and NAT64.

import { resolve4, resolve6 } from 'node:dns/promises'
import dns from 'node:dns'
import net from 'node:net'

export type SsrfErrorCode = 'INVALID_URL' | 'NOT_HTTPS' | 'BLOCKED_HOST' | 'BLOCKED_ADDRESS' | 'DNS_FAILURE'
export interface SsrfSuccess { ok: true; hostname: string; addresses: { address: string; family: number }[] }
export interface SsrfFailure { ok: false; error: SsrfErrorCode; reason: string }
export type SsrfResult = SsrfSuccess | SsrfFailure

const fail = (error: SsrfErrorCode, reason: string): SsrfFailure => ({ ok: false, error, reason })

// ─── IPv4 classification ───────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

// All ranges that must never be a webhook target. Includes every CIDR in the spec
// plus broadcast / reserved / multicast (never valid public destinations).
const V4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],        // "this" network (incl. 0.0.0.0)
  ['10.0.0.0', 8],       // RFC1918 private
  ['100.64.0.0', 10],    // CGNAT (RFC6598)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12],    // RFC1918 private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // RFC1918 private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved (incl. 255.255.255.255 broadcast)
]

function isBlockedIpv4Int(n: number): boolean {
  for (const [netStr, bits] of V4_BLOCKS) {
    const netInt = ipv4ToInt(netStr)!
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if (((n & mask) >>> 0) === ((netInt & mask) >>> 0)) return true
  }
  return false
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  return n === null ? true : isBlockedIpv4Int(n)   // unparseable → fail closed
}

// ─── IPv6 classification ───────────────────────────────────────────────────────

function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone)   // strip scope id

  // Convert an embedded IPv4 tail (::ffff:1.2.3.4 / 64:ff9b::1.2.3.4) to two hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':')
    if (lastColon < 0) return null
    const v4 = ipv4ToInt(s.slice(lastColon + 1))
    if (v4 === null) return null
    s = s.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16)
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []

  let groups: string[]
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length)
    if (missing < 0) return null
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null

  let n = BigInt(0)
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16))
  }
  return n
}

const V6_ALL_ONES = (BigInt(1) << BigInt(128)) - BigInt(1)

function inV6Cidr(ipBig: bigint, netStr: string, bits: number): boolean {
  const netBig = ipv6ToBigInt(netStr)
  if (netBig === null) return false
  const mask = V6_ALL_ONES ^ ((BigInt(1) << BigInt(128 - bits)) - BigInt(1))
  return (ipBig & mask) === (netBig & mask)
}

const V6_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['::1', 128],        // loopback
  ['::', 128],         // unspecified
  ['fc00::', 7],       // unique local (fc00::/7, incl. fd00::/8)
  ['fe80::', 10],      // link-local
  ['ff00::', 8],       // multicast
]

function isBlockedIpv6(ip: string): boolean {
  const n = ipv6ToBigInt(ip)
  if (n === null) return true   // unparseable → fail closed

  // IPv4-mapped (::ffff:0:0/96), IPv4-compat (::/96) and NAT64 (64:ff9b::/96)
  // embed a v4 address in the low 32 bits — classify by that v4.
  if (inV6Cidr(n, '::ffff:0:0', 96) || inV6Cidr(n, '64:ff9b::', 96) || inV6Cidr(n, '::', 96)) {
    if (isBlockedIpv4Int(Number(n & BigInt(0xffffffff)) >>> 0)) return true
  }
  return V6_BLOCKS.some(([netStr, bits]) => inV6Cidr(n, netStr, bits))
}

/** True if an IP literal is private/internal/reserved (or not a valid IP). */
export function isBlockedAddress(ip: string): boolean {
  const fam = net.isIP(ip)
  if (fam === 4) return isBlockedIpv4(ip)
  if (fam === 6) return isBlockedIpv6(ip)
  return true   // not a valid IP → fail closed
}

// ─── Host + URL validation ─────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set(['localhost'])

/** Resolve every A/AAAA record for a hostname and reject if ANY is internal.
 *  A literal IP is validated directly (no DNS). Fails closed when nothing resolves. */
export async function resolveAndValidateHost(hostname: string): Promise<SsrfResult> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').trim().toLowerCase()
  if (!host) return fail('INVALID_URL', 'empty host')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) return fail('BLOCKED_HOST', host)

  // Literal IP — no DNS needed.
  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) return fail('BLOCKED_ADDRESS', host)
    return { ok: true, hostname: host, addresses: [{ address: host, family: net.isIP(host) }] }
  }

  const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)])
  const addresses: { address: string; family: number }[] = []
  if (v4.status === 'fulfilled') for (const a of v4.value) addresses.push({ address: a, family: 4 })
  if (v6.status === 'fulfilled') for (const a of v6.value) addresses.push({ address: a, family: 6 })

  // Fail closed: a target we cannot resolve to any public address is rejected.
  if (addresses.length === 0) return fail('DNS_FAILURE', `could not resolve ${host}`)
  for (const a of addresses) if (isBlockedAddress(a.address)) return fail('BLOCKED_ADDRESS', a.address)
  return { ok: true, hostname: host, addresses }
}

/** Validate a full webhook URL: https-only + resolved-address safety. */
export async function validateWebhookTarget(url: string): Promise<SsrfResult> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return fail('INVALID_URL', 'unparseable URL') }
  if (parsed.protocol !== 'https:') return fail('NOT_HTTPS', parsed.protocol || 'unknown')
  return resolveAndValidateHost(parsed.hostname)
}

// ─── Connection-time enforcement (DNS-rebinding defense) ───────────────────────

/** Drop-in for undici's `connect.lookup`. Resolves the host, validates EVERY
 *  candidate address, and only hands back a validated one — so the socket can
 *  never connect to an internal address even if DNS changed since pre-validation.
 *  On any blocked address or DNS error it fails closed (errors the connection). */
export function ssrfSafeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = Array.isArray(addresses) ? addresses : [addresses]
    if (list.length === 0) return callback(new Error('SSRF_NO_ADDRESS') as NodeJS.ErrnoException, '', 0)
    for (const a of list) {
      if (isBlockedAddress(a.address)) {
        return callback(new Error(`SSRF_BLOCKED_ADDRESS:${a.address}`) as NodeJS.ErrnoException, '', 0)
      }
    }
    const chosen = list[0]
    callback(null, chosen.address, chosen.family)
  })
}
