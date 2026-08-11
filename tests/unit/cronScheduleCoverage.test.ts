// Production cron coverage — every /api/cron/* route must have exactly ONE scheduler.
//
// WHY THIS EXISTS. `vercel.json` carries no crons, which reads like "nothing is scheduled"
// until you find `.github/workflows/` — GitHub Actions is the SOLE scheduler by design
// (docs/GITHUB_CRON_SETUP.md: "vercel.json keeps crons empty so GitHub is the sole
// scheduler (no double-firing)"). That split is easy to get wrong in both directions:
// add a cron route and forget the workflow (it silently never runs — how `reminders` and
// `email-broadcasts` would stop driving a 10,000-attendee event), or add a Vercel cron for
// work GitHub already owns (it fires twice).
//
// This asserts the invariant against the real files, not against a copy of the schedule.
// It is deliberately not a snapshot: it checks COVERAGE and UNIQUENESS, so adding a cron
// route with a schedule passes, and adding one without a schedule fails.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT          = process.cwd()
const CRON_ROUTES   = join(ROOT, 'app', 'api', 'cron')
const WORKFLOW_DIR  = join(ROOT, '.github', 'workflows')

/** Cron route names that exist in the app, e.g. 'reminders'. */
const routeNames = readdirSync(CRON_ROUTES, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()

interface Workflow { file: string; name: string; schedule: string; endpoints: string[] }

const workflows: Workflow[] = readdirSync(WORKFLOW_DIR)
  .filter(f => f.startsWith('cron-') && (f.endsWith('.yml') || f.endsWith('.yaml')))
  .map(file => {
    const raw = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    return {
      file,
      name:      /^name:\s*(.+)$/m.exec(raw)?.[1].trim() ?? '',
      schedule:  /-\s*cron:\s*'([^']+)'/.exec(raw)?.[1] ?? '',
      endpoints: invokedEndpoints(raw),
    }
  })

/**
 * Only a real `curl` invocation counts as a schedule. Several workflows also NAME a route
 * inside an explanatory comment; treating those as scheduled would let a commented-out job
 * masquerade as a live one — the precise failure this file exists to catch.
 */
function invokedEndpoints(raw: string): string[] {
  return raw
    .split('\n')
    .filter(l => l.includes('curl') && l.includes('/api/cron/'))
    .map(l => /\/api\/cron\/([a-z-]+)/.exec(l)?.[1])
    .filter((e): e is string => !!e)
}

/** endpoint → the workflow files that schedule it. */
const scheduledBy = new Map<string, string[]>()
for (const w of workflows) {
  for (const e of new Set(w.endpoints)) {
    scheduledBy.set(e, [...(scheduledBy.get(e) ?? []), w.file])
  }
}

describe('production cron coverage', () => {
  it('finds the workflow set at all', () => {
    expect(workflows.length).toBeGreaterThan(0)
    for (const w of workflows) {
      expect(w.schedule, `${w.file} has no cron schedule`).toMatch(/^[\d*/ ,-]+$/)
    }
  })

  it('EVERY cron route is scheduled by a workflow', () => {
    const unscheduled = routeNames.filter(r => !scheduledBy.has(r))
    // A route with no driver never runs in production and fails silently.
    expect(unscheduled, `unscheduled cron routes: ${unscheduled.join(', ')}`).toEqual([])
  })

  it('no route is scheduled TWICE — double-firing is the other failure mode', () => {
    const duplicated = [...scheduledBy.entries()].filter(([, files]) => files.length > 1)
    expect(duplicated.map(([e, f]) => `${e} → ${f.join(' + ')}`)).toEqual([])
  })

  it('every scheduled endpoint corresponds to a real route — no dead schedules', () => {
    const orphans = [...scheduledBy.keys()].filter(e => !routeNames.includes(e))
    expect(orphans, `scheduled but no route exists: ${orphans.join(', ')}`).toEqual([])
  })

  it('vercel.json declares NO crons, so GitHub Actions stays the sole scheduler', () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))
    expect(vercel.crons ?? []).toEqual([])
  })

  it('every cron invocation authenticates with CRON_SECRET', () => {
    for (const w of workflows) {
      const raw = readFileSync(join(WORKFLOW_DIR, w.file), 'utf8')
      const calls   = invokedEndpoints(raw).length
      const bearers = [...raw.matchAll(/Authorization:\s*Bearer \$CRON_SECRET/g)].length
      expect(bearers, `${w.file}: ${calls} cron calls but ${bearers} authenticated`).toBe(calls)
    }
  })
})

describe('the two email drivers this event depends on', () => {
  it('email-broadcasts is driven by the 5-minute runners group', () => {
    const [file] = scheduledBy.get('email-broadcasts') ?? []
    expect(file).toBeDefined()
    expect(workflows.find(w => w.file === file)?.schedule).toBe('*/5 * * * *')
  })

  it('reminders is driven by the 10-minute recovery group', () => {
    const [file] = scheduledBy.get('reminders') ?? []
    expect(file).toBeDefined()
    expect(workflows.find(w => w.file === file)?.schedule).toBe('*/10 * * * *')
  })

  it('the documented setup guide exists and names GitHub as the scheduler', () => {
    const p = join(ROOT, 'docs', 'GITHUB_CRON_SETUP.md')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toMatch(/sole.{0,10}scheduler/i)
  })
})
