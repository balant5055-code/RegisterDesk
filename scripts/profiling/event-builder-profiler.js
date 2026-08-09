/* RD-EVENT-07 — Event Builder render profiler. DEV TOOL ONLY.
 *
 * This file is NEVER imported by application code and never reaches a bundle. It is pasted
 * into the DevTools console by hand, or printed with `npm run profile:builder`.
 *
 * ─── Why this exists alongside the React DevTools Profiler ───────────────────
 * The Profiler measures React render work. Three of the costs that matter most in this
 * builder are invisible to it:
 *
 *   • JSON.stringify   — runs during render in useAutosaveEmit, and again over the whole
 *                        draft in useDraft.writeSnapshot
 *   • localStorage     — a SYNCHRONOUS main-thread write on the input path
 *   • autosave latency — the wall-clock gap between a keystroke and "Saved"
 *
 * So this harness patches those three directly and correlates them with the commit stream.
 * It is additive: run the React DevTools Profiler at the same time if you want flame charts.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   __rd.start('pricing-edits')
 *   ...perform the interaction...
 *   __rd.stop()            // prints tables, returns the result object
 *   __rd.export()          // copies the full JSON run to the clipboard
 *   __rd.compare(baseline) // diffs the current run against a pasted baseline object
 *   __rd.reset()           // unpatch everything and restore the page
 *
 * Numbers are only comparable within the same build mode. ALWAYS profile a production
 * build (`npm run build && npm start`) — dev-mode React double-invokes render bodies under
 * StrictMode and reports inflated durations. See docs/RD-EVENT-07-PROFILING.md.
 */
(() => {
  if (window.__rd) { console.warn('__rd already installed — call __rd.reset() first.'); return }

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (!hook) {
    console.error('React DevTools not detected. Install the extension and reload the page.')
    return
  }

  /** The six scenarios RD-EVENT-06 defined. Any other label is accepted, but these are the
   *  ones a baseline must contain to be comparable. */
  const SCENARIOS = [
    'basic-info-typing',
    'event-type-selection',
    'pricing-edits',
    'registration-form-edits',
    'branding-changes',
    'step-navigation',
  ]

  const S = {
    on: false, label: '', t0: 0,
    commits: [], stringify: [], storage: [], keys: [], autosave: [],
  }

  const now = () => performance.now()
  const since = () => now() - S.t0

  // ── 1. Commit stream ───────────────────────────────────────────────────────
  // A fiber's actualDuration is the time to render its whole subtree in this commit.
  // Subtracting the children's total leaves that component's own render cost.
  const walk = (fiber, out) => {
    if (!fiber) return 0
    let childTotal = 0
    for (let c = fiber.child; c; c = c.sibling) childTotal += walk(c, out)
    const total = fiber.actualDuration || 0
    const self = Math.max(0, total - childTotal)
    const t = fiber.type
    const name =
      typeof t === 'function' ? (t.displayName || t.name || 'Anonymous')
      : typeof t === 'object' && t !== null ? (t.displayName || t.name || 'Memo/ForwardRef')
      : null
    if (name && self > 0) {
      const e = out.get(name) || { count: 0, self: 0 }
      e.count++; e.self += self
      out.set(name, e)
    }
    return total
  }

  const prevCommit = hook.onCommitFiberRoot
  hook.onCommitFiberRoot = function (id, root, ...rest) {
    if (S.on) {
      try {
        const components = new Map()
        const duration = walk(root.current, components)
        S.commits.push({ at: since(), duration, components })
      } catch { /* never break the app while profiling */ }
    }
    return prevCommit ? prevCommit.call(this, id, root, ...rest) : undefined
  }

  // ── 2. Serialization ───────────────────────────────────────────────────────
  const realStringify = JSON.stringify
  JSON.stringify = function (...a) {
    if (!S.on) return realStringify.apply(this, a)
    const s = now()
    const r = realStringify.apply(this, a)
    S.stringify.push({ at: s - S.t0, ms: now() - s, bytes: r ? r.length : 0 })
    return r
  }

  // ── 3. Synchronous storage ─────────────────────────────────────────────────
  const realSet = Storage.prototype.setItem
  Storage.prototype.setItem = function (k, v) {
    if (!S.on) return realSet.call(this, k, v)
    const s = now()
    const r = realSet.call(this, k, v)
    S.storage.push({ at: s - S.t0, ms: now() - s, bytes: (v || '').length, key: k })
    return r
  }

  // ── 4. Input ───────────────────────────────────────────────────────────────
  const onKey = () => { if (S.on) S.keys.push({ at: since() }) }
  window.addEventListener('keydown', onKey, true)

  // ── 5. Autosave latency ────────────────────────────────────────────────────
  // Measured from the DOM, because the save pipeline is internal: SaveStatusIndicator is the
  // user-visible contract. We watch its text for the saving→saved transition and report the
  // gap from the keystroke that started it.
  let saveObserver = null
  let savingSince = null
  let statusHost = null

  /** Resolve the status container ONCE. Re-scanning the DOM on every mutation would add
   *  measurable work to the very interaction being measured. The indicator swaps its inner
   *  <span> per state, so we cache the parent and read its textContent. */
  const resolveStatusHost = () => {
    const leaf = [...document.querySelectorAll('span')].find(n =>
      /^(Saving|Saved|Last saved|Retrying|Offline)/i.test((n.textContent || '').trim()))
    return leaf ? leaf.parentElement : null
  }
  const statusText = () => (statusHost ? (statusHost.textContent || '').trim() : null)

  const startObserver = () => {
    statusHost = resolveStatusHost()
    if (!statusHost) {
      console.warn('Save status indicator not found — autosave timing will be empty. '
        + 'Make one edit so it renders, then restart the capture.')
      return
    }
    let last = statusText()
    saveObserver = new MutationObserver(() => {
      const t = statusText()
      if (t === last) return
      const at = since()
      if (/saving/i.test(t || '')) {
        savingSince = at
        const k = S.keys.length ? S.keys[S.keys.length - 1].at : null
        S.autosave.push({ startedAt: at, sinceLastKeystrokeMs: k === null ? null : +(at - k).toFixed(1), settledMs: null, state: 'saving' })
      } else if (/saved/i.test(t || '') && savingSince !== null) {
        const rec = S.autosave[S.autosave.length - 1]
        if (rec && rec.settledMs === null) rec.settledMs = +(at - savingSince).toFixed(1)
        savingSince = null
      }
      last = t
    })
    saveObserver.observe(statusHost, { subtree: true, childList: true, characterData: true })
  }

  // ── Reporting ──────────────────────────────────────────────────────────────
  const sum = a => a.reduce((x, y) => x + y, 0)
  const round = n => +n.toFixed(2)
  const stat = a => a.length
    ? { n: a.length, total: round(sum(a)), avg: round(sum(a) / a.length), max: round(Math.max(...a)) }
    : { n: 0, total: 0, avg: 0, max: 0 }

  const detectMode = () => {
    try {
      for (const r of hook.renderers.values()) {
        if (typeof r.bundleType === 'number') return r.bundleType === 1 ? 'development' : 'production'
      }
    } catch { /* fall through */ }
    return 'unknown'
  }

  const build = () => {
    const durations = S.commits.map(c => c.duration)
    const agg = new Map()
    for (const c of S.commits) {
      for (const [name, e] of c.components) {
        const a = agg.get(name) || { renders: 0, selfMs: 0 }
        a.renders += e.count; a.selfMs += e.self
        agg.set(name, a)
      }
    }
    const contributors = [...agg.entries()]
      .map(([component, a]) => ({ component, renders: a.renders, selfMs: round(a.selfMs) }))
      .sort((x, y) => y.selfMs - x.selfMs)

    const settled = S.autosave.filter(a => a.settledMs !== null).map(a => a.settledMs)
    const debounce = S.autosave.filter(a => a.sinceLastKeystrokeMs !== null).map(a => a.sinceLastKeystrokeMs)

    return {
      label: S.label,
      capturedAt: new Date().toISOString(),
      // React's own flag, not a guess: bundleType 1 = development, 0 = production.
      // A development capture is NOT comparable to a production one — StrictMode
      // double-invokes render bodies and durations are inflated.
      mode: detectMode(),
      durationMs: round(since()),
      commits: S.commits.length,
      keystrokes: S.keys.length,
      commitsPerKeystroke: S.keys.length ? round(S.commits.length / S.keys.length) : null,
      componentsRendered: contributors.length,
      totalComponentRenders: contributors.reduce((n, c) => n + c.renders, 0),
      renderMs: stat(durations),
      stringify: { ...stat(S.stringify.map(x => x.ms)), kb: round(sum(S.stringify.map(x => x.bytes)) / 1024) },
      localStorage: { ...stat(S.storage.map(x => x.ms)), kb: round(sum(S.storage.map(x => x.bytes)) / 1024) },
      autosave: { cycles: S.autosave.length, settleMs: stat(settled), keystrokeToSavingMs: stat(debounce) },
      contributors,
    }
  }

  window.__rd = {
    scenarios: SCENARIOS,
    last: null,

    start(label) {
      if (label && !SCENARIOS.includes(label)) {
        console.warn(`"${label}" is not one of the six baseline scenarios — it will not be comparable.\n` + SCENARIOS.join(', '))
      }
      S.on = true; S.label = label || 'ad-hoc'; S.t0 = now()
      S.commits = []; S.stringify = []; S.storage = []; S.keys = []; S.autosave = []
      savingSince = null
      startObserver()
      console.log('%c▶ ' + S.label, 'color:#6204e3;font-weight:bold')
    },

    stop() {
      S.on = false
      if (saveObserver) { saveObserver.disconnect(); saveObserver = null }
      const r = build()
      this.last = r

      console.log('%c■ ' + r.label + '  (' + r.mode + ')', 'color:#f61e7d;font-weight:bold')
      console.table({
        commits:               { value: r.commits },
        keystrokes:            { value: r.keystrokes },
        'commits/keystroke':   { value: r.commitsPerKeystroke ?? '—' },
        componentsRendered:    { value: r.componentsRendered },
        totalComponentRenders: { value: r.totalComponentRenders },
        'renderMs total':      { value: r.renderMs.total },
        'renderMs max commit': { value: r.renderMs.max },
        'stringify calls':     { value: r.stringify.n },
        'stringify ms':        { value: r.stringify.total },
        'stringify KB':        { value: r.stringify.kb },
        'localStorage writes': { value: r.localStorage.n },
        'localStorage ms':     { value: r.localStorage.total },
        'autosave cycles':     { value: r.autosave.cycles },
        'autosave settle ms':  { value: r.autosave.settleMs.avg },
      })
      console.log('%cLargest render contributors (self-time)', 'font-weight:bold')
      console.table(r.contributors.slice(0, 20))
      console.log('__rd.export() to copy JSON · __rd.compare(baseline) to diff')
      return r
    },

    export() {
      const json = realStringify(this.last, null, 2)
      if (navigator.clipboard) navigator.clipboard.writeText(json).then(
        () => console.log('Copied to clipboard.'),
        () => console.log(json))
      else console.log(json)
      return json
    },

    /** Diff the last run against a baseline object captured earlier. */
    compare(baseline) {
      if (!this.last) { console.error('No run yet — call __rd.start()/__rd.stop() first.'); return }
      if (!baseline || baseline.label !== this.last.label) {
        console.warn('Comparing different scenarios — results are not meaningful.')
      }
      const pick = r => ({
        commits: r.commits,
        commitsPerKeystroke: r.commitsPerKeystroke,
        renderMsTotal: r.renderMs.total,
        renderMsMax: r.renderMs.max,
        stringifyCalls: r.stringify.n,
        stringifyKB: r.stringify.kb,
        localStorageWrites: r.localStorage.n,
        autosaveSettleAvg: r.autosave.settleMs.avg,
      })
      const b = pick(baseline), c = pick(this.last)
      const rows = {}
      for (const k of Object.keys(b)) {
        const was = b[k], is = c[k]
        const delta = (typeof was === 'number' && typeof is === 'number') ? round(is - was) : '—'
        const pct = (typeof was === 'number' && was !== 0 && typeof is === 'number')
          ? round(((is - was) / was) * 100) + '%' : '—'
        rows[k] = { baseline: was, current: is, delta, change: pct }
      }
      console.table(rows)
      return rows
    },

    /** Restore every patched global. Call before reloading or re-installing. */
    reset() {
      S.on = false
      if (saveObserver) { saveObserver.disconnect(); saveObserver = null }
      JSON.stringify = realStringify
      Storage.prototype.setItem = realSet
      hook.onCommitFiberRoot = prevCommit
      window.removeEventListener('keydown', onKey, true)
      delete window.__rd
      console.log('__rd removed; globals restored.')
    },
  }

  console.log('%c__rd ready', 'color:#6204e3;font-weight:bold')
  console.log('Scenarios: ' + SCENARIOS.join(', '))
})()
