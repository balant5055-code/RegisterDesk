// RD-CERT-EMAIL-DRIVE · "Send all not sent" must actually START the job.
//
// ═══ THE DEFECT THIS PINS ════════════════════════════════════════════════════
// `startJob` POSTed the job, set `Delivery started. It continues on the server — you can
// close this tab.`, and stopped. Nothing advanced the work. The only thing that could was
// the scheduled cron, observed in production at 20–56 minute gaps despite declaring a
// five-minute expression, because GitHub throttles scheduled workflows. So the button
// reported success and, for half an hour, sent nothing.
//
// It was invisible because the client layer had no way to drive delivery at all:
// `processJob` (generation) and `processZipJob` (export) existed, `processEmailJob` did not.
// The route it needed was already deployed and authorized with zero callers.
//
// Two properties are asserted, because either one alone would let the bug back:
//   1. the client CAN drive the job (the method exists and hits the existing route), and
//   2. the panel DOES drive it — on start, and on every poll tick.
//
// Plus the honesty rule: the success message may only appear once the process call has
// actually succeeded. Announcing delivery that has not begun is what hid this for so long.
//
// The API client runs for real against a stubbed fetch; the panel is read as TEXT — the
// idiom in certificateRegenerateUi.test.ts, since this repo runs Vitest in `node` with no
// jsdom. No network, no email, no job.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeCertApi } from '@/components/certificates/hub/api'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** Strips comments so the explanatory notes in these files are not false positives. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const PANEL = code(read('components/certificates/hub/RecipientsPanel.tsx'))
const API   = code(read('components/certificates/hub/api.ts'))

// A fictional event — a production id in a fixture invites copy-paste into source.
const EVENT = 'harbour-half-marathon-2026'
const JOB   = 'JOB-TESTONLY000000000000'

interface Call { url: string; init?: RequestInit }
const calls: Call[] = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: { done: false, status: 'processing', processed: 2 },
        job: { jobId: JOB, status: 'processing', counts: { total: 2, processed: 2, succeeded: 2, failed: 0 }, needsReview: 0, error: null },
      }),
    } as unknown as Response
  })
})
afterEach(() => { vi.unstubAllGlobals() })

// ─── 1 · the client can drive delivery at all ────────────────────────────────

describe('api.processEmailJob', () => {
  it('exists — the gap that made the bug unreachable from the UI', () => {
    const api = makeCertApi(EVENT, 'tok') as Record<string, unknown>
    expect(typeof api.processEmailJob).toBe('function')
  })

  it('POSTs to the EXISTING process route — no new endpoint is invented', async () => {
    const api = makeCertApi(EVENT, 'tok')
    await api.processEmailJob(JOB)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      `/api/organizer/events/${EVENT}/certificates/email-jobs/${JOB}/process`)
    expect(calls[0].init?.method).toBe('POST')
  })

  it('carries the organizer bearer token', async () => {
    const api = makeCertApi(EVENT, 'tok')
    await api.processEmailJob(JOB)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
  })

  it('returns the route\'s result + job summary', async () => {
    const api = makeCertApi(EVENT, 'tok')
    const r = await api.processEmailJob(JOB)
    expect(r.result.processed).toBe(2)
    expect(r.job?.status).toBe('processing')
  })

  it('sits alongside the other two job drivers, not instead of them', () => {
    const api = makeCertApi(EVENT, 'tok') as Record<string, unknown>
    expect(typeof api.processJob).toBe('function')      // generation
    expect(typeof api.processZipJob).toBe('function')   // export
  })
})

// ─── 2 · the panel actually drives it ────────────────────────────────────────

describe('startJob drives the job it just created', () => {
  it('creates, then processes', () => {
    // Scoped to startJob's own body: `processEmailJob` also appears EARLIER in the file, in
    // the poll loop, so searching the whole panel would compare the wrong two positions.
    const body    = PANEL.slice(PANEL.indexOf('async function startJob'))
    const create  = body.indexOf('api.createEmailJob(')
    const process = body.indexOf('api.processEmailJob(')
    expect(create).toBeGreaterThan(-1)
    expect(process).toBeGreaterThan(-1)
    expect(create).toBeLessThan(process)      // enqueue first, then start
  })

  it('drives the job it just created — not a re-read or a second job', () => {
    expect(PANEL).toContain('api.processEmailJob(created.jobId)')
    // Exactly ONE create call: a retry must never enqueue a duplicate job.
    expect(PANEL.match(/api\.createEmailJob\(/g)).toHaveLength(1)
  })

  it('never reaches past the API client into the server internals', () => {
    for (const forbidden of ['claimCertificateEmail', 'adminDb', 'firebase-admin', "from '@/lib/certificates/email'"]) {
      expect(PANEL, forbidden).not.toContain(forbidden)
    }
    // `emailCertificate` DOES appear — as `api.emailCertificate`, the existing single-row
    // Send/Resend action. Every occurrence must go through the client, never the server fn.
    for (const m of PANEL.matchAll(/(\w*\.?)emailCertificate\(/g)) {
      expect(m[1], `bare emailCertificate( at index ${m.index}`).toBe('api.')
    }
  })
})

// ─── 3 · the message must not outrun the work ────────────────────────────────

describe('the success notice is earned, not assumed', () => {
  const NOTICE = 'Delivery started. It continues on the server'

  it('is set AFTER the process call, never in the create block', () => {
    const process = PANEL.indexOf('api.processEmailJob(created.jobId)')
    const notice  = PANEL.indexOf(NOTICE)
    expect(notice).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(process)
  })

  it('a failed process call reports a retry state instead of claiming success', () => {
    // The job is still valid and cron-recoverable, so this is an honest "not yet", not a
    // failure to create.
    const tail = PANEL.slice(PANEL.indexOf('api.processEmailJob(created.jobId)'))
    const catchAt = tail.indexOf('} catch {')
    expect(catchAt).toBeGreaterThan(-1)
    const handler = tail.slice(catchAt, catchAt + 400)
    expect(handler).toContain('setErr(')
    expect(handler).not.toContain(NOTICE)
  })

  it('a failed CREATE returns early — there is nothing to drive', () => {
    const createBlock = PANEL.slice(PANEL.indexOf('api.createEmailJob('))
    expect(createBlock.slice(0, 600)).toContain('return')
  })
})

// ─── 4 · the poll loop drives too, safely ────────────────────────────────────

describe('the poll loop advances the job and reads authoritative state', () => {
  it('processes, then GETs — the UI trusts the job document', () => {
    const tick    = PANEL.slice(PANEL.indexOf('const tick = async ()'))
    const process = tick.indexOf('api.processEmailJob(jobId)')
    const get     = tick.indexOf('api.getEmailJob(jobId)')
    expect(process).toBeGreaterThan(-1)
    expect(get).toBeGreaterThan(process)
  })

  it('the process call is best-effort — a failure must not stop the loop or the cron', () => {
    expect(PANEL).toContain('api.processEmailJob(jobId).catch(() => {})')
  })

  it('only ONE chunk is in flight at a time', () => {
    expect(PANEL).toContain('drivingRef')
    const tick = PANEL.slice(PANEL.indexOf('const tick = async ()'))
    expect(tick).toContain('if (!live || drivingRef.current) return')
    expect(tick).toContain('drivingRef.current = true')
    expect(tick).toContain('drivingRef.current = false')   // released in `finally`
  })

  it('stops at a terminal status', () => {
    expect(PANEL).toContain("job.status !== 'pending' && job.status !== 'processing'")
    expect(PANEL).toContain('clearInterval(pollRef.current)')
  })
})

// ─── 5 · nothing else about delivery changed ─────────────────────────────────

describe('existing behaviour is preserved', () => {
  it('all three scopes still start a job', () => {
    for (const scope of ['unsent', 'failed', 'selected']) {
      expect(PANEL, scope).toContain(`startJob('${scope}')`)
    }
  })

  it('Retry Failed is untouched', () => {
    expect(PANEL).toContain("startJob('failed')")
    expect(PANEL).toContain('Retry failed')
  })

  it('the cron driver remains the server-side guarantee', () => {
    // The client must not be the only thing that can finish a job.
    const cron = read('app/api/cron/certificate-email-jobs/route.ts')
    expect(cron).toContain('processEmailJobChunk')
    expect(cron).toContain('listActiveEmailJobs')
  })

  it('the process route was reused, not replaced', () => {
    expect(API).toContain('/process')
    // The client points at the route that already existed and is already authorized.
    const route = read('app/api/organizer/events/[eventId]/certificates/email-jobs/[jobId]/process/route.ts')
    expect(route).toContain("authorizeWorkspace(req, 'certificates')")
    expect(route).toContain('processEmailJobChunk(jobId)')
  })
})
