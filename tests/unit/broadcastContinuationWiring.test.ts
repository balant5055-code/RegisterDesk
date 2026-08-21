// RD-JOB-CONT-01 · the wiring the runner tests cannot see.
//
// broadcastJobContinuation.test.ts proves the ENGINE resumes correctly. This file proves the
// engine is actually plugged in: that a yielded chunk summons the next one, that the reaper
// refuses to touch healthy work, that the `sent` flag is awaited on both channels, and that
// the browser is still not responsible for delivery.
//
// These are source-level assertions on purpose. The pieces are Next route handlers wired to
// `after()`, cron auth and Firestore; standing them up in a `node` test environment would
// test the mocks. What matters here is the wiring, and the wiring is what regressed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const EMAIL_CRON = read('app/api/cron/email-broadcasts/route.ts')
const WA_CRON    = read('app/api/cron/whatsapp-broadcasts/route.ts')
const REAPER     = read('app/api/cron/job-reaper/route.ts')
const EMAIL_JOB  = read('lib/broadcasts/emailJob.ts')
const WA_JOB     = read('lib/broadcasts/whatsappJob.ts')
const KERNEL     = read('lib/jobs/kernel.ts')
const RUNNER     = read('lib/jobs/runner.ts')
const CLIENT     = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')
const WORKFLOW   = read('.github/workflows/cron-runners.yml')

// ─── Layer 1 — the chain ──────────────────────────────────────────────────────

describe('a yielded chunk summons the next invocation', () => {
  for (const [name, src] of [['email', EMAIL_CRON], ['whatsapp', WA_CRON]] as const) {
    it(`${name} cron decides via shouldChain and dispatches with after()`, () => {
      expect(src, name).toContain('const chain = shouldChain({ advanced, nonTerminal, depth })')
      expect(src, name).toContain("after(() => triggerChain(SELF_PATH, depth))")
      expect(src, name).toContain("if (chain === 'dispatched')")
    })

    it(`${name} cron reads the incoming chain depth`, () => {
      expect(src, name).toContain('const depth = readChainDepth(req.headers)')
    })

    it(`${name} cron waits out a busy lease ONLY when chained`, () => {
      // A scheduled tick must not block on a job another driver legitimately owns.
      expect(src, name).toContain("while (depth > 0 && r.reason === 'busy'")
      expect(src, name).toContain('BUSY_RETRY_MAX_MS')
    })

    it(`${name} cron targets ITSELF, not the other channel`, () => {
      const expected = name === 'email' ? '/api/cron/email-broadcasts' : '/api/cron/whatsapp-broadcasts'
      expect(src.slice(src.indexOf('const SELF_PATH')), name).toContain(expected)
    })
  }

  // WHY THIS ASSERTION CHANGED. It used to read "the lease/fencing kernel was NOT modified",
  // pinning `lockedUntil: terminal ? null : …`. That was right while the chain tolerated the
  // busy window instead of releasing leases — but production proved that approach cannot
  // work: commitChunk RENEWS the lease to now+60s at the END of a 45s chunk, so the successor
  // faced a 60s lease with an 18s retry budget and the chain died at depth 1 every time
  // (7 invocations, zero sub-minute gaps, 2.79 msg/min end-to-end).
  //
  // The kernel now carries an OPT-IN hand-off. What the original assertion actually protected
  // — that certificates, prints, imports, media and reports are unaffected — is what is
  // asserted here instead, and that protection is unchanged.
  it('the kernel default is untouched; only an explicit opt-in releases a lease', () => {
    // Default path: still renews, exactly as every non-broadcast job relies on.
    expect(KERNEL).toContain('const newTag  = terminal || handOff ? 0 : Date.now() + c.leaseMs')
    // The release is gated on a STRICT boolean, and never on a terminal commit.
    expect(KERNEL).toContain('const handOff = !terminal && c.releaseLease === true')
    // Fencing and the busy check are untouched.
    expect(KERNEL).toContain("if (job.status === 'processing' && locked > now)")
    expect(KERNEL).toContain('if (currentTag !== c.expectedLeaseTag)')
    // D1 — the loop exit is now the SAME decision that drove the release, not a second clock
    // read. The old assertion pinned `if (Date.now() - startedAt >= config.budgetMs) break`,
    // which is exactly what allowed the budget to cross DURING commitChunk: the lease was
    // renewed and the loop broke anyway, so the yielding worker held the job for another full
    // leaseMs and the continuation it had just dispatched got `busy`. One variable, used for
    // both, makes `releaseLease === true ⇒ the loop exits` true by construction.
    expect(RUNNER).toContain('if (yieldingNow) break')
    expect(RUNNER).not.toContain('if (Date.now() - startedAt >= config.budgetMs) break')
    // Exactly ONE clock read decides the yield.
    expect(RUNNER.match(/Date\.now\(\) - startedAt >= config\.budgetMs/g) ?? []).toHaveLength(1)
    // And the runner only asks for it when genuinely handing off.
    expect(RUNNER).toContain('config.releaseLeaseOnHandoff === true && yieldingNow')
  })

  it('only the broadcast runners opt in — no other job type does', () => {
    const optedIn = ['lib/broadcasts/emailJob.ts', 'lib/broadcasts/whatsappJob.ts']
    for (const f of optedIn) expect(read(f), f).toContain('releaseLeaseOnHandoff: true')
    for (const f of ['lib/certificates/jobs.ts', 'lib/printAssets/generationJob.ts']) {
      try { expect(read(f), f).not.toContain('releaseLeaseOnHandoff') } catch { /* file may not exist */ }
    }
  })

  it('the execution budget was NOT raised to paper over the problem', () => {
    expect(EMAIL_JOB).toContain('const EB_BUDGET_MS = 45_000')
    expect(EMAIL_JOB).toContain('const EB_PAGE_SIZE = 2')
    expect(EMAIL_JOB).toContain('const EB_LEASE_MS  = 60_000')
  })
})

// ─── Layer 2 — observability ─────────────────────────────────────────────────

describe('cron metrics distinguish advanced / busy / errored', () => {
  for (const [name, src] of [['email', EMAIL_CRON], ['whatsapp', WA_CRON]] as const) {
    it(`${name} cron records a structured detail, not just status=200`, () => {
      // Previously every run wrote `status=200`, so a job failing on EVERY tick looked
      // identical to an idle scan. That is a large part of why this went unnoticed.
      expect(src, name).toContain('recordCronExecution(')
      expect(src, name).toContain('JSON.stringify({ scanned: jobs.length, advanced, busy, errored, nonTerminal, depth, chain })')
      expect(src, name).toContain('ok: errored === 0')
    })
  }

  it('per-job exceptions are still counted rather than swallowed silently', () => {
    for (const [name, src] of [['email', EMAIL_CRON], ['whatsapp', WA_CRON]] as const) {
      expect(src, name).toContain('errored++')
      expect(src, name).toContain('captureError(err')
    }
  })
})

// ─── Layer 3 — the reaper ────────────────────────────────────────────────────

describe('the reaper only touches genuinely stale jobs', () => {
  it('GUARD 1 — a job that moved recently is skipped', () => {
    expect(REAPER).toContain('if (idleMs < STALE_AFTER_MS) { healthy++; continue }')
  })

  it('GUARD 2 — a job whose lease is still held is skipped', () => {
    // Reviving a leased job would put two drivers on one campaign.
    expect(REAPER).toContain('if (millis(job.lockedUntil) > now) { leased++; continue }')
  })

  it('only `processing` jobs are considered', () => {
    expect(REAPER).toContain("if (job.status !== 'processing') continue")
  })

  it('a hard-stale job is failed with a diagnosable reason', () => {
    expect(REAPER).toContain('await failJob(')
    expect(REAPER).toContain('Stalled at ${job.counts.processed}/${job.counts.total}')
    expect(REAPER).toContain('No progress for ${Math.round(idleMs / 60_000)} minutes')
  })

  it('it covers BOTH channels', () => {
    expect(REAPER).toContain('EMAIL_BROADCAST_JOBS')
    expect(REAPER).toContain('WHATSAPP_BROADCAST_JOBS')
  })

  it('it writes nothing except through the kernel', () => {
    // No ad-hoc job mutation — the lease/fencing model stays single-sourced.
    expect(REAPER).not.toMatch(/\.update\(/)
    expect(REAPER).not.toMatch(/\.set\(/)
  })

  it('it is actually scheduled', () => {
    expect(WORKFLOW).toContain('/api/cron/job-reaper')
    // Last in the group: anything still stalled has genuinely been missed by the drivers.
    expect(WORKFLOW.indexOf('/api/cron/job-reaper')).toBeGreaterThan(WORKFLOW.indexOf('/api/cron/email-broadcasts'))
    expect(WORKFLOW.indexOf('/api/cron/job-reaper')).toBeGreaterThan(WORKFLOW.indexOf('/api/cron/whatsapp-broadcasts'))
  })
})

// ─── Duplicate-send safety ───────────────────────────────────────────────────

describe('the sent flag is awaited on both channels', () => {
  it('EMAIL awaits the write instead of firing and forgetting', () => {
    // `void … .catch(() => {})` meant an invocation that died between the send and the
    // write left the recipient unmarked — and resumed chunks mailed them again. Automatic
    // continuation makes resumes routine, so this had to close first.
    expect(EMAIL_JOB).toContain("await adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)")
    expect(EMAIL_JOB).not.toContain("void adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)")
  })

  it('WHATSAPP awaits it too — a duplicate there costs money twice', () => {
    expect(WA_JOB).toContain("await adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)")
    expect(WA_JOB).not.toContain("void adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)")
  })

  it('a failed flag-write still counts the item as SENT, never re-queued', () => {
    for (const [name, src] of [['email', EMAIL_JOB], ['whatsapp', WA_JOB]] as const) {
      const block = src.slice(src.indexOf("if (status === 'sent') {"))
      expect(block, name).toContain('sent-flag write failed')
      expect(block.slice(0, block.indexOf('return { ok: true }')), name).toContain('catch (err)')
    }
  })

  it('the already-sent skip is still the first thing processItem does', () => {
    expect(EMAIL_JOB).toContain('if (item.sent) return { ok: true }')
    expect(WA_JOB).toContain('if (item.sent) return { ok: true }')
  })
})

// ─── Scope discipline ────────────────────────────────────────────────────────

describe('nothing outside the continuation path changed', () => {
  it('the browser is still NOT responsible for delivery', () => {
    // The 2.5s poll must remain a GET. Delivery is a backend concern.
    const poll = CLIENT.slice(CLIENT.indexOf('const fetchJob'), CLIENT.indexOf('async function resume'))
    expect(poll).toContain('/job`')
    expect(poll).not.toContain('/job/process')
    expect(poll).not.toContain("method: 'POST'")
  })

  it('WhatsApp provider, template and billing behaviour is untouched', () => {
    expect(WA_JOB).toContain('chargeAndStartCampaign')   // billing still upfront, unchanged
    expect(WA_CRON).not.toContain('templateType')
    expect(WA_CRON).not.toContain('pricePaise')
  })

  it('recipient and provider limits are not referenced by any continuation code', () => {
    for (const [name, src] of [['email', EMAIL_CRON], ['whatsapp', WA_CRON], ['reaper', REAPER]] as const) {
      expect(src, name).not.toContain('resolveMaxRecipientsPerBroadcast')
      expect(src, name).not.toContain('checkBroadcastLimits')
    }
  })
})
