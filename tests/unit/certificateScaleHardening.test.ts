// RD-CERT-SCALE-01 · certificate issuance continuation, live-event throttling, size guard.
//
// Three independent hardenings, one file because they share a single premise: a 10,000-attendee
// event breaks things that are invisible at 10.
//
//   D1 — issuance ran at one 45s chunk per 5-minute tick (a 15% duty cycle) and went faster
//        ONLY while an organizer held the dashboard open. Throughput must not depend on human
//        attention.
//   D2 — the lookup/download throttles were keyed on client IP alone. A venue shares one NAT
//        address, so the control aimed at an enumerator was denying attendees their own
//        certificates.
//   D3 — nothing observed certificate size. Production measured ~5.7 MB average against a
//        1–2 MB target, and nothing said so.
//
// What is NOT changed is as important: page size, concurrency, budget, lease, the signed-URL
// TTL, gate order, R2 as the only binary store, and the D1/D2/D3 job invariants.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const JOBS       = strip(read('lib/certificates/jobs.ts'))
const CRON       = strip(read('app/api/cron/certificate-jobs/route.ts'))
const ARTIFACT   = strip(read('lib/certificates/artifact.ts'))
const CONSTANTS  = read('lib/certificates/constants.ts')
const LOOKUP     = strip(read('app/api/events/[slug]/certificates/lookup/route.ts'))

const DOWNLOAD_ROUTES = [
  'app/api/certificates/[certificateId]/file/route.ts',
  'app/api/certificates/[certificateId]/file/personalized/route.ts',
  'app/api/certificates/[certificateId]/route.ts',
  'app/api/certificates/download/[registrationId]/route.ts',
]

// ─── D1 · automatic continuation ─────────────────────────────────────────────

describe('D1 · certificate issuance continues without a human', () => {
  it('the certificate runner opts into the lease hand-off', () => {
    expect(JOBS).toContain('releaseLeaseOnHandoff: true')
  })

  it('reuses the EXISTING continuation primitives — no second system', () => {
    expect(CRON).toContain("from '@/lib/jobs/continuation'")
    expect(CRON).toContain('readChainDepth')
    expect(CRON).toContain('shouldChain')
    expect(CRON).toContain('triggerChain')
    // Identical mechanism to the hardened broadcast crons.
    const wa = strip(read('app/api/cron/whatsapp-broadcasts/route.ts'))
    for (const token of ['readChainDepth(req.headers)', 'shouldChain({ advanced, nonTerminal, depth })']) {
      expect(CRON, token).toContain(token)
      expect(wa, token).toContain(token)
    }
  })

  it('dispatches the continuation once, after the response, via after()', () => {
    expect(CRON).toContain("import { after } from 'next/server'")
    expect(CRON).toContain("if (chain === 'dispatched') after(() => triggerChain(SELF_PATH, depth))")
    // Exactly one dispatch site — a second would double the chain each hop.
    expect(CRON.match(/triggerChain\(/g) ?? []).toHaveLength(1)
    expect(CRON).toContain("const SELF_PATH      = '/api/cron/certificate-jobs'")
  })

  it('a finished batch does NOT chain, and neither does one that made no progress', () => {
    // Both are shouldChain's own guards; asserted here because this cron now depends on them.
    const cont = read('lib/jobs/continuation.ts')
    expect(cont).toContain("if (d.advanced <= 0)            return 'skipped_no_progress'")
    expect(cont).toContain("if (d.nonTerminal <= 0)         return 'skipped_terminal'")
    expect(cont).toContain("if (d.depth >= MAX_CHAIN_DEPTH) return 'skipped_max_depth'")
    // The cron feeds it real work done and real work remaining.
    expect(CRON).toContain('advanced += r.processed')
    expect(CRON).toContain('if (!r.done) nonTerminal++')
  })

  it('ZIP jobs on the same tick also count toward the decision', () => {
    // A half-built ZIP is as much a reason to return as a half-issued batch.
    expect(CRON.match(/advanced \+= r\.processed/g) ?? []).toHaveLength(2)
    expect(CRON.match(/if \(!r\.done\) nonTerminal\+\+/g) ?? []).toHaveLength(2)
  })

  it('only a CHAINED invocation waits out a busy lease', () => {
    // On a scheduled tick `busy` means another driver genuinely owns the job — skip it.
    expect(CRON).toContain('while (depth > 0 && r.reason === \'busy\'')
    expect(CRON).toContain('BUSY_RETRY_MAX_MS')
  })

  it('a failed dispatch is not a job failure — cron and reaper still resume', () => {
    const cont = read('lib/jobs/continuation.ts')
    expect(cont).toContain('never throws')
    // The cron does not await or branch on the dispatch result.
    expect(CRON).not.toContain('await triggerChain')
  })

  it('does NOT alter page size, concurrency, budget or lease', () => {
    expect(JOBS).toContain('pageSize:    BULK_PAGE_SIZE')
    expect(JOBS).toContain('budgetMs:    BULK_TIME_BUDGET_MS')
    expect(JOBS).toContain('leaseMs:     BULK_LEASE_MS')
    expect(JOBS).toContain('concurrency: BULK_CONCURRENCY')
    expect(CONSTANTS).toContain('export const BULK_PAGE_SIZE = 25')
    expect(CONSTANTS).toContain('export const BULK_CONCURRENCY = 6')
    expect(CONSTANTS).toContain('export const BULK_TIME_BUDGET_MS = 45_000')
    expect(CONSTANTS).toContain('export const BULK_LEASE_MS = 120_000')
  })

  it('cursor, fencing and idempotency are untouched', () => {
    expect(JOBS).toContain('runJobChunk(jobId, certificateJobStrategy(ctx)')
    const gen = read('lib/certificates/generate.ts')
    expect(gen).toContain('const existing = await findCertificate(eventId, registrationId, certificateType)')
    expect(gen).toContain('if (existing) return { certificate: existing, created: false }')
    expect(gen).toContain('CertificateInProgressError')
  })

  it('the shared D1/D2 job invariants still hold', () => {
    const runner = read('lib/jobs/runner.ts')
    expect(runner).toContain('const releaseLease = config.releaseLeaseOnHandoff === true && yieldingNow')
    expect(runner).toContain('if (yieldingNow) break')
    expect(runner.match(/Date\.now\(\) - startedAt >= config\.budgetMs/g) ?? []).toHaveLength(1)
    const kernel = read('lib/jobs/kernel.ts')
    expect(kernel.indexOf('c.expectedLeaseTag === 0'))
      .toBeLessThan(kernel.indexOf('currentTag !== c.expectedLeaseTag'))
  })
})

// ─── D2 · shared-NAT throttling ──────────────────────────────────────────────

describe('D2 · a venue behind one NAT address is not throttled as one attendee', () => {
  it('certificateLookup is keyed on IP AND the supplied identifier', () => {
    expect(LOOKUP).toContain('checkPolicy(`${getClientIp(req)}|${lookupKey}`, RATE_POLICY.certificateLookup)')
    expect(LOOKUP).not.toContain('checkPolicy(getClientIp(req), RATE_POLICY.certificateLookup)')
  })

  it('every distinct lookup mode gets its own bucket, prefixed so they cannot collide', () => {
    for (const prefix of ['e:${email}', 'r:${registrationId}', 'm:${', 'b:${bibNumber}', 't:${ticketCode}']) {
      expect(LOOKUP, prefix).toContain(prefix)
    }
  })

  it('the identifier is normalized with the EXISTING helper, so case cannot double the allowance', () => {
    // email is lower-cased upstream; the phone uses the same normalizer the query uses.
    expect(LOOKUP).toContain('body.email === \'string\' ? body.email.trim().toLowerCase()')
    expect(LOOKUP).toContain('normalizePhoneNumber(mobile)')
    expect(LOOKUP).toContain("from '@/lib/communication/phone'")
  })

  it('the LIMIT and WINDOW are unchanged — this is a re-key, not a widening', () => {
    const policies = read('lib/rateLimit/policies.ts')
    expect(policies).toContain("certificateLookup: { route: 'certificate-lookup', limit: 15, windowMs: MIN }")
    expect(policies).toContain("pdfDownload:     { route: 'pdf-download',      limit: 60, windowMs: MIN }")
  })

  it('all four certificate download routes key on IP + the certificate', () => {
    for (const p of DOWNLOAD_ROUTES) {
      const src = strip(read(p))
      expect(src, p).not.toContain('checkPolicy(getClientIp(req), RATE_POLICY.pdfDownload)')
      expect(src.match(/checkPolicy\(/g) ?? [], p).toHaveLength(1)
      expect(src, p).toMatch(/checkPolicy\(`\$\{getClientIp\(req\)\}\|\$\{(certificateId|registrationId)\}`, RATE_POLICY\.pdfDownload\)/)
      expect(src, p).toContain('if (rl.limited)')   // the guard survived the move
    }
  })

  it('the throttle still runs BEFORE any Firestore read or gate', () => {
    const src = strip(read('app/api/certificates/[certificateId]/file/route.ts'))
    const throttle = src.indexOf('checkPolicy(')
    for (const later of ['getCertificate(', 'getSettings(', 'signCertificateArtifact(']) {
      expect(src.indexOf(later), later).toBeGreaterThan(throttle)
    }
  })

  it('no second rate limiter was introduced', () => {
    for (const p of [...DOWNLOAD_ROUTES, 'app/api/events/[slug]/certificates/lookup/route.ts']) {
      expect(read(p), p).toContain("from '@/lib/rateLimit/policies'")
      expect(strip(read(p)), p).not.toContain('new Map<')
    }
  })

  it('authorization and the signed-URL path are untouched', () => {
    const src = read('app/api/certificates/[certificateId]/file/route.ts')
    expect(src).toContain("if (cert.status === 'revoked')")
    expect(src).toContain('isOrganizer = uid === cert.organizerUid')
    expect(src).toContain('if (!download.enabled)')
    expect(src).toContain('if (!download.allowAttendee)')
    expect(src).toContain('if (download.requireVerification)')
    expect(src).toContain('verifyCertificateDownloadCapability')
    expect(src).toContain('timingSafeEqualStr(token, cert.verificationToken)')
    expect(src).toContain('await signCertificateArtifact(cert.fileKey, cert.certificateId)')
    expect(src).toContain('status: 302')
  })
})

// ─── D3 · size observability ─────────────────────────────────────────────────

describe('D3 · certificate size is observed, never enforced', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => warn.mockClear())

  it('the target constant is 2 MB, in the repo’s existing byte convention', () => {
    expect(CONSTANTS).toContain('export const CERTIFICATE_TARGET_MAX_BYTES = 2 * 1024 * 1024')
  })

  it('the check lives at the single R2 upload chokepoint', () => {
    expect(ARTIFACT).toContain('if (result.metadata.size > CERTIFICATE_TARGET_MAX_BYTES)')
    // ONE comparison and ONE warning — not a count of the constant, which also appears in the
    // import and in the logged fields.
    expect(ARTIFACT.match(/result\.metadata\.size > CERTIFICATE_TARGET_MAX_BYTES/g) ?? []).toHaveLength(1)
    expect(ARTIFACT.match(/console\.warn\(/g) ?? []).toHaveLength(1)
    // And nowhere else in the certificate module duplicates the size policy.
    expect(strip(read('lib/certificates/generate.ts'))).not.toContain('CERTIFICATE_TARGET_MAX_BYTES')
  })

  it('an oversized certificate is still STORED and returned unchanged', () => {
    // The warning sits AFTER the upload and BEFORE the return; no branch skips either.
    const up  = ARTIFACT.indexOf('await storage.upload(')
    const chk = ARTIFACT.indexOf('CERTIFICATE_TARGET_MAX_BYTES)')
    const ret = ARTIFACT.indexOf('return { fileKey: result.metadata.path')
    expect(up).toBeLessThan(chk)
    expect(chk).toBeLessThan(ret)
    // Nothing throws, rejects or re-renders on the oversize path.
    const branch = ARTIFACT.slice(chk, ret)
    for (const bad of ['throw', 'return', 'StorageError', 'render']) {
      expect(branch, bad).not.toContain(bad)
    }
  })

  it('the warning exposes no certificate bytes and no attendee PII', () => {
    const chk = ARTIFACT.indexOf('CERTIFICATE_TARGET_MAX_BYTES)')
    const branch = ARTIFACT.slice(chk, ARTIFACT.indexOf('return { fileKey'))
    for (const leak of ['bytes)', 'body', 'attendee', 'email', 'name', 'registrationId', 'eventName', 'base64']) {
      expect(branch, leak).not.toContain(leak)
    }
    // Only the key, the size and the target.
    expect(branch).toContain('fileKey:')
    expect(branch).toContain('bytes:')
    expect(branch).toContain('targetBytes:')
  })

  it('does NOT add server-side image processing', () => {
    const pkg = read('package.json')
    for (const dep of ['"sharp"', '"jimp"', '"canvas"']) {
      expect(pkg, dep).not.toContain(dep)
    }
    expect(ARTIFACT).not.toContain('resize')
  })
})

// ─── Storage architecture is preserved ───────────────────────────────────────

describe('the storage architecture is unchanged', () => {
  it('R2 remains the only binary store, keys and visibility untouched', () => {
    expect(ARTIFACT).toContain("type:       'event-certificate',")
    expect(ARTIFACT).toContain("visibility: 'SIGNED_URL',")
    expect(ARTIFACT).toContain('expiresIn: ARTIFACT_SIGNED_URL_TTL_S')
    expect(CONSTANTS).toContain('export const ARTIFACT_SIGNED_URL_TTL_S = 300')
    expect(read('features/platform-storage/providers/index.ts'))
      .toContain("export const DEFAULT_PROVIDER_ID: StorageProviderId = 'cloudflare-r2'")
  })

  it('no Firebase Storage write and no certificate bytes in Firestore', () => {
    for (const p of ['lib/certificates/artifact.ts', 'lib/certificates/jobs.ts', ...DOWNLOAD_ROUTES]) {
      const src = strip(read(p))
      for (const bad of ['getStorage(', 'firebase-admin/storage', '.bucket(']) {
        expect(src, `${p} :: ${bad}`).not.toContain(bad)
      }
    }
  })

  it('the download path still redirects and never streams the PDF', () => {
    const src = strip(read('app/api/certificates/[certificateId]/file/route.ts'))
    expect(src).toContain('NextResponse.redirect(new URL(url)')
    expect(src).not.toContain('resolveUrl')
    expect(src).not.toContain('publicUrl')
  })
})
