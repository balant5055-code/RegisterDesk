// RD-BCAST-COUNT-01 · the recipient-count request must never lie.
//
// The bug that prompted this: selecting "Today" on 20 Aug still showed 1 recipient while
// the only registration was from 17 Aug. The date arithmetic was provably correct, so the
// number on screen was not the number the server had computed — it was an older one that
// had never been replaced. Two ways that happens, both covered below: a superseded response
// landing last, and a failed request leaving the previous value untouched.
//
// These run without a DOM, which is exactly why the logic was moved out of the component.

import { describe, it, expect, vi } from 'vitest'
import {
  createRecipientCountController, toRecipientCountState, COUNT_FAILED_MESSAGE,
  type RecipientCountState, type CountApiResponse,
} from '@/lib/broadcasts/recipientCount'
import { resolveRegistrationDateWindow } from '@/lib/broadcasts/registrationDateFilter'

/** A promise whose settlement this test controls, so interleavings are deterministic. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Load = { ok: boolean; body: CountApiResponse | null }

const ok = (count: number, meta?: Partial<CountApiResponse>): Load =>
  ({ ok: true, body: { success: true, count, ...meta } })

/** Records every state the controller emits; `last` is what the UI would be showing. */
function recorder() {
  const states: RecipientCountState[] = []
  const ctl = createRecipientCountController(s => { states.push(s) })
  return { ctl, states, last: () => states[states.length - 1] }
}

// ─── A + B. Races ─────────────────────────────────────────────────────────────

describe('only the latest request may update the count', () => {
  it('A — a superseded response resolving LAST does not overwrite the newer count', async () => {
    // The reported bug, exactly: "All registrations" (1) is still in flight when "Today"
    // (0) is fired; Today answers first, then the stale All lands.
    const { ctl, last } = recorder()
    const all   = deferred<Load>()
    const today = deferred<Load>()

    const runAll   = ctl.run(() => all.promise)     // request A — unfiltered
    const runToday = ctl.run(() => today.promise)   // request B — Today

    today.resolve(ok(0))
    await runToday
    expect(last()).toEqual({ status: 'ready', count: 0, meta: null })

    all.resolve(ok(1))                              // the stale one, arriving late
    await runAll

    // Must STILL be 0. Before the fix this flipped back to 1 and the filter looked broken.
    expect(last()).toEqual({ status: 'ready', count: 0, meta: null })
  })

  it('B — reverse order: the newer request still wins', async () => {
    const { ctl, last } = recorder()
    const a = deferred<Load>()
    const b = deferred<Load>()

    const runA = ctl.run(() => a.promise)
    const runB = ctl.run(() => b.promise)

    a.resolve(ok(1))          // older resolves first — must be discarded
    await runA
    b.resolve(ok(7))
    await runB

    expect(last()).toEqual({ status: 'ready', count: 7, meta: null })
  })

  it('a stale FAILURE cannot clobber a newer success either', async () => {
    // Discarding is about being superseded, not about succeeding.
    const { ctl, last } = recorder()
    const stale = deferred<Load>()
    const fresh = deferred<Load>()

    const runStale = ctl.run(() => stale.promise)
    const runFresh = ctl.run(() => fresh.promise)

    fresh.resolve(ok(3))
    await runFresh
    stale.reject(new Error('network died'))
    await runStale

    expect(last()).toEqual({ status: 'ready', count: 3, meta: null })
  })

  it('three in flight — only the last one is applied', async () => {
    const { ctl, last, states } = recorder()
    const d = [deferred<Load>(), deferred<Load>(), deferred<Load>()]
    const runs = d.map(x => ctl.run(() => x.promise))

    d[2].resolve(ok(5))
    d[0].resolve(ok(1))
    d[1].resolve(ok(2))
    await Promise.all(runs)

    expect(last()).toEqual({ status: 'ready', count: 5, meta: null })
    expect(states.filter(s => s.status === 'ready')).toHaveLength(1)
  })
})

// ─── G. Metadata follows the same rule ────────────────────────────────────────

describe('window metadata is governed by the same latest-wins rule', () => {
  it('an old response cannot restore metadata from a superseded filter', async () => {
    const { ctl, last } = recorder()
    const oldReq = deferred<Load>()
    const newReq = deferred<Load>()

    const runOld = ctl.run(() => oldReq.promise)
    const runNew = ctl.run(() => newReq.promise)

    newReq.resolve(ok(0, { timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026', undatedCount: 0 }))
    await runNew
    oldReq.resolve(ok(1, { timezone: 'UTC', dateLabel: '17 Aug 2026', undatedCount: 9 }))
    await runOld

    const s = last()
    expect(s.status).toBe('ready')
    if (s.status !== 'ready') return
    expect(s.count).toBe(0)
    expect(s.meta).toEqual({ timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026', undatedCount: 0 })
  })

  it('carries metadata through when the server sends it', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(4, { timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026', undatedCount: 2 }))
    expect(last()).toEqual({
      status: 'ready', count: 4,
      meta: { timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026', undatedCount: 2 },
    })
  })

  it('no metadata when no date filter is active', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(4))
    expect(last()).toEqual({ status: 'ready', count: 4, meta: null })
  })
})

// ─── The undated diagnostic has THREE states, not two ────────────────────────

describe('undatedCount distinguishes a number, a confirmed zero, and unknown', () => {
  const META = { timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026' }
  const metaOf = async (undatedCount?: number | null) => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(5, { ...META, ...(undatedCount === undefined ? {} : { undatedCount }) }))
    const s = last()
    if (s.status !== 'ready') throw new Error('expected ready')
    return s.meta
  }

  it('a positive count is carried through unchanged', async () => {
    expect((await metaOf(12))?.undatedCount).toBe(12)
  })

  it('a CONFIRMED zero stays 0 — it is a real answer, not an absence', async () => {
    expect((await metaOf(0))?.undatedCount).toBe(0)
  })

  it('null stays NULL — the regression this exists to prevent', async () => {
    // `?? 0` here would render "every registration has a registration date" on the back of
    // a diagnostic that failed. That is false reassurance immediately before a send.
    expect((await metaOf(null))?.undatedCount).toBeNull()
    expect((await metaOf(null))?.undatedCount).not.toBe(0)
  })

  it('an ABSENT field is unknown, not zero', async () => {
    expect((await metaOf(undefined))?.undatedCount).toBeNull()
  })

  it('null and 0 are never conflated in either direction', async () => {
    const unknown = (await metaOf(null))?.undatedCount
    const zero    = (await metaOf(0))?.undatedCount
    expect(unknown).not.toBe(zero)
    expect(Object.is(unknown, null)).toBe(true)
    expect(Object.is(zero, 0)).toBe(true)
  })

  it('the count itself is unaffected by the diagnostic state', async () => {
    // The audience is known; only the qualifier is missing. Billing/send stay authoritative.
    for (const u of [12, 0, null, undefined]) {
      const { ctl, last } = recorder()
      await ctl.run(async () => ok(5, { ...META, ...(u === undefined ? {} : { undatedCount: u }) }))
      const s = last()
      expect(s.status).toBe('ready')
      if (s.status === 'ready') expect(s.count).toBe(5)
    }
  })
})

// ─── The composer renders all three, distinctly ──────────────────────────────

describe('the composer renders the three undated states distinctly', () => {
  const client = (() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    return readFileSync('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx', 'utf8')
  })()

  it('never coerces null to zero anywhere in the client', () => {
    expect(client).not.toContain('undatedCount ?? 0')
  })

  it('the positive branch excludes null explicitly', () => {
    expect(client).toContain('dateMeta.undatedCount !== null && dateMeta.undatedCount > 0')
  })

  it('a confirmed zero is STATED, not implied by silence', () => {
    expect(client).toContain('dateMeta.undatedCount === 0')
    expect(client).toContain('Every registration in this audience has a registration date.')
  })

  it('unknown has its own message, worded as uncertainty', () => {
    expect(client).toContain('dateMeta.undatedCount === null')
    expect(client).toContain('UNDATED_UNKNOWN_NOTICE')
    expect(client).toContain('Unable to determine whether any registrations have no registration date')
  })

  it('the three conditions are mutually exclusive', () => {
    // >0 (non-null), ===0, ===null partition the domain with no overlap and no gap.
    const conds = ['dateMeta.undatedCount !== null && dateMeta.undatedCount > 0',
                   'dateMeta.undatedCount === 0', 'dateMeta.undatedCount === null']
    for (const c of conds) expect(client.split(c).length - 1, c).toBe(1)
  })
})

// ─── C + D. Failures never leave a stale number ───────────────────────────────

describe('a failed count is reported, never silently retained', () => {
  it('C — a thrown request produces an error state, not the previous count', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(1))
    expect(last()).toEqual({ status: 'ready', count: 1, meta: null })

    await ctl.run(async () => { throw new Error('offline') })

    // The old `1` must be gone. This is the difference between "1 recipient" and
    // "we could not work out who this would go to".
    expect(last()).toEqual({ status: 'error', message: COUNT_FAILED_MESSAGE })
  })

  it('D — success:false does not leave the old number visible', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(1))
    await ctl.run(async () => ({ ok: true, body: { success: false, error: 'Invalid registration date filter (invalid_date)' } }))

    expect(last()).toEqual({ status: 'error', message: 'Invalid registration date filter (invalid_date)' })
  })

  it('a non-2xx response is an error even when the body parses', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(1))
    await ctl.run(async () => ({ ok: false, body: { success: true, count: 99 } }))
    expect(last().status).toBe('error')
  })

  it('a missing count is NOT coerced to zero', async () => {
    // Zero is a claim about the audience. Only the server gets to make it.
    expect(toRecipientCountState(true, { success: true }).status).toBe('error')
    expect(toRecipientCountState(true, { success: true, count: Number.NaN }).status).toBe('error')
    expect(toRecipientCountState(true, null).status).toBe('error')
  })

  it('surfaces the server message when there is one, a generic message otherwise', () => {
    expect(toRecipientCountState(false, { success: false, error: 'Too many requests' }))
      .toEqual({ status: 'error', message: 'Too many requests' })
    expect(toRecipientCountState(false, null))
      .toEqual({ status: 'error', message: COUNT_FAILED_MESSAGE })
  })
})

// ─── E + F. Confirmed values render as values ─────────────────────────────────

describe('a confirmed count is reported as a count', () => {
  it('E — a confirmed 0 is READY, not an error', async () => {
    // "Today" legitimately matching nobody must read as 0 recipients, not as a failure.
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(0, { timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026' }))
    const s = last()
    expect(s.status).toBe('ready')
    if (s.status === 'ready') expect(s.count).toBe(0)
  })

  it('F — a confirmed 1 is reported as 1', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => ok(1))
    expect(last()).toEqual({ status: 'ready', count: 1, meta: null })
  })

  it('emits loading before settling, so the UI can tell "working" from "unknown"', async () => {
    const { ctl, states } = recorder()
    await ctl.run(async () => ok(2))
    expect(states.map(s => s.status)).toEqual(['loading', 'ready'])
  })

  it('recovers: a failure followed by a success shows the number again', async () => {
    const { ctl, last } = recorder()
    await ctl.run(async () => { throw new Error('x') })
    expect(last().status).toBe('error')
    await ctl.run(async () => ok(6))
    expect(last()).toEqual({ status: 'ready', count: 6, meta: null })
  })

  it('controllers are independent — no shared module state between composers', async () => {
    const a = recorder()
    const b = recorder()
    const held = deferred<Load>()
    const runA = a.ctl.run(() => held.promise)
    await b.ctl.run(async () => ok(9))          // b advancing must not supersede a's request
    held.resolve(ok(4))
    await runA
    expect(a.last()).toEqual({ status: 'ready', count: 4, meta: null })
    expect(b.last()).toEqual({ status: 'ready', count: 9, meta: null })
  })
})

// ─── 5. The original defect, as a regression ─────────────────────────────────

describe('regression: 17 Aug cannot appear in a 20 Aug "Today" window', () => {
  const windowFor = (todayISO: string) => {
    const r = resolveRegistrationDateWindow({ type: 'today' }, 'Asia/Kolkata', todayISO)
    if (!r.ok || !r.window) throw new Error('window not resolved')
    return r.window
  }

  it('a 17 Aug registration falls outside the 20 Aug window', () => {
    const w = windowFor('2026-08-20')
    // Whatever hour of 17 Aug IST it was created, it is before the window opens.
    for (const at of ['2026-08-16T18:30:00.000Z', '2026-08-17T06:00:00.000Z', '2026-08-17T18:29:59.999Z']) {
      const t = new Date(at).getTime()
      expect(t >= w.startUtc.getTime() && t < w.endUtcExclusive.getTime(), at).toBe(false)
    }
  })

  it('a 20 Aug registration falls inside it', () => {
    const w = windowFor('2026-08-20')
    for (const at of ['2026-08-19T18:30:00.000Z', '2026-08-20T05:00:00.000Z', '2026-08-20T18:29:59.999Z']) {
      const t = new Date(at).getTime()
      expect(t >= w.startUtc.getTime() && t < w.endUtcExclusive.getTime(), at).toBe(true)
    }
  })

  it('so an audience of only that 17 Aug registration counts ZERO — and the UI shows it', async () => {
    // End to end at the UI layer: the server says 0, and 0 is what survives, even with a
    // stale unfiltered response arriving afterwards.
    const { ctl, last } = recorder()
    const stale = deferred<Load>()
    const runStale = ctl.run(() => stale.promise)
    await ctl.run(async () => ok(0, { timezone: 'Asia/Kolkata', dateLabel: '20 Aug 2026' }))
    stale.resolve(ok(1))
    await runStale

    const s = last()
    expect(s.status).toBe('ready')
    if (s.status === 'ready') expect(s.count).toBe(0)
  })
})

// ─── Wiring: the component must actually delegate ────────────────────────────

describe('the composer delegates to the controller', () => {
  const client = (() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    return readFileSync('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx', 'utf8')
  })()

  it('uses the controller rather than setting count state inline', () => {
    expect(client).toContain('createRecipientCountController(applyCountState)')
    expect(client).toContain('countCtl.current!.run(')
  })

  it('the COUNT path no longer swallows failures', () => {
    // Scoped to fetchCount deliberately: an unrelated events-list fetch elsewhere in this
    // file still uses a silent catch, and narrowing this feature's fix into a file-wide
    // rule would be a false claim about code nobody reviewed here.
    const fetchCount = client.slice(client.indexOf('const fetchCount ='), client.indexOf('useEffect(() => {'))
    expect(fetchCount).not.toContain('/* silent */')
    expect(fetchCount).not.toContain('if (data.success)')
    expect(fetchCount).not.toContain('setRecipientCount(')
  })

  it('renders a distinct failure state instead of a stale number', () => {
    expect(client).toContain("'Count failed'")
    expect(client).toContain('{countError && !countLoading && (')
  })

  it('an unknown count cannot be sent — Send stays disabled', () => {
    expect(client).toContain('recipientCount !== null && recipientCount > 0')
  })
})

// Keep vi imported-and-used so the linter cannot flag it if this file grows.
void vi
