# Event Builder Profiling Guide

**RD-EVENT-07.** How to measure Event Builder rendering, capture a baseline, and detect a
regression later. Any developer should be able to follow this without prior context.

> This guide measures. It does not change application behaviour, and neither does the
> harness — see [Safety](#safety).

---

## 1. Why not just the React DevTools Profiler

Use it — it gives flame charts and per-commit attribution that nothing here replaces.

But three of the Event Builder's costs are **invisible** to it, because they are not React
render work:

| Cost | Where | Why the Profiler misses it |
|---|---|---|
| `JSON.stringify` during render | [`useAutosaveEmit`](../lib/events/builder/useAutosaveEmit.ts) | Counted inside a component's render time, not broken out |
| `JSON.stringify` of the whole draft | `writeSnapshot` in [`useDraft`](../lib/hooks/useDraft.ts) | Runs in an event handler, outside any commit |
| Synchronous `localStorage.setItem` | same | Main-thread I/O, outside any commit |
| Autosave settle time | Firestore round-trip | Not React work at all |

So: run **both**. The DevTools Profiler for *where* render time goes, the harness for
*how often* renders happen and what the input path pays outside React.

---

## 2. Prerequisites

1. **React DevTools** browser extension installed.
2. **A production build _with React profiling enabled_.** This matters more than anything
   else in this guide:

   ```bash
   npm run profile:build && npm run profile:serve     # next build --profile
   ```

   > **Corrected by RD-EVENT-14.** This guide previously said `npm run build && npm start`.
   > That is not sufficient: React only records `actualDuration` on fibers in a **profiling
   > build**, so a plain production build reports every render duration as `0`. The run looks
   > successful and the numbers are meaningless. Always use `--profile`.
   >
   > For a fully automated capture, see
   > [RD-EVENT-14-PROFILING-AUTOMATION.md](./RD-EVENT-14-PROFILING-AUTOMATION.md).

   Development mode double-invokes render bodies under StrictMode and reports inflated
   durations. A dev capture is not comparable to a production one, and is not a valid
   baseline. The harness detects this from React's own `bundleType` flag and labels every
   run `development` / `production` — **if a report says `development`, discard it.**
3. A signed-in organizer account with a draft event.
4. Close other tabs. Profile on AC power. Run each scenario twice and keep the second.

---

## 3. Load the harness

```bash
npm run profile:builder      # prints the script; copy it
```

Paste into the DevTools console **on the builder page**. Then:

```js
__rd.start('pricing-edits')   // begin
//   ...perform the interaction...
__rd.stop()                   // prints tables, returns the result
__rd.export()                 // copies the full JSON to the clipboard
```

Other commands:

| Command | Purpose |
|---|---|
| `__rd.scenarios` | The six baseline scenario labels |
| `__rd.compare(baseline)` | Diff the last run against a pasted baseline object |
| `__rd.reset()` | Unpatch every global and restore the page |

`__rd.start()` warns if you pass a label outside the six — ad-hoc captures are fine, they
just are not comparable to a baseline.

---

## 4. The six required scenarios

Perform each **identically** every time you profile. The exact action is part of the
measurement; changing it invalidates the comparison.

| Label | Action | Notes |
|---|---|---|
| `basic-info-typing` | Details step → type exactly **20 characters** into Event Name | The primary autosave path |
| `event-type-selection` | Step 1 → click 3 different event types | No autosave wiring — the control |
| `pricing-edits` | Step 4 → edit one pass price, type **10 characters** | Largest draft payload |
| `registration-form-edits` | Step 5 → add 1 field, then type **10 characters** into its label | Array-heavy state |
| `branding-changes` | Details step → change a branding value | Shares the Details autosave path |
| `step-navigation` | Continue from Step 1 → 2 → 3, then Back twice | Mount/unmount cost, no typing |

Type at a **steady, natural pace**. Bursts and long pauses both distort
`commits/keystroke`, because a pause lets the 1,000 ms autosave debounce fire mid-scenario.

---

## 5. What gets captured

| Metric | Meaning |
|---|---|
| `commits` | React commits during the scenario |
| `commitsPerKeystroke` | **The headline number for typing scenarios.** 1.0 is ideal |
| `componentsRendered` | Distinct components that did non-zero render work |
| `totalComponentRenders` | Sum of individual component renders across all commits |
| `renderMs total / max` | Total and worst single-commit render time |
| `stringify calls / ms / KB` | Serialization count and volume |
| `localStorage writes / ms` | Synchronous main-thread writes |
| `autosave cycles / settle ms` | `Saving…` → `Saved` transitions and their duration |
| `contributors[]` | Per-component **self-time** (subtree time minus children), ranked |

---

## 6. Interpretation guide

Read these in order. Each rules out a different cause.

### `commitsPerKeystroke`

- **≈ 1.0** — the keystroke updated local state and nothing else. Healthy.
- **≈ 2.0** — something above the step is also re-rendering per keystroke. Look for the page
  component in `contributors`.
- **> 2.0** — a render loop or a cascading effect. Investigate before anything else; no
  amount of memoisation fixes a cascade.

### `contributors`

Ranked by **self-time**, so a parent that merely re-renders children stays small and the
real cost surfaces.

- A **step component** at the top is expected — it owns the UI being edited.
- **`CreateEventWizard` appearing during a typing scenario** means a page-level state update
  is firing per keystroke. That is a state-placement problem, not a memoisation one.
- A component with **high `renders` but low `selfMs`** is a memoisation candidate — cheap
  individually, but rendering far more often than its inputs change.
- A component with **low `renders` but high `selfMs`** is an expensive-render problem.
  Memoisation will not help; the render body needs work.

### `stringify calls`

Compare against `keystrokes`. More stringify calls than keystrokes means the same data is
being serialized more than once per edit. Check the `KB` figure too — a large payload
serialized once can cost more than a small one serialized three times.

### `localStorage writes`

Any number close to `keystrokes` means synchronous I/O on the input path. This does not
appear in React render time but does delay the next frame.

### `autosave settle ms`

`keystrokeToSavingMs` should sit near the 1,000 ms `DEBOUNCE_MS` in `useDraft`. Much lower
means the debounce is not coalescing. `settleMs` is the Firestore round-trip and will vary
with network — treat it as an outlier-prone number and compare medians across runs, not
single values.

### Interpreting a comparison

`__rd.compare(baseline)` prints delta and percentage per metric.

- **Counts** (`commits`, `stringifyCalls`, `localStorageWrites`) are structural — a change
  here reflects a real code change and is reliable even on a noisy machine.
- **Durations** (`renderMsTotal`, `autosaveSettleAvg`) are machine- and load-dependent.
  Treat anything under ±15% as noise unless it reproduces across three runs.

---

## 7. Capturing a baseline

1. Production build, per §2.
2. Run all six scenarios, `__rd.export()` after each.
3. Paste the JSON into a copy of [`RD-EVENT-07-BASELINE-TEMPLATE.md`](./RD-EVENT-07-BASELINE-TEMPLATE.md).
4. Commit it as `docs/baselines/event-builder-<yyyy-mm-dd>.md`.

Record the hardware and the commit SHA. A baseline without them cannot be compared to
anything later.

---

## 8. Detecting a regression

Before merging a change that touches builder state, `useDraft`, or any step component:

```js
// production build, same machine as the baseline
__rd.start('basic-info-typing')
// ...20 characters...
__rd.stop()
__rd.compare(BASELINE_BASIC_INFO)   // paste the baseline object
```

Treat as a **regression requiring justification**:

- `commitsPerKeystroke` increased at all
- `stringifyCalls` or `localStorageWrites` increased at all
- `renderMsTotal` increased > 15% and reproduces across three runs
- a component appears in `contributors` that was absent from the baseline

Counts are the reliable signal. If only durations moved, re-run before concluding anything.

---

## Safety

- The harness is **never imported by application code** and is not in any bundle. It lives
  in `scripts/profiling/` and is pasted in by hand.
- It patches `JSON.stringify`, `Storage.prototype.setItem` and the React DevTools commit
  hook. All three are restored by `__rd.reset()`, and all three are wrapped so that a
  failure inside the harness cannot break the page.
- It observes only the save-status element, resolved **once** at capture start —
  re-scanning the DOM per mutation would add measurable work to the interaction being
  measured.
- Patched functions add a `performance.now()` pair per call. This is small but not zero, so
  compare harness runs to harness runs, never to an unpatched measurement.
