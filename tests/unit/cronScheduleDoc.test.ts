// RD-WALLET-W2.g (G11) — docs/RD-CRON-SCHEDULE.md must describe the schedule that actually runs:
// the GitHub Actions workflows. Parses the workflows (schedule + the real `curl` lines, in order —
// comments that merely NAME a route do not count) and compares them with the document's table.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const WORKFLOWS = readdirSync('.github/workflows').filter(f => /^cron-.*\.yml$/.test(f)).sort()

function workflow(file: string) {
  const src = read(`.github/workflows/${file}`)
  const schedule = /^\s+- cron: '([^']+)'/m.exec(src)?.[1] ?? null
  const routes = src.split('\n').filter(l => /^\s+curl /.test(l)).map(l => /api\/cron\/([a-z0-9-]+)/.exec(l)?.[1]).filter((r): r is string => !!r)
  return { schedule, routes }
}

function docRows() {
  const rows = new Map<string, { schedule: string; routes: string[] }>()
  for (const line of read('docs/RD-CRON-SCHEDULE.md').split('\n')) {
    const m = /^\| `(cron-[a-z-]+\.yml)` \| [^|]+ \| `([^`]+)` \| (.+) \|$/.exec(line)
    if (m) rows.set(m[1], { schedule: m[2], routes: [...m[3].matchAll(/`([a-z0-9-]+)`/g)].map(x => x[1]) })
  }
  return rows
}

describe('docs/RD-CRON-SCHEDULE.md matches the workflows that actually run', () => {
  const rows = docRows()

  it('one row per cron workflow, and no row for a workflow that does not exist', () => {
    expect(WORKFLOWS.length).toBeGreaterThan(0)
    expect([...rows.keys()].sort()).toEqual(WORKFLOWS)
  })

  it.each(WORKFLOWS)('%s — same schedule and the same routes, in the same order', file => {
    const wf = workflow(file)
    expect(wf.schedule, `${file} schedule`).not.toBeNull()
    expect(rows.get(file)).toEqual({ schedule: wf.schedule, routes: wf.routes })
  })

  it('every cron route is scheduled exactly once, and the document states the true count', () => {
    const scheduled = WORKFLOWS.flatMap(f => workflow(f).routes)
    const routes = readdirSync('app/api/cron').sort()
    expect([...scheduled].sort()).toEqual(routes)                                 // none missing, none twice
    expect(read('docs/RD-CRON-SCHEDULE.md')).toContain(`**${routes.length}** cron routes exist under \`app/api/cron/\`; **all ${routes.length}** are scheduled`)
  })

  it('vercel.json declares no crons (GitHub Actions is the only scheduler), as the document says', () => {
    const vercel = JSON.parse(read('vercel.json')) as { crons?: unknown[] }
    expect(vercel.crons ?? []).toEqual([])
    expect(read('docs/RD-CRON-SCHEDULE.md')).toContain('**`vercel.json`** is `{}` — it declares **no** crons')
  })

  it('G11 — the wallet reconciliation cadence in the prose is the one the workflow runs', () => {
    const recovery = workflow('cron-recovery.yml')
    expect(recovery.routes).toContain('wallet-reconciliation')
    expect(recovery.schedule).toBe('*/10 * * * *')
    expect(read('docs/RD-CRON-SCHEDULE.md')).toContain('**`wallet-reconciliation` — every 10 minutes** (Group B)')
    expect(read('docs/RD-CRON-SCHEDULE.md')).not.toMatch(/`wallet-reconciliation`[^\n|]*\| `\*\/5 \* \* \* \*`/)
  })
})
