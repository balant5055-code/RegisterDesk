// RD-ANALYTICS-12-03 — who may reach a generated report export.
//
// ═══ THE SECURITY PROPERTY UNDER TEST ════════════════════════════════════════
// The report's permission gated GENERATION and was then never checked again. Poll, process,
// cancel and download asked only "are you in the owning workspace?", so any member holding a
// `rex_<uuid>` could reach a financial export they could not have created — and the download
// route additionally bypassed `authorizeAnyWorkspace`, so accounts "limited to event check-in"
// were not excluded either. The only thing preventing disclosure was the entropy of the job
// id: an identifier standing in for an authorization check.
//
// ═══ WHY THESE RUN THE REAL HANDLERS ═════════════════════════════════════════
// Testing `permissionForExportJob` alone would prove the lookup and let the ROUTES regress,
// which is exactly how this defect arrived. Only `verifyCaller`/`activeMemberships` and
// Firestore are stubbed; `authorizeAnyWorkspace`, `resolveWorkspaceUid`, `permissionsForRole`,
// `isCheckinOnlyRole`, the registry and all four handlers are the real thing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import type { TeamRole } from '@/lib/team/types'

const OWNER = 'org-owner-1'
const OTHER = 'org-owner-2'

const state = {
  callerUid: OWNER,
  /** null ⇒ no membership row, which resolveWorkspaceUid reads as "owns their own". */
  membership: null as { organizerUid: string; role: TeamRole } | null,
  ownsDrafts: true,
  job: null as Record<string, unknown> | null,
}

vi.mock('@/lib/team/access', () => ({
  verifyCaller: async () => (state.callerUid ? { uid: state.callerUid } : null),
  activeMemberships: async () => (state.membership
    ? [{ organizerUid: state.membership.organizerUid, role: state.membership.role,
         eventIds: [], isStaffCredential: false }]
    : []),
  requirePermission: async () => ({ ok: true }),
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    // ownsWorkspace() → users/{uid}/eventDrafts
    collection: () => ({
      doc: () => ({
        collection: () => ({ limit: () => ({ get: async () => ({ empty: !state.ownsDrafts }) }) }),
        get: async () => ({ exists: state.job !== null, data: () => state.job }),
      }),
    }),
    doc: () => ({ get: async () => ({ exists: state.job !== null, data: () => state.job }) }),
  },
}))

vi.mock('@/lib/jobs/kernel', () => ({
  cancelJob: async () => 'cancelled',
  getJob:    async () => state.job,
}))

/**
 * RD-ANALYTICS-12-04 · ONLY the cloud signing call is stubbed.
 *
 * V4 signing needs the service-account private key, and the Admin SDK is initialised without
 * one under the emulator — so the signature itself cannot be produced locally. Everything
 * around it is real: authorization, job lookup, permission resolution, lifecycle checks, TTL
 * arithmetic and the redirect. The stub records what the route ASKED for, which is what the
 * assertions are about.
 */
const signCalls: Array<{ path: string; expiresInSeconds: number; filename?: string; contentType?: string }> = []
let signShouldFail = false
vi.mock('@/lib/firebase/storage/admin', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/firebase/storage/admin')>()
  return {
    ...real,   // keeps the real SIGNED_URL_MAX_SECONDS, so the ceiling under test is production's
    signedReadUrl: async (path: string, opts: { expiresInSeconds: number; filename?: string; contentType?: string }) => {
      signCalls.push({ path, ...opts })
      if (signShouldFail) throw new Error('no signing credential')
      return `https://storage.googleapis.com/bucket/${path}?X-Goog-Signature=deadbeef&X-Goog-Expires=${opts.expiresInSeconds}`
    },
  }
})
vi.mock('@/lib/reports/exportJob', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/reports/exportJob')>()
  return {
    ...real,
    // The job READ is stubbed; `permissionForExportJob` and the types stay real.
    getReportExportJob: async () => state.job,
    processReportExportChunk: async () => ({ status: 'completed', processed: 1 }),
    toExportJobView: (j: unknown) => j,
  }
})

const { GET: download } = await import('@/app/api/organizer/reports/exports/[jobId]/download/route')
const { GET: poll }     = await import('@/app/api/organizer/reports/exports/[jobId]/route')
const { POST: process_ } = await import('@/app/api/organizer/reports/exports/[jobId]/process/route')
const { POST: cancel }  = await import('@/app/api/organizer/reports/exports/[jobId]/cancel/route')

const params = { params: Promise.resolve({ jobId: 'rex_test' }) }
const req = () => new NextRequest('http://localhost/api/organizer/reports/exports/rex_test/download')

/** A completed, in-date export of `kind`, owned by `owner`. */
const job = (kind: string, owner = OWNER, over: Record<string, unknown> = {}) => ({
  jobId: 'rex_test', organizerUid: owner, kind, format: 'csv', status: 'completed',
  counts: { succeeded: 1 },
  output: {
    url: 'https://firebasestorage.googleapis.com/v0/b/b/o/reportExports%2Ff.csv?alt=media&token=t',
    path: 'reportExports/f.csv', filename: 'f.csv', contentType: 'text/csv',
    rowCount: 1, truncated: false,
    expiresAt: { toMillis: () => Date.now() + 3_600_000 },
  },
  ...over,
})

/** Become a member of OWNER's workspace with this role. */
const asRole = (role: TeamRole) => {
  state.callerUid = `member-${role}`
  state.membership = { organizerUid: OWNER, role }
  state.ownsDrafts = false          // a member is not themselves an owner
}

const asOwner = () => {
  state.callerUid = OWNER
  state.membership = null
  state.ownsDrafts = true
}

beforeEach(() => {
  asOwner()
  state.job = job('transactions')
  signCalls.length = 0
  signShouldFail = false
})

// ─── RD-ANALYTICS-12-04 · what the browser actually receives ──────────────────

describe('RD-ANALYTICS-12-04 · the redirect is a short-lived signed URL', () => {
  const location = (res: Response) => res.headers.get('location') ?? ''

  it('29 · the URL carries a signature, not a Firebase download token', async () => {
    const res = await download(req(), params)
    expect(res.status).toBe(302)
    expect(location(res)).toContain('X-Goog-Signature')
    expect(location(res)).not.toContain('firebasestorage.googleapis.com')
    expect(location(res)).not.toContain('alt=media')
    expect(location(res)).not.toContain('token=')
  })

  it('30 · no Firebase ID token appears anywhere in the redirect', async () => {
    const res = await download(req(), params)
    for (const probe of [/idToken/i, /access_token/i, /Bearer/i, /eyJ/]) {
      expect(location(res), String(probe)).not.toMatch(probe)
    }
  })

  it('31 · it is 302 and must never be cached', async () => {
    const res = await download(req(), params)
    expect(res.status).toBe(302)          // never 301 — a cached permanent redirect would
    expect(res.status).not.toBe(301)      // pin the browser to one expiring signature
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('32 · the signer is asked for the job\'s OWN stored path, never client input', async () => {
    await download(req(), params)
    expect(signCalls).toHaveLength(1)
    expect(signCalls[0].path).toBe('reportExports/f.csv')
    expect(signCalls[0].filename).toBe('f.csv')
    expect(signCalls[0].contentType).toBe('text/csv')
  })

  it('33 · TTL never exceeds 300 seconds', async () => {
    // The job here expires in an hour, so the ceiling — not the job — is the binding bound.
    await download(req(), params)
    expect(signCalls[0].expiresInSeconds).toBeLessThanOrEqual(300)
    expect(signCalls[0].expiresInSeconds).toBe(300)
  })

  it('34 · TTL is bounded by the report\'s REMAINING life when that is shorter', async () => {
    // 45 seconds left: a 300s signature would outlive the report the API is about to refuse.
    state.job = job('transactions', OWNER, {
      output: { ...job('transactions').output as object, expiresAt: { toMillis: () => Date.now() + 45_000 } },
    })
    await download(req(), params)
    expect(signCalls[0].expiresInSeconds).toBeLessThanOrEqual(45)
    expect(signCalls[0].expiresInSeconds).toBeGreaterThan(0)
  })

  it('35 · signing failure fails safe — 503, no capability-URL fallback', async () => {
    signShouldFail = true
    const res = await download(req(), params)
    expect(res.status).toBe(503)
    expect(res.headers.get('location')).toBeNull()
    const body = await res.json()
    // Neither the storage path nor the underlying error reaches the caller.
    expect(JSON.stringify(body)).not.toMatch(/reportExports|credential|firebasestorage/)
  })

  it('36 · nothing is signed until every authorization check has passed', async () => {
    asRole('manager')
    const res = await download(req(), params)
    expect(res.status).toBe(404)
    expect(signCalls).toHaveLength(0)     // storage was never touched
  })

  it('37 · nor for a gate-only role, an expired job, or one with no output', async () => {
    asRole('checkin_staff')
    await download(req(), params)
    asOwner()
    state.job = job('transactions', OWNER, {
      output: { ...job('transactions').output as object, expiresAt: { toMillis: () => Date.now() - 1 } },
    })
    await download(req(), params)
    state.job = job('transactions', OWNER, { output: undefined })
    await download(req(), params)
    state.job = job('transactions', OWNER, { status: 'cancelled' })
    await download(req(), params)
    expect(signCalls).toHaveLength(0)
  })
})

// ─── A · the authorized case still works ──────────────────────────────────────

describe('RD-ANALYTICS-12-03 · A · an authorized caller still downloads', () => {
  it('1 · the owner, who holds `transactions`, is redirected to the file', async () => {
    // RE-ANCHORED (RD-ANALYTICS-12-04). This asserted the Firebase capability host, which was
    // the delivery mechanism at the time. The authorized outcome is unchanged — a redirect to
    // the file — but the URL is now a short-lived signature. See test 29.
    const res = await download(req(), params)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('X-Goog-Signature')
  })

  it('2 · a finance member holds `transactions` and is also allowed', async () => {
    asRole('finance')
    const res = await download(req(), params)
    expect(res.status).toBe(302)
  })

  it('3 · every non-financial report is reachable by the role that owns its permission', async () => {
    asRole('finance')                       // wallet + settlements + transactions
    for (const kind of ['settlements', 'wallet-ledger', 'broadcast-usage', 'gst', 'refunds']) {
      state.job = job(kind)
      const res = await download(req(), params)
      expect(res.status, kind).toBe(302)
    }
  })
})

// ─── B · fail-closed on an unknown kind ───────────────────────────────────────

describe('RD-ANALYTICS-12-03 · B · a report with no registry entry is refused', () => {
  it('4 · even the OWNER is denied when the kind resolves to no permission', async () => {
    // The owner holds every permission, so "owner without permission" cannot arise from a
    // role. The reachable failure is a kind the registry does not define — which must be a
    // refusal, never "no permission required".
    state.job = job('not-a-real-report')
    const res = await download(req(), params)
    expect(res.status).toBe(404)
  })
})

// ─── C–F · roles that must NOT reach a financial export ───────────────────────

describe('RD-ANALYTICS-12-03 · C–F · non-financial roles are refused', () => {
  it('5 · admin — holds events, never `transactions`', async () => {
    asRole('admin')
    expect((await download(req(), params)).status).toBe(404)
  })

  it('6 · manager — the role the audit named', async () => {
    asRole('manager')
    expect((await download(req(), params)).status).toBe(404)
  })

  it('7 · checkin_lead — a gate role, refused before the job is even read', async () => {
    asRole('checkin_lead')
    const res = await download(req(), params)
    // 403 from the gate-role exclusion in authorizeAnyWorkspace, which the download route
    // previously bypassed entirely by calling verifyCaller/resolveWorkspaceUid directly.
    expect(res.status).toBe(403)
  })

  it('8 · checkin_staff — likewise', async () => {
    asRole('checkin_staff')
    expect((await download(req(), params)).status).toBe(403)
  })

  it('9 · the refusal reveals neither the export nor its kind', async () => {
    asRole('manager')
    const body = await (await download(req(), params)).json()
    expect(body.error).toBe('Export not found')
    expect(JSON.stringify(body)).not.toMatch(/transactions|permission|financial/i)
  })
})

// ─── G · revocation ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-03 · G · permission removed after generation', () => {
  it('10 · a caller who loses `transactions` can no longer download', async () => {
    asRole('finance')
    expect((await download(req(), params)).status).toBe(302)   // before

    // The same person, same job, same session — only the role has changed.
    state.membership = { organizerUid: OWNER, role: 'manager' }
    expect((await download(req(), params)).status).toBe(404)   // after
  })
})

// ─── H, I · isolation ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-03 · H,I · cross-workspace and cross-owner', () => {
  it('11 · a different workspace cannot reach the job', async () => {
    state.job = job('transactions', OTHER)
    expect((await download(req(), params)).status).toBe(404)
  })

  it('12 · a finance member of ANOTHER workspace is still refused', async () => {
    state.callerUid = 'member-finance-2'
    state.membership = { organizerUid: OTHER, role: 'finance' }
    state.ownsDrafts = false
    state.job = job('transactions', OWNER)
    expect((await download(req(), params)).status).toBe(404)
  })

  it('13 · a missing job is indistinguishable from a forbidden one', async () => {
    state.job = null
    expect((await download(req(), params)).status).toBe(404)
  })
})

// ─── J, K · lifecycle behaviour must be unchanged ─────────────────────────────

describe('RD-ANALYTICS-12-03 · J,K · existing lifecycle answers are preserved', () => {
  it('14 · an expired link is still 410', async () => {
    state.job = job('transactions', OWNER, {
      output: { ...job('transactions').output as object, expiresAt: { toMillis: () => Date.now() - 1 } },
    })
    expect((await download(req(), params)).status).toBe(410)
  })

  it('15 · a cancelled export is still 410', async () => {
    state.job = job('transactions', OWNER, { status: 'cancelled' })
    expect((await download(req(), params)).status).toBe(410)
  })

  it('16 · a job with no output yet is still 409', async () => {
    state.job = job('transactions', OWNER, { output: undefined })
    expect((await download(req(), params)).status).toBe(409)
  })

  it('17 · the permission check runs BEFORE the lifecycle checks leak state', async () => {
    // An unauthorized caller must not learn that an export exists but expired.
    asRole('manager')
    state.job = job('transactions', OWNER, {
      output: { ...job('transactions').output as object, expiresAt: { toMillis: () => Date.now() - 1 } },
    })
    expect((await download(req(), params)).status).toBe(404)   // not 410
  })
})

// ─── The three sibling routes carry the same boundary ─────────────────────────

describe('RD-ANALYTICS-12-03 · poll, process and cancel enforce it too', () => {
  it('18 · a manager cannot poll a financial export', async () => {
    asRole('manager')
    expect((await poll(req(), params)).status).toBe(404)
  })

  it('19 · a manager cannot drive generation — the most expensive call here', async () => {
    asRole('manager')
    expect((await process_(req(), params)).status).toBe(404)
  })

  it('20 · a manager cannot cancel someone else\'s financial export', async () => {
    asRole('manager')
    expect((await cancel(req(), params)).status).toBe(404)
  })

  it('21 · finance still can do all three', async () => {
    asRole('finance')
    expect((await poll(req(), params)).status).toBe(200)
    expect((await process_(req(), params)).status).toBe(200)
    expect((await cancel(req(), params)).status).toBe(200)
  })
})

// ─── Negative control: what the PRE-FIX boundary would have done ─────────────
//
// Without this, every assertion above could pass against a route that never had the defect,
// and the suite would prove nothing about the fix. This reconstructs the old check —
// `resolveWorkspaceUid` plus an ownership comparison, which is literally what the route did —
// and shows it ADMITS the callers the real route now refuses. The gap between the two
// columns is the vulnerability that was closed.

describe('RD-ANALYTICS-12-03 · the pre-fix boundary would have allowed these', () => {
  /** The old route's entire authorization, verbatim in behaviour. */
  const preFixAllows = async (): Promise<boolean> => {
    const { resolveWorkspaceUid } = await import('@/lib/team/workspace')
    const ctx = await resolveWorkspaceUid(state.callerUid)
    const j = state.job as { organizerUid?: string } | null
    return Boolean(j && j.organizerUid === ctx.workspaceUid)
  }

  it('25 · a manager passed the old check, and is refused by the new one', async () => {
    asRole('manager')
    expect(await preFixAllows()).toBe(true)                      // the defect
    expect((await download(req(), params)).status).toBe(404)     // the fix
  })

  it('26 · checkin_staff passed the old check too — no gate exclusion was applied', async () => {
    asRole('checkin_staff')
    expect(await preFixAllows()).toBe(true)
    expect((await download(req(), params)).status).toBe(403)
  })

  it('27 · and the old check was indifferent to revocation', async () => {
    asRole('finance')
    state.membership = { organizerUid: OWNER, role: 'manager' }  // permission removed
    expect(await preFixAllows()).toBe(true)
    expect((await download(req(), params)).status).toBe(404)
  })

  it('28 · cross-workspace was the ONE thing the old check did get right', async () => {
    state.callerUid = 'member-finance-2'
    state.membership = { organizerUid: OTHER, role: 'finance' }
    state.ownsDrafts = false
    expect(await preFixAllows()).toBe(false)                     // never a cross-tenant hole
    expect((await download(req(), params)).status).toBe(404)
  })
})

// ─── The delivery mechanism is deliberately untouched by this phase ───────────

describe('RD-ANALYTICS-12-04 · the delivery mechanism has been replaced', () => {
  const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
  /**
   * Source with comments stripped.
   *
   * These files EXPLAIN the mechanism they replaced, naming `firebaseStorageDownloadTokens`
   * and `download?token=` in prose. A guard that searched the raw text would be failed by its
   * own documentation — so the assertions below read the code, not the commentary.
   */
  const src = (p: string) =>
    raw(p).replace(/\r\n/g, '\n')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const ROUTE = 'app/api/organizer/reports/exports/[jobId]/download/route.ts'

  // ═══ THESE THREE WERE INVERTED, NOT DELETED ════════════════════════════════
  // RD-ANALYTICS-12-03 deliberately PINNED the old behaviour so that a phase changing it had
  // to do so knowingly. 22 and 23 asserted the capability-URL redirect and the query-string
  // token; they now assert both are gone.

  it('22 · the route no longer redirects to the stored Firebase capability URL', () => {
    const s = src(ROUTE)
    expect(s).not.toContain('NextResponse.redirect(job.output.url)')
    expect(s).toContain('signedReadUrl(job.output.path')
  })

  it('23 · the query-string token path is gone — header auth only', () => {
    const s = src(ROUTE)
    expect(s).not.toContain("searchParams.get('token')")
    expect(s).not.toContain('Authorization: `Bearer ${qToken}`')
  })

  it('23b · no Firebase download-token URL is constructed anywhere on this path', () => {
    for (const p of [ROUTE, 'lib/reports/exportJob.ts']) {
      const s = src(p)
      expect(s, p).not.toMatch(/alt=media/)
      expect(s, p).not.toMatch(/firebaseStorageDownloadTokens/)
    }
  })

  it('23c · the job no longer PERSISTS a download URL', () => {
    const s = src('lib/reports/exportJob.ts')
    // The output written to Firestore carries `path`, never `url`.
    expect(s).toContain('path, filename: out.filename')
    expect(s).not.toMatch(/^\s*url,\s*path,/m)
    expect(s).not.toMatch(/const \{ url \} = await uploadServerFile/)
  })

  it('23d · the UI sends no credential in a URL', () => {
    const ui = src('app/(dashboard)/dashboard/finance/reports/page.tsx')
    expect(ui).not.toMatch(/download\?token=/)
    expect(ui).toContain("fetch(`/api/organizer/reports/exports/${jobId}/download`")
  })

  it('24 · the permission comes from the registry, not from a second list', () => {
    const s = src('lib/reports/exportJob.ts')
    expect(s).toContain('ORGANIZER_REPORTS[job.kind]?.permission')
    // No route may restate a permission for itself.
    for (const p of ['download', 'process', 'cancel']) {
      const r = src(`app/api/organizer/reports/exports/[jobId]/${p}/route.ts`)
      expect(r, p).not.toMatch(/'transactions'|'settlements'|'wallet'/)
    }
  })
})
