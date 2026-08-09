# Event Builder Performance Baseline — `<yyyy-mm-dd>`

Copy this file to `docs/baselines/event-builder-<yyyy-mm-dd>.md` and fill it in.
Procedure: [RD-EVENT-07-PROFILING.md](./RD-EVENT-07-PROFILING.md).

---

## Capture conditions

A baseline without these is not comparable to anything later. Fill in every row.

| | |
|---|---|
| Commit SHA | `` |
| Date | |
| Captured by | |
| **Build mode** | `production` — **a `development` capture is not a valid baseline** |
| Command used | `npm run build && npm start` |
| Browser + version | |
| Machine (CPU / RAM) | |
| On AC power | yes / no |
| CPU throttling | none / 4× / 6× |
| Network throttle | none / Fast 3G / … |
| Draft size | _passes: _, form fields: _, has branding: yes/no_ |
| Run kept | 2nd of 2 (per §2) |

> Draft size matters: `writeSnapshot` serializes the **whole** draft, so a baseline taken on
> an empty draft will not compare to one taken on a full event.

---

## Summary

Fill from each `__rd.stop()` table. `—` where a metric does not apply (e.g. keystrokes in
`step-navigation`).

| Scenario | commits | commits/key | components | renderMs total | renderMs max | stringify n | stringify KB | localStorage n | autosave settle ms |
|---|---|---|---|---|---|---|---|---|---|
| `basic-info-typing` | | | | | | | | | |
| `event-type-selection` | | — | | | | | | | |
| `pricing-edits` | | | | | | | | | |
| `registration-form-edits` | | | | | | | | | |
| `branding-changes` | | | | | | | | | |
| `step-navigation` | | — | | | | | | | |

---

## Largest render contributors

Top 5 per scenario from the `contributors` table.

### `basic-info-typing`

| Component | renders | selfMs |
|---|---|---|
| | | |

### `event-type-selection`

| Component | renders | selfMs |
|---|---|---|
| | | |

### `pricing-edits`

| Component | renders | selfMs |
|---|---|---|
| | | |

### `registration-form-edits`

| Component | renders | selfMs |
|---|---|---|
| | | |

### `branding-changes`

| Component | renders | selfMs |
|---|---|---|
| | | |

### `step-navigation`

| Component | renders | selfMs |
|---|---|---|
| | | |

---

## Observations

Only what the numbers show. Keep interpretation in the analysis section below, so a future
reader can re-derive conclusions from the raw data.

-

## Analysis

Apply §6 of the guide.

- **Cascades** (`commits/keystroke` > 2):
- **Memoisation candidates** (high renders, low selfMs):
- **Expensive renders** (low renders, high selfMs):
- **State-placement problems** (page component rendering during typing):
- **Non-render costs** (stringify / localStorage on the input path):

## Anomalies and caveats

Anything that would mislead a future reader — a scenario that could not be performed as
written, an outlier run, a metric that came back empty.

-

---

## Raw captures

Paste each `__rd.export()` payload verbatim. This is what makes the baseline
machine-comparable via `__rd.compare()` — the tables above are for humans.

<details><summary><code>basic-info-typing</code></summary>

```json

```
</details>

<details><summary><code>event-type-selection</code></summary>

```json

```
</details>

<details><summary><code>pricing-edits</code></summary>

```json

```
</details>

<details><summary><code>registration-form-edits</code></summary>

```json

```
</details>

<details><summary><code>branding-changes</code></summary>

```json

```
</details>

<details><summary><code>step-navigation</code></summary>

```json

```
</details>
