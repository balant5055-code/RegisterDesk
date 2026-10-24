// RD-CRON-ALERT-01 — the dead-cron monitor must expect each cron at the interval of the scheduler that
// actually runs it: the GitHub Actions workflows (vercel.json has no crons — tests/unit/cronScheduleDoc).
//
// The defect this pins: CRON_INTERVAL_MS was copied from an earlier all-Vercel plan. `release-funds` was
// expected every 60 minutes while cron-maintenance.yml runs it once a day, so every healthy run raised the
// CRITICAL "Cron(s) have stopped running: release-funds" alert about two hours later. `webhooks` (expected
// every minute, run every 10) and `certificate-claims` (15 min vs hourly) drifted the same way.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { CRON_INTERVAL_MS, isStale } from '@/lib/operations/healthMetrics'

const MIN = 60_000
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')

/** The workflow's cron expression as an interval. Only the shapes the workflows use are accepted. */
function intervalMs(expr: string): number {
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(expr)
  if (every) return Number(every[1]) * MIN
  if (/^\d+ \* \* \* \*$/.test(expr)) return 60 * MIN
  if (/^\d+ \d+ \* \* \*$/.test(expr)) return 24 * 60 * MIN
  throw new Error(`unrecognised schedule: ${expr}`)
}

/** route → interval, from the real `curl` lines of every cron workflow. */
function scheduled(): Map<string, number> {
  const out = new Map<string, number>()
  for (const file of readdirSync('.github/workflows').filter(f => /^cron-.*\.yml$/.test(f))) {
    const src = read(`.github/workflows/${file}`)
    const expr = /^\s+- cron: '([^']+)'/m.exec(src)?.[1]
    if (!expr) throw new Error(`${file}: no schedule`)
    for (const line of src.split('\n').filter(l => /^\s+curl /.test(l))) {
      const route = /api\/cron\/([a-z0-9-]+)/.exec(line)?.[1]
      if (route) out.set(route, intervalMs(expr))
    }
  }
  return out
}

describe('the dead-cron monitor expects each cron at its real schedule', () => {
  const real = scheduled()

  it('every monitored cron is scheduled by a workflow, at exactly the expected interval', () => {
    expect(Object.keys(CRON_INTERVAL_MS).length).toBeGreaterThan(0)
    for (const [name, expected] of Object.entries(CRON_INTERVAL_MS)) {
      expect(real.has(name), `${name} is monitored but no workflow runs it`).toBe(true)
      expect(expected, `${name}: monitor expects ${expected / MIN} min, workflow runs every ${real.get(name)! / MIN} min`).toBe(real.get(name))
    }
  })

  it('release-funds is expected DAILY (it runs at 02:00 UTC), never hourly', () => {
    expect(real.get('release-funds')).toBe(24 * 60 * MIN)
    expect(CRON_INTERVAL_MS['release-funds']).toBe(24 * 60 * MIN)
  })

  it('a daily run that succeeded hours ago is healthy; one missing for two days is stopped', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0)
    const lastRun = Date.UTC(2026, 9, 24, 2, 1)                     // today's 02:00 UTC run
    expect(isStale('release-funds', lastRun, now)).toBe(false)       // was TRUE under the hourly expectation
    expect(isStale('release-funds', now - 30 * 60 * MIN, now)).toBe(false)   // a late run is tolerated
    expect(isStale('release-funds', now - 49 * 60 * MIN, now)).toBe(true)    // two missed days = stopped
  })

  it('webhooks (every 10 min) is not flagged between runs, and is when it has really stopped', () => {
    const now = 1_000_000_000_000
    expect(isStale('webhooks', now - 12 * MIN, now)).toBe(false)     // was TRUE under the 1-minute expectation
    expect(isStale('webhooks', now - 30 * MIN, now)).toBe(true)
  })

  it('a cron that never recorded a run is not flagged (left to the dashboard)', () => {
    expect(isStale('release-funds', 0, Date.now())).toBe(false)
  })
})
