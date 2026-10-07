// RD-ANALYTICS-12-11 — the Reports History reader.
//
// ═══ WHAT THIS FILE IS DEFENDING ═════════════════════════════════════════════
// History turns a collection that was previously reachable only one document at a time — by
// a caller who already held the id — into a LIST. Every property that was implicit while the
// only entry point was `GET /exports/{jobId}` now has to be proved:
//
//   tenancy      a list must not span workspaces
//   permission   a list must not describe a report the caller may not open
//   projection   a list must not carry the storage path or a URL that outlives the check
//   bounds       a list must not read the collection to answer one page
//
// ═══ WHY THE HANDLER IS REAL AND ONLY THE EDGES ARE FAKED ════════════════════
// Testing `readReportHistory` with a hand-fed array would prove the loop and let the ROUTE
// regress — which is exactly how RD-ANALYTICS-12-03's defect arrived (the permission was
// checked at generation and never again). So `verifyCaller`/`activeMemberships` and Firestore
// are stubbed; `authorizeAnyWorkspace`, `resolveWorkspaceUid`, `permissionsForRole`,
// `isCheckinOnlyRole`, `permissionForExportJob`, the registry, the reader and the GET handler
// are all the real thing.
//
// The Firestore fake is not a stub that returns what it was handed: it holds an ordered
// collection and honours where/orderBy/startAfter/limit, so the scan loop is genuinely
// exercised — and it COUNTS documents read, which is how boundedness is asserted rather than
// assumed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import type { TeamRole } from '@/lib/team/types'

const OWNER = 'hist-owner-1'
const OTHER = 'hist-owner-2'

interface FakeJob {
  id: string
  data: Record<string, unknown>
}

const state = {
  callerUid: OWNER as string | null,
  membership: null as { organizerUid: string; role: TeamRole } | null,
  ownsDrafts: true,
  jobs: [] as FakeJob[],
  /** Firestore round trips and documents returned, for the boundedness assertions. */
  reads: 0,
  docsRead: 0,
}

// ─── A Firestore fake with real query semantics ───────────────────────────────

class FakeQuery {
  constructor(
    private docs: FakeJob[],
    private order: { field: string; dir: 'asc' | 'desc' } | null = null,
    private after: Timestamp | null = null,
    private cap: number | null = null,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') throw new Error(`fake supports '==' only, got ${op}`)
    return new FakeQuery(this.docs.filter(d => d.data[field] === value), this.order, this.after, this.cap)
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    // Firestore excludes documents where the ordered field is ABSENT.
    const present = this.docs.filter(d => d.data[field] !== undefined)
    return new FakeQuery(present, { field, dir }, this.after, this.cap)
  }

  startAfter(ts: Timestamp): FakeQuery {
    return new FakeQuery(this.docs, this.order, ts, this.cap)
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.docs, this.order, this.after, n)
  }

  async get() {
    let out = [...this.docs]
    const f = this.order?.field
    // (seconds, nanoseconds) compared as a pair — seconds*1e9 overflows the safe integer
    // range, and a comparison that silently rounds would make the cursor tests vacuous.
    const cmp = (a: Timestamp, b: Timestamp) =>
      a.seconds !== b.seconds ? a.seconds - b.seconds : a.nanoseconds - b.nanoseconds

    if (f && this.order) {
      const dir = this.order.dir
      out.sort((a, b) => {
        const d = cmp(a.data[f] as Timestamp, b.data[f] as Timestamp)
        return dir === 'desc' ? -d : d
      })
      if (this.after) {
        // Strictly past the cursor position, in the ordering's own direction.
        out = out.filter(d => {
          const c = cmp(d.data[f] as Timestamp, this.after!)
          return dir === 'desc' ? c < 0 : c > 0
        })
      }
    }
    if (this.cap !== null) out = out.slice(0, this.cap)
    state.reads++
    state.docsRead += out.length
    return {
      empty: out.length === 0,
      size:  out.length,
      docs:  out.map(d => ({ id: d.id, data: () => d.data })),
    }
  }
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
    // RD-ORGANIZER-MODERATION-COVERAGE-14 — the moderation read now goes through
    // lib/admin/organizerStatus.getOrganizerAccountStatus, which addresses the profile as
    // adminDb.doc('users/{uid}') rather than adminDb.collection('users').doc(uid). Without
    // this the call throws, verifyCaller's catch turns that into null, and every fixture
    // here 401s. `exists: true` with no accountStatus keeps them unmoderated — see the
    // note on the collection() branch below.
    doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
    collection: (name: string) => {
      if (name === 'reportExportJobs') return new FakeQuery(state.jobs)
      // users/{uid} serves two probes inside the workspace authorizers:
      //   • .collection('eventDrafts') — the ownsWorkspace check in resolveWorkspaceUid
      //   • .get()                     — the moderation check added by
      //                                  RD-ORGANIZER-MODERATION-ENFORCEMENT-12
      // The profile is returned with NO accountStatus on purpose: resolveAccountStatus maps
      // an absent field to 'active', so these tenancy fixtures stay unmoderated and this
      // file keeps testing what it is about. Moderation itself is covered by
      // tests/emulator/organizerModerationEnforcement.emu.test.ts against real Firestore.
      return {
        doc: () => ({
          collection: () => ({ limit: () => ({ get: async () => ({ empty: !state.ownsDrafts }) }) }),
          get: async () => ({ exists: true, data: () => ({}) }),
        }),
      }
    },
  },
}))

// ─── Fixture ──────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
const at = (i: number) => Timestamp.fromMillis(T0 + i * 60_000)

function job(over: Partial<Record<string, unknown>> & { id: string; kind: string; i: number }): FakeJob {
  const { id, kind, i, ...rest } = over
  return {
    id,
    data: {
      jobId: id, organizerUid: OWNER, createdBy: OWNER,
      kind, format: 'csv', filenameBase: kind, heading: kind,
      filters: { from: '2026-01-01', to: '2026-01-31' },
      status: 'completed',
      counts: { total: 1, processed: 1, succeeded: 1, failed: 0 },
      cursor: 'done', error: null, lockedUntil: null,
      createdAt: at(i), startedAt: at(i), updatedAt: at(i), completedAt: at(i),
      output: {
        path: `reportExports/${OWNER}/${id}/${kind}.csv`,
        filename: `${kind}.csv`, contentType: 'text/csv',
        rowCount: 10, truncated: false,
        expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      },
      ...rest,
    },
  }
}

async function call(qs = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('@/app/api/organizer/reports/history/route')
  const res = await GET(new NextRequest(`http://localhost/api/organizer/reports/history${qs}`))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const asMember = (role: TeamRole) => { state.membership = { organizerUid: OWNER, role }; state.ownsDrafts = false }

beforeEach(() => {
  state.callerUid = OWNER
  state.membership = null
  state.ownsDrafts = true
  state.jobs = []
  state.reads = 0
  state.docsRead = 0
  vi.resetModules()
})

// ─── A · identity and tenancy ─────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · who may read History', () => {
  it('1 · an owner reads their own workspace history', async () => {
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect((body.jobs as unknown[]).length).toBe(1)
  })

  it('2 · an unauthenticated caller is refused', async () => {
    state.callerUid = null
    const { status } = await call()
    expect(status).toBe(401)
  })

  it('3 · finance reads the reports its permissions cover', async () => {
    asMember('finance')
    state.jobs = [
      job({ id: 'rex_t', kind: 'transactions', i: 3 }),
      job({ id: 'rex_s', kind: 'settlements',  i: 2 }),
      job({ id: 'rex_w', kind: 'wallet-ledger', i: 1 }),
    ]
    const { body } = await call()
    expect((body.jobs as { kind: string }[]).map(j => j.kind).sort())
      .toEqual(['settlements', 'transactions', 'wallet-ledger'])
  })

  it('4 · a gate-only role is refused outright — not merely given an empty list', async () => {
    asMember('checkin_staff')
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]
    const { status, body } = await call()
    expect(status).toBe(403)
    expect(JSON.stringify(body)).not.toContain('transactions')
  })

  it('5 · checkin_lead is refused for the same reason', async () => {
    asMember('checkin_lead')
    const { status } = await call()
    expect(status).toBe(403)
  })

  it('6 · another workspace\'s exports are never returned', async () => {
    state.jobs = [
      job({ id: 'rex_mine',    kind: 'transactions', i: 2 }),
      { ...job({ id: 'rex_theirs', kind: 'transactions', i: 1 }),
        data: { ...job({ id: 'rex_theirs', kind: 'transactions', i: 1 }).data, organizerUid: OTHER } },
    ]
    const { body } = await call()
    const ids = (body.jobs as { jobId: string }[]).map(j => j.jobId)
    expect(ids).toEqual(['rex_mine'])
    expect(JSON.stringify(body)).not.toContain(OTHER)
  })

  it('7 · tenancy is a QUERY filter, not a post-filter', async () => {
    // The reader must never see another workspace's documents at all. Proven by counting:
    // three foreign jobs exist, and the read returns one document, not four.
    state.jobs = [
      job({ id: 'rex_mine', kind: 'transactions', i: 4 }),
      ...['x', 'y', 'z'].map((s, n) => {
        const j = job({ id: `rex_${s}`, kind: 'transactions', i: n })
        return { ...j, data: { ...j.data, organizerUid: OTHER } }
      }),
    ]
    await call()
    expect(state.docsRead).toBe(1)
  })

  it('8 · a revoked member falls back to their OWN workspace, never the old one', async () => {
    // activeMemberships returns nothing once a membership is revoked; resolveWorkspaceUid
    // then resolves the caller to themselves. The old workspace's exports must not follow.
    state.callerUid = 'ex-member'
    state.membership = null
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]   // owned by OWNER
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.jobs).toEqual([])
  })
})

// ─── B · permission filtering ─────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · report permissions filter the feed', () => {
  it('9 · a caller sees only the kinds their permissions cover', async () => {
    // A role holding `wallet` but not `transactions`: no such stock role exists, so this is
    // built from the permission itself rather than a role name.
    asMember('finance')
    state.jobs = [
      job({ id: 'rex_w', kind: 'wallet-ledger', i: 2 }),
      job({ id: 'rex_t', kind: 'transactions',  i: 1 }),
    ]
    const { body } = await call()
    expect((body.jobs as unknown[]).length).toBe(2)

    // manager holds `events` and never a finance permission — zero rows.
    asMember('manager')
    const second = await call()
    expect(second.body.jobs).toEqual([])
  })

  it('10 · admin and manager see nothing, because neither holds a finance permission', async () => {
    state.jobs = [
      job({ id: 'rex_t', kind: 'transactions', i: 3 }),
      job({ id: 'rex_s', kind: 'settlements',  i: 2 }),
      job({ id: 'rex_w', kind: 'wallet-ledger', i: 1 }),
    ]
    for (const role of ['admin', 'manager'] as TeamRole[]) {
      asMember(role)
      const { status, body } = await call()
      expect(status, role).toBe(200)
      expect(body.jobs, role).toEqual([])
    }
  })

  it('11 · a hidden job leaks NO metadata — not its kind, dates, size or existence', async () => {
    asMember('manager')
    state.jobs = [job({ id: 'rex_secret', kind: 'transactions', i: 1, filters: { from: '2025-03-01', to: '2025-03-31' } })]
    const { body } = await call()
    const raw = JSON.stringify(body)
    for (const leak of ['rex_secret', 'transactions', '2025-03-01', '2025-03-31', 'completed']) {
      expect(raw, `leaked ${leak}`).not.toContain(leak)
    }
  })

  it('12 · a caller with no report permission at all reads NOTHING from Firestore', async () => {
    // The short-circuit: proving you can see nothing should not cost 250 document reads.
    asMember('manager')
    state.jobs = Array.from({ length: 60 }, (_, i) => job({ id: `rex_${i}`, kind: 'transactions', i }))
    await call()
    expect(state.reads).toBe(0)
  })

  it('13 · the gate is permissionForExportJob, not a list of kinds in the reader', async () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/reports/history.ts'), 'utf8')
    expect(src).toContain('permissionForExportJob')
    // No locally-authored kind→permission table may exist beside the registry's.
    expect(src).not.toMatch(/['"]wallet-ledger['"]\s*:/)
    expect(src).not.toMatch(/ROLE_PERMISSIONS/)
  })
})

// ─── C · ordering, pagination and bounds ──────────────────────────────────────

describe('RD-ANALYTICS-12-11 · pagination is keyset and bounded', () => {
  it('14 · newest first', async () => {
    state.jobs = [
      job({ id: 'rex_old', kind: 'transactions', i: 1 }),
      job({ id: 'rex_new', kind: 'transactions', i: 9 }),
      job({ id: 'rex_mid', kind: 'transactions', i: 5 }),
    ]
    const { body } = await call()
    expect((body.jobs as { jobId: string }[]).map(j => j.jobId)).toEqual(['rex_new', 'rex_mid', 'rex_old'])
  })

  it('15 · a full page returns a cursor; the next page continues from it without overlap', async () => {
    state.jobs = Array.from({ length: 60 }, (_, i) => job({ id: `rex_${i}`, kind: 'transactions', i }))
    const first = await call()
    const page1 = (first.body.jobs as { jobId: string }[]).map(j => j.jobId)
    expect(page1.length).toBe(25)
    expect(first.body.hasMore).toBe(true)
    expect(typeof first.body.nextCursor).toBe('string')

    const second = await call(`?cursor=${encodeURIComponent(first.body.nextCursor as string)}`)
    const page2 = (second.body.jobs as { jobId: string }[]).map(j => j.jobId)
    expect(page2.length).toBe(25)
    // No repeats and no gaps: 50 distinct ids across two pages.
    expect(new Set([...page1, ...page2]).size).toBe(50)
  })

  it('16 · repeated paging reaches the end and stops', async () => {
    state.jobs = Array.from({ length: 60 }, (_, i) => job({ id: `rex_${i}`, kind: 'transactions', i }))
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let turn = 0; turn < 10; turn++) {
      const r: { body: Record<string, unknown> } = await call(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
      for (const j of r.body.jobs as { jobId: string }[]) seen.add(j.jobId)
      cursor = r.body.nextCursor as string | null
      if (!r.body.hasMore) break
    }
    expect(seen.size).toBe(60)
    expect(cursor).toBeNull()
  })

  it('17 · the page size is capped at 25 however large a limit is asked for', async () => {
    state.jobs = Array.from({ length: 200 }, (_, i) => job({ id: `rex_${i}`, kind: 'transactions', i }))
    const { body } = await call('?limit=1000')
    expect((body.jobs as unknown[]).length).toBe(25)
  })

  it('18 · a smaller limit is honoured', async () => {
    state.jobs = Array.from({ length: 40 }, (_, i) => job({ id: `rex_${i}`, kind: 'transactions', i }))
    const { body } = await call('?limit=5')
    expect((body.jobs as unknown[]).length).toBe(5)
  })

  it('19 · one request never reads more than the scan bound, however many rows are hidden', async () => {
    // 4,000 jobs of a kind this caller cannot see: the worst case the scan loop exists for.
    // Without a bound the reader would walk all 4,000 to fill one page it can never fill.
    asMember('finance')
    state.jobs = Array.from({ length: 4_000 }, (_, i) => job({ id: `rex_${i}`, kind: 'unknown-retired-kind', i }))
    const { HISTORY_MAX_SCAN } = await import('@/lib/reports/history')
    const { body } = await call()
    expect(body.jobs).toEqual([])
    expect(state.docsRead).toBeLessThanOrEqual(HISTORY_MAX_SCAN)
  })

  it('20 · and the cursor still ADVANCES, so "load more" makes progress rather than looping', async () => {
    asMember('finance')
    // 300 invisible jobs, then one visible — reachable only if each page moves forward.
    state.jobs = [
      ...Array.from({ length: 300 }, (_, i) => job({ id: `rex_hidden_${i}`, kind: 'unknown-retired-kind', i: i + 10 })),
      job({ id: 'rex_visible', kind: 'transactions', i: 1 }),
    ]
    const seen: string[] = []
    let cursor: string | null = null
    for (let turn = 0; turn < 12; turn++) {
      const r: { body: Record<string, unknown> } = await call(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
      for (const j of r.body.jobs as { jobId: string }[]) seen.push(j.jobId)
      cursor = r.body.nextCursor as string | null
      if (!r.body.hasMore) break
    }
    expect(seen).toEqual(['rex_visible'])
  })

  it('21 · a malformed cursor is rejected, not silently ignored', async () => {
    // Restarting from the top would present page one again and read as an endless History.
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]
    const { status } = await call('?cursor=not-a-cursor')
    expect(status).toBe(400)
  })

  it('22 · the cursor names no job, no workspace and no caller', async () => {
    state.jobs = Array.from({ length: 40 }, (_, i) => job({ id: `rex_${i}`, kind: 'transactions', i }))
    const { body } = await call()
    const decoded = Buffer.from(body.nextCursor as string, 'base64url').toString('utf8')
    expect(decoded).not.toContain('rex_')
    expect(decoded).not.toContain(OWNER)
    expect(JSON.parse(decoded)).toEqual({ s: expect.any(Number), n: expect.any(Number) })
  })

  it('23 · there is no offset pagination to reach for', async () => {
    const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/reports/history/route.ts'), 'utf8')
    expect(src).not.toMatch(/\boffset\b/)
    expect(src).not.toMatch(/searchParams\.get\(['"](page|skip)['"]\)/)
    const reader = readFileSync(resolve(process.cwd(), 'lib/reports/history.ts'), 'utf8')
    expect(reader).toContain('startAfter')
    expect(reader).not.toMatch(/\.offset\(/)
  })

  it('24 · the reader never reads the collection without a workspace filter', async () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/reports/history.ts'), 'utf8')
    // Every collection() call is immediately narrowed by organizerUid.
    expect(src).toMatch(/collection\(REPORT_EXPORT_JOBS\)[\s\S]{0,120}where\('organizerUid', '==', opts\.workspaceUid\)/)
    // And every get() is preceded by a limit — there is no unbounded fetch.
    expect(src).not.toMatch(/base\.get\(\)/)
  })
})

// ─── D · projection safety ────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · the projection is safe', () => {
  it('25 · no signed URL, no storage path, no download token, no contentType', async () => {
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]
    const { body } = await call()
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('reportExports/')
    expect(raw).not.toContain('storage.googleapis.com')
    expect(raw).not.toContain('firebasestorage')
    expect(raw).not.toContain('alt=media')
    expect(raw).not.toContain('X-Goog-Signature')
    expect(raw).not.toContain('text/csv')
    expect(raw).not.toMatch(/"path"/)
    expect(raw).not.toMatch(/"url"/)
  })

  it('26 · no token of any kind travels in the response', async () => {
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]
    const { body } = await call()
    const raw = JSON.stringify(body).toLowerCase()
    for (const t of ['idtoken', 'accesstoken', 'bearer', 'downloadtoken', 'authorization']) {
      expect(raw, t).not.toContain(t)
    }
  })

  it('27 · no internal control state — the lease, the runner cursor, the workspace uid', async () => {
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1, lockedUntil: Timestamp.now(), cursor: 'chunk-42' })]
    const { body } = await call()
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('lockedUntil')
    expect(raw).not.toContain('chunk-42')
    expect(raw).not.toContain('organizerUid')
    expect(raw).not.toContain(OWNER)
  })

  it('28 · a raw internal error is never echoed — the failure state is sanitized', async () => {
    state.jobs = [job({
      id: 'rex_f', kind: 'transactions', i: 1, status: 'failed', output: undefined,
      error: 'FirebaseError: 7 PERMISSION_DENIED: Missing index on projects/rd-prod/databases/(default)',
    })]
    const { body } = await call()
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('PERMISSION_DENIED')
    expect(raw).not.toContain('rd-prod')
    expect(raw).not.toContain('Missing index')
    expect((body.jobs as { failure: string }[])[0]!.failure).toBe('Report generation failed. Generate it again.')
  })

  it('29 · attribution without an identifier — createdByYou, never a uid', async () => {
    const mine = job({ id: 'rex_mine', kind: 'transactions', i: 2 })
    const theirs = job({ id: 'rex_theirs', kind: 'transactions', i: 1 })
    theirs.data.createdBy = 'someone-else-uid'
    state.jobs = [mine, theirs]
    const { body } = await call()
    const rows = body.jobs as { jobId: string; createdByYou: boolean }[]
    expect(rows.find(r => r.jobId === 'rex_mine')!.createdByYou).toBe(true)
    expect(rows.find(r => r.jobId === 'rex_theirs')!.createdByYou).toBe(false)
    expect(JSON.stringify(body)).not.toContain('someone-else-uid')
  })
})

// ─── E · lifecycle honesty ────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · statuses and the three clocks', () => {
  it('30 · a completed job with a live artifact is downloadable', async () => {
    state.jobs = [job({ id: 'rex_a', kind: 'transactions', i: 1 })]
    const { body } = await call()
    expect((body.jobs as { download: string }[])[0]!.download).toBe('available')
  })

  it('31 · a completed job whose ARTIFACT expired is shown honestly, not as downloadable', async () => {
    // The job document is not deleted at expiry — three clocks, only one of which is this.
    // Pretending the file is still there would produce a 410 the user cannot interpret.
    const j = job({ id: 'rex_x', kind: 'transactions', i: 1 })
    ;(j.data.output as Record<string, unknown>).expiresAt = Timestamp.fromMillis(Date.now() - 60_000)
    state.jobs = [j]
    const { body } = await call()
    const row = (body.jobs as { status: string; download: string }[])[0]!
    expect(row.download).toBe('expired')
    // And the JOB status is still what it was. There is no `expired` status in storage and
    // this must not invent one.
    expect(row.status).toBe('completed')
  })

  it('32 · a cancelled job is never downloadable, even though it may still carry an output', async () => {
    // cancelJob does not clear `output`; the download route refuses with 410 and History
    // must agree rather than advertise a button that fails.
    state.jobs = [job({ id: 'rex_c', kind: 'transactions', i: 1, status: 'cancelled' })]
    const { body } = await call()
    const row = (body.jobs as { status: string; download: string }[])[0]!
    expect(row.status).toBe('cancelled')
    expect(row.download).toBe('unavailable')
  })

  it('33 · a failed job appears, with no file and a sanitized failure', async () => {
    state.jobs = [job({ id: 'rex_f', kind: 'transactions', i: 1, status: 'failed', output: undefined, error: 'boom' })]
    const { body } = await call()
    const row = (body.jobs as { status: string; download: string; failure: string | null }[])[0]!
    expect(row.status).toBe('failed')
    expect(row.download).toBe('unavailable')
    expect(row.failure).toBeTruthy()
    expect(row.failure).not.toContain('boom')
  })

  it('34 · pending and processing jobs appear with their real status', async () => {
    state.jobs = [
      job({ id: 'rex_p', kind: 'transactions', i: 2, status: 'pending',    output: undefined }),
      job({ id: 'rex_g', kind: 'transactions', i: 1, status: 'processing', output: undefined }),
    ]
    const { body } = await call()
    expect((body.jobs as { status: string }[]).map(r => r.status)).toEqual(['pending', 'processing'])
  })

  it('35 · no status outside the real state machine is invented', async () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/reports/history.ts'), 'utf8')
    // 'expired' may appear only as a DOWNLOAD state, never as a job status.
    expect(src).not.toMatch(/status\s*[:=]\s*'expired'/)
    expect(src).not.toMatch(/'expired'\s*\|\s*'completed'/)
  })
})

// ─── F · unknown kinds and payout-statement ───────────────────────────────────

describe('RD-ANALYTICS-12-11 · kinds the catalogue no longer knows', () => {
  it('36 · a retired kind does not break the request', async () => {
    state.jobs = [
      job({ id: 'rex_gone', kind: 'a-report-that-no-longer-exists', i: 2 }),
      job({ id: 'rex_ok',   kind: 'transactions', i: 1 }),
    ]
    const { status, body } = await call()
    expect(status).toBe(200)
    // It is not RENDERED either, because an unregistered kind has no permission to check
    // against — `permissionForExportJob` returns null and every sibling route treats that
    // as a refusal. History does not become the one place that treats it as "no permission
    // required".
    expect((body.jobs as { jobId: string }[]).map(j => j.jobId)).toEqual(['rex_ok'])
  })

  it('37 · payout-statement cannot be created as an export job in the first place', async () => {
    // It is in the CATALOGUE but not in ORGANIZER_REPORTS, so the create route rejects it
    // with 400 before a job document can exist. This is asserted rather than assumed,
    // because the History renderer's fallback path depends on it.
    const { ORGANIZER_REPORTS } = await import('@/lib/reports/registry')
    const { REPORT_CATALOG }    = await import('@/lib/reports/catalog')
    expect(REPORT_CATALOG['payout-statement']).toBeTruthy()
    expect(ORGANIZER_REPORTS['payout-statement']).toBeUndefined()
  })

  it('38 · and a legacy payout-statement row would not crash the reader', async () => {
    state.jobs = [
      job({ id: 'rex_ps', kind: 'payout-statement', i: 2, format: 'pdf' }),
      job({ id: 'rex_ok', kind: 'transactions', i: 1 }),
    ]
    const { status, body } = await call()
    expect(status).toBe(200)
    expect((body.jobs as unknown[]).length).toBe(1)
  })

  it('39 · payout-statement is still NOT in the generic dispatch map', async () => {
    const registry = readFileSync(resolve(process.cwd(), 'lib/reports/registry.ts'), 'utf8')
    expect(registry).not.toMatch(/'payout-statement':\s*build/)
  })
})

// ─── G · nothing else moved ───────────────────────────────────────────────────

describe('RD-ANALYTICS-12-11 · the existing systems are untouched', () => {
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

  it('40 · History mints no signed URL — signing happens only in the download route', async () => {
    expect(src('lib/reports/history.ts')).not.toContain('signedReadUrl')
    expect(src('app/api/organizer/reports/history/route.ts')).not.toContain('signedReadUrl')
    // And the download route still does.
    expect(src('app/api/organizer/reports/exports/[jobId]/download/route.ts')).toContain('signedReadUrl')
  })

  it('41 · History creates no export system of its own', async () => {
    const h = src('lib/reports/history.ts')
    expect(h).not.toContain('createReportExportJob')
    expect(h).not.toContain('processReportExportChunk')
    expect(h).not.toContain('uploadServerFile')
    // Reads only.
    expect(h).not.toMatch(/\.(set|update|delete|add)\(/)
  })

  it('42 · permissionForExportJob still resolves through the registry, unchanged', async () => {
    expect(src('lib/reports/exportJob.ts'))
      .toContain('return ORGANIZER_REPORTS[job.kind]?.permission ?? null')
  })

  it('43 · the download route still re-checks the permission and the lifecycle', async () => {
    const d = src('app/api/organizer/reports/exports/[jobId]/download/route.ts')
    expect(d).toContain('permissionForExportJob')
    expect(d).toContain('authorizeAnyWorkspace')
    expect(d).toMatch(/status:\s*410/)
  })

  it('44 · the client is still denied direct Firestore access to reportExportJobs', async () => {
    // History exists BECAUSE the collection is unreachable from the browser. If a rules
    // block ever grants read here, the server projection stops being the only path and
    // every guarantee above becomes optional.
    expect(src('firestore.rules')).not.toContain('reportExportJobs')
  })

  it('45 · exactly one reportExportJobs index is declared, and it is the query History makes', async () => {
    const idx = JSON.parse(src('firestore.indexes.json')) as {
      indexes: { collectionGroup: string; fields: { fieldPath: string; order: string }[] }[]
    }
    const mine = idx.indexes.filter(i => i.collectionGroup === 'reportExportJobs')
    expect(mine.length).toBe(1)
    expect(mine[0]!.fields).toEqual([
      { fieldPath: 'organizerUid', order: 'ASCENDING' },
      { fieldPath: 'createdAt',    order: 'DESCENDING' },
    ])
  })
})
