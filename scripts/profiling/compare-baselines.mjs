/* RD-EVENT-14 — diff two directories of profiling results. DEV TOOL ONLY.
 *
 *   node scripts/profiling/compare-baselines.mjs <baselineDir> <currentDir>
 *
 * Counts vs durations are reported differently ON PURPOSE. Counts (commits, stringify calls,
 * localStorage writes) are structural: they change only when code changes, so any movement is
 * signal. Durations are machine- and load-dependent, so a threshold is applied and anything
 * under it is reported as noise rather than as an improvement or a regression.
 */
import fs from 'node:fs'
import path from 'node:path'

const [, , baseDir, curDir] = process.argv
if (!baseDir || !curDir) {
  console.error('usage: node scripts/profiling/compare-baselines.mjs <baselineDir> <currentDir>')
  process.exit(2)
}

const DURATION_NOISE_PCT = 15

const read = dir => {
  const out = {}
  if (!fs.existsSync(dir)) { console.error(`missing directory: ${dir}`); process.exit(2) }
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    out[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  }
  return out
}

const COUNTS = [
  ['commits', r => r.commits],
  ['commitsPerKeystroke', r => r.commitsPerKeystroke],
  ['componentsRendered', r => r.componentsRendered],
  ['totalComponentRenders', r => r.totalComponentRenders],
  ['stringifyCalls', r => r.stringify.n],
  ['localStorageWrites', r => r.localStorage.n],
]
const DURATIONS = [
  ['renderMsTotal', r => r.renderMs.total],
  ['renderMsMax', r => r.renderMs.max],
  ['autosaveSettleAvg', r => r.autosave.settleMs.avg],
]

const base = read(baseDir)
const cur = read(curDir)
let regressions = 0

for (const label of Object.keys(cur)) {
  const b = base[label], c = cur[label]
  if (!b) { console.log(`\n${label}: no baseline — skipped`); continue }
  if (b.mode !== c.mode) {
    console.log(`\n${label}: MODE MISMATCH (${b.mode} vs ${c.mode}) — not comparable`)
    continue
  }
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`)
  if (JSON.stringify(b.draft) !== JSON.stringify(c.draft)) {
    console.log(`   ! draft shape differs: ${JSON.stringify(b.draft)} → ${JSON.stringify(c.draft)}`)
    console.log('     Snapshot cost scales with draft size; treat this comparison as indicative.')
  }

  const rows = {}
  for (const [name, get] of COUNTS) {
    const was = get(b), is = get(c)
    if (typeof was !== 'number' || typeof is !== 'number') continue
    const delta = +(is - was).toFixed(2)
    const worse = delta > 0
    if (worse) regressions++
    rows[name] = { baseline: was, current: is, delta, verdict: delta === 0 ? '=' : worse ? 'REGRESSION' : 'improved' }
  }
  for (const [name, get] of DURATIONS) {
    const was = get(b), is = get(c)
    if (typeof was !== 'number' || typeof is !== 'number' || was === 0) continue
    const pct = ((is - was) / was) * 100
    const noise = Math.abs(pct) < DURATION_NOISE_PCT
    if (!noise && pct > 0) regressions++
    rows[name] = {
      baseline: was, current: is, delta: +(is - was).toFixed(2),
      verdict: noise ? `noise (${pct.toFixed(0)}%)` : pct > 0 ? `REGRESSION (+${pct.toFixed(0)}%)` : `improved (${pct.toFixed(0)}%)`,
    }
  }
  console.table(rows)

  const top = (r) => (r.contributors ?? []).slice(0, 5).map(x => x.component)
  const appeared = top(c).filter(x => !top(b).includes(x))
  if (appeared.length) console.log(`   ! new in top-5 contributors: ${appeared.join(', ')}`)
}

console.log(`\n${regressions === 0 ? 'No regressions detected.' : `${regressions} regression(s) detected.`}`)
process.exit(regressions === 0 ? 0 : 1)
