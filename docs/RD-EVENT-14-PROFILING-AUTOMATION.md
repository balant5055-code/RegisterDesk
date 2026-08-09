# Automated Event Builder Profiling

**RD-EVENT-14.** Runs the [RD-EVENT-07 profiling workflow](./RD-EVENT-07-PROFILING.md) end to
end with no manual steps: signs in as an organizer, opens the Event Builder, performs each
scenario, and writes machine-readable results for regression comparison.

This is **development tooling only**. Nothing here is imported by application code or reaches
a production bundle.

---

## 1. The one thing that is easy to get wrong

**You must build with `--profile`.**

```bash
npm run profile:build     # next build --profile
npm run profile:serve     # next start
```

React only records `actualDuration` on fibers in a **profiling build**. A plain
`npm run build` produces a bundle where every render duration reads `0` — the harness will
still run, still write files, and still look successful, but every timing is meaningless.

> The RD-EVENT-07 guide said "profile a production build" without mentioning `--profile`.
> That was incomplete. A plain production build is necessary but not sufficient.

The harness reports `mode` from React's own `bundleType` flag and `assertComparable()` fails
the run if it is not `production`. That catches a *development* build. It does **not** catch a
production build made without `--profile` — that check is on you, and it is why
`profile:build` exists as a script rather than as an instruction.

---

## 2. Setup

### Install

Playwright is already a dev dependency. Fetch the browser once:

```bash
npx playwright install chromium
```

### Credentials

Never hardcoded, never committed. Set two environment variables:

```bash
export RD_PROFILE_EMAIL='profiling@your-domain.test'
export RD_PROFILE_PASSWORD='…'
```

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `RD_PROFILE_BASE_URL` | `http://localhost:3000` | Target origin |
| `RD_PROFILE_HEADED` | unset | `true` shows the browser (adds compositing cost — do not baseline with it) |
| `RD_PROFILE_OUT` | `e2e/.results/current` | Where results are written |

### The account

Use a **dedicated organizer account**, never a real customer's:

- **Email must be verified.** An unverified account is routed to OTP, which this harness
  will not automate and will not bypass. It fails with an explicit message instead.
- It needs at least one draft event, or the builder creates one on first Continue.
- Its draft **size matters** — `writeSnapshot` serialises the whole draft, so a baseline
  taken on an empty draft does not compare to one taken on a full event. Every result file
  records the draft shape under `draft`, and the comparison tool warns when it differs.

---

## 3. Authentication strategy

The harness drives the **real `/login` form** with real credentials. It does not mint custom
tokens, stub `AuthProvider`, or relax any Firestore rule or API guard.

That is a measurement decision as much as a security one: a profile captured against a
bypassed auth path describes a page that does not exist in production.

Login runs **once**, in a `setup` project, and the session is saved to
`e2e/.auth/organizer.json`. Every scenario reuses it. Logins are slow and rate-limited, and a
login inside a measured scenario would pollute the metrics.

`e2e/.auth/` and `e2e/.results/` are gitignored.

---

## 4. Running

```bash
npm run profile:build          # terminal 1 — MUST be --profile
npm run profile:serve
npm run profile:auth           # terminal 2 — once per session
npm run profile:run            # all five scenarios
```

One scenario:

```bash
npx playwright test --project=profile -g pricing-edits
```

Results land in `e2e/.results/current/<scenario>.json`.

---

## 5. Capturing a baseline

```bash
npm run profile:build && npm run profile:serve
npm run profile:auth
RD_PROFILE_OUT=e2e/.results/baseline-2026-07-29 npm run profile:run
```

Copy the directory to `docs/baselines/` and commit it, alongside the commit SHA and machine
details from [the baseline template](./RD-EVENT-07-BASELINE-TEMPLATE.md). A baseline without
its hardware and SHA cannot be compared to anything later.

Run each capture **twice and keep the second** — the first pays cold-start costs.

---

## 6. Comparing / detecting regressions

```bash
npm run profile:compare docs/baselines/event-builder-2026-07-29 e2e/.results/current
```

Exits non-zero when a regression is found, so it can gate a workflow.

**Counts and durations are judged differently, deliberately:**

- **Counts** — `commits`, `commitsPerKeystroke`, `stringifyCalls`, `localStorageWrites`,
  `totalComponentRenders`. Structural: they change only when code changes. **Any** increase
  is reported as a regression.
- **Durations** — `renderMsTotal`, `renderMsMax`, `autosaveSettleAvg`. Machine- and
  load-dependent. Movement under **±15%** is reported as noise, not as a result.

It also flags a component that has newly entered the top-5 contributors, and refuses to
compare runs whose `mode` differs.

---

## 7. Architecture

```
playwright.config.ts          workers:1, retries:0 — parallelism corrupts durations
e2e/
  auth.setup.ts               one real login → storageState
  event-builder.profile.ts    the five scenarios
  profiling/
    devtools-hook.ts          minimal DevTools hook (see below)
    auth.ts                   credentials + real form login
    builder.ts                navigation, step gates, draft description
    harness.ts                loads scripts/profiling/event-builder-profiler.js
scripts/profiling/
  event-builder-profiler.js   THE measurement logic — single source
  compare-baselines.mjs       regression diff
```

**The DevTools hook is the enabler.** The RD-EVENT-07 harness reads React's commit stream via
`window.__REACT_DEVTOOLS_GLOBAL_HOOK__`, normally supplied by the browser extension.
Playwright runs a clean Chromium with no extensions, so `e2e/profiling/devtools-hook.ts`
installs a minimal stub — `supportsFiber`, `renderers`, `inject`, `checkDCE`, and the commit
callbacks.

It must be installed with `page.addInitScript`, **before any application script runs**. React
probes for the hook once, at react-dom bootstrap. Inject it later and you get a run that
completes successfully with zero commits recorded.

**The measurement logic is not duplicated.** `harness.ts` reads the RD-EVENT-07 script from
disk and evaluates it in the page, so a manual console session and an automated run compute
identical numbers.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing profiling credentials` | env vars unset | See §2 |
| Routed to OTP verification | account email unverified | Verify once, manually. Not bypassable |
| `Captured in "development" mode` | dev server | `npm run profile:build && npm run profile:serve` |
| All `renderMs` are `0` | built without `--profile` | `npm run profile:build` |
| `commits: 0`, everything empty | DevTools hook missing or injected late | Confirm `addInitScript` runs in `beforeEach` |
| `Harness failed to install` | hook absent at bootstrap | Same as above |
| `autosave.cycles: 0` | capture ended before the 1s debounce | `capture()` already waits 2s; check the save indicator rendered |
| `Stuck advancing to step N` | a Continue gate is unsatisfied | The step needs real content; extend `satisfyCurrentStep` |
| Wildly varying durations | parallel work / thermal throttling | `workers: 1` is set; close other apps, run on AC power |

---

## Scope and limits

- The harness patches `JSON.stringify`, `Storage.prototype.setItem`, and the commit hook.
  All are restorable; each patch adds a `performance.now()` pair, so compare harness runs to
  harness runs only.
- Scenario selectors target the builder's current DOM. A step redesign may require updating
  `builder.ts` — that is expected maintenance, not a defect.
- `branding-changes` from the RD-EVENT-07 scenario list is **not** automated: it depends on
  the Photo Branding gate state, which is per-event and not reliably reachable from a fresh
  draft. Capture it manually with the console harness if you need it.
