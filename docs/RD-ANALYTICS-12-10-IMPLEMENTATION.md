# RD-ANALYTICS-12-10 — Reports Workspace Presentation Foundation

**Status:** complete. Presentation only — no backend, no report engine, no authorization, no
route or navigation change. Not committed, not pushed, not deployed.

---

## 1 · The previous selector

A wrap of eight identical pill buttons carrying nothing but a label:

```tsx
{REPORTS.map(r => (
  <button key={r.kind} onClick={() => setKind(r.kind)} className={…}>{r.label}</button>
))}
```

Choosing a report meant already knowing what it contained. Two further problems:

- **All eight were shown to every caller.** A manager holds `events` but never
  `transactions`/`settlements`/`wallet`, so seven of the eight doors slammed — and only
  after a click, as *"You do not have permission to view this report."*
- **The payout statement's PDF-only rule was restated locally**
  (`isStatement(def) ? ['pdf'] : ['csv','xlsx','pdf']`) — a third copy after its route and
  the catalogue.

## 2 · New discovery UI

A two-column list (single column below `sm`), each row a real `<button>` carrying the
catalogue's **label**, **description** and **formats**. Catalogue declaration order is display
order. Selection is signalled by border, tint **and** font-weight — never colour alone — with
`aria-pressed` and a visible focus ring.

Two columns rather than one because eight one-line rows push the filters below the fold on a
laptop; rows rather than cards because eight large cards is a marketing page, not a finance
workspace.

## 3 · Permission-filtered visibility

```ts
function visibleReports(has: (p) => boolean) { return REPORTS.filter(r => has(r.permission)) }
const perms     = useWorkspacePermissions()
const available = useMemo(() => visibleReports(perms.has), [perms.has])
```

`useWorkspacePermissions` is documented in its own header as *"a projection of the server's
matrix, not a copy"* — it derives from the same `ROLE_PERMISSIONS` array the server authorizes
against, so the two cannot drift. The permission checked is the catalogue's own.

**This grants nothing.** Server authorization is untouched and still enforced at five points:
the sync route (`authorizeWorkspace(req, meta.permission)` before `meta.build`), export
creation, poll, process/cancel, and download (`permissionForExportJob`). Tests 13-17 pin all
of them, and test 17 asserts the page contains no authorization decision of its own.

**Selection is derived, not corrected.** `kind` defaults to `'transactions'`, which a manager
cannot use. The obvious fix — an effect calling `setKind` once permissions resolve — is
rejected by React Compiler, correctly: this is a derivation, not a synchronisation. So `kind`
holds the user's *intent* and `def` holds what is actually shown:

```ts
const def = available.find(r => r.kind === kind) ?? available[0] ?? REPORTS.find(…) ?? REPORTS[0]
```

Two consequences had to follow, or the page would have acted on the wrong report: the preview
effect keys on `def.kind`, and the background export posts `kind: def.kind`. Test 25 pins the
second.

### Verified visibility

| Role | Permissions | Reports visible |
|---|---|---|
| owner | all | 8 |
| finance | wallet, settlements, transactions | 8 |
| admin | events, registrations, broadcasts, certificates, checkin, walkin, participants | **0** |
| manager | events, registrations, checkin, walkin, participants | **0** |
| checkin_lead / checkin_staff | gate only | **0** |

Asserted against the real `ROLE_PERMISSIONS` array (tests 6-12), and confirmed in a browser
for owner, finance and manager.

## 4 · Categories and search — deliberately omitted

Every catalogue entry is `category: 'financial'`, so **All Reports** and **Financial** would be
the same eight rows behind two tabs. A filter that never filters is scaffolding. Search over
eight rows is slower to use than reading them.

Both become worth adding when a second category or a longer list exists; the catalogue already
carries `category` for that day. No `Registrations`/`Operations`/`Communications`/`Participants`
placeholders were created (tests 18-19).

## 5 · Descriptions and formats

Both from `lib/reports/catalog.ts`. The local format ternary is gone —
`const formats = def.formats` — so the payout statement's PDF-only rule now has one definition
instead of three. Test 2 asserts no hardcoded label, description or format list survives in the
page.

## 6 · payout-statement

Unchanged and still specialized. The UI branches on `def.output === 'statement'` for its route,
preview, formats and the absence of background export. Its endpoint, builder, PDF rendering and
dispatch model were not touched, and it remains outside `ORGANIZER_REPORTS`.

Browser-confirmed: selecting it shows **PDF only**, hides the event/campaign/status filters, and
hides the background-export panel.

## 7 · Execution, filters and dates — preserved

`loadPreview`, `download`, `generateBackground`, `driveExport`, `cancelExport` and
`downloadExport` are untouched (test 24). Event/campaign/status filters remain, still only for
table reports. Dates remain two `<input type="date">` fields defaulting to the last 30 days,
resolved server-side to **inclusive UTC day bounds** — no presets, no timezone change
(test 27). No `EventSelector`, no `EventContextProvider` (test 28). No History (test 29).

## 8 · The defect browser QA found

Tests 1-33 passed and the page still had a real fault. With the report **list** hidden, a
manager saw:

> **No reports available** — *"Your workspace permissions don't include any of the finance
> reports."*

and directly beneath it: the filter bar, three download buttons, the "Large dataset?"
background-export panel, and a red **"You do not have permission to view this report."**

Controls for a report they cannot open, plus an error for a request the page had made on their
behalf. Only a rendered page shows that. The fix gates the whole body on the same condition and
suppresses the preview fetch:

```ts
const noneAvailable = !perms.loading && available.length === 0
…
if (!u || noneAvailable) return          // in loadPreview
{!noneAvailable && <> …filters, downloads, export, previews… </>}
```

`!perms.loading` matters: the hook answers optimistically until the workspace response lands,
so without it the page would flash "no reports" on every load. Test 30b now pins this.

## 9 · Responsive validation — performed

| Viewport | Result |
|---|---|
| 1440 | two columns, 0px overflow |
| 834 | two columns, 0px overflow |
| 390 | single column, descriptions readable, formats visible, 0px overflow |

Screenshots in `e2e/.shots/rd-analytics-12-10/`, read and inspected — not merely captured.

## 10 · Accessibility validation — performed

Real `<button type="button">` elements (no clickable divs), `aria-pressed` on each,
`role="group"` with `aria-label="Choose a report"`, and a `focus-visible` ring. Measured in the
browser: focusing a report and pressing **Enter** selects it (`aria-pressed="true"`), and the
focus ring resolves to a real box-shadow. Selection never depends on colour alone (test 33).

## 11 · Browser validation — performed

Emulator + seeded owner/finance/manager + `emu:build` + `emu:serve` (3187) + Playwright, with
screenshots read.

| Check | Result |
|---|---|
| owner sees 8 reports with descriptions | ✅ |
| finance sees 8 | ✅ |
| manager sees 0, with an explanation and no leaked names | ✅ |
| selection changes report and description | ✅ |
| statement → PDF only, no filters, no background export | ✅ |
| generic → CSV/XLSX/PDF, filters, background export | ✅ |
| preview still loads | ✅ |
| overflow at 1440 / 834 / 390 | 0px / 0px / 0px |
| keyboard focus + Enter selects | ✅ |
| console errors | one, attributed below |

**The `403 ← /api/organizer/events` for the finance role is not this page.** `finance` holds no
`events` permission, and that endpoint is called by the dashboard **shell**
(`EventContextProvider` / `EventSelector` / `CommandPalette`). The reports page fetches it zero
times — verified by grep. Correct authorization, pre-existing on every dashboard page for that
role, and out of scope here (the brief forbids touching those components).

One QA-script correction worth recording: the first run reported *"statement offers CSV/XLSX"*.
That was my assertion, not the app — it searched `innerText`, which contains the page subtitle
("…as CSV, Excel, or PDF") and every other row's format labels. Re-scoped to the download
buttons, and the screenshot confirms PDF only.

## 12 · Validation

| Gate | Result |
|---|---|
| focused — `reportsWorkspacePresentation.test.ts` | **34 passed** |
| catalogue/registry — `reportRegistryMetadata.test.ts` | **24 passed** |
| financial + export authorization (3 files) | **103 passed** |
| full unit suite | **331 files, 8992 collected: 8991 passed, 1 skipped, 0 failed, 0 timeouts** |
| TypeScript | **PASS** — exit 0 |
| ESLint | **PASS** |
| production build | **PASS** — exit 0, 35.9s |
| emulator | **not run** — no emulator-backed code path changed |

`tsconfig.json` restored (0 `next-a1210` entries); `.next-a1210` deleted.

## 13 · Files changed

| File | Why |
|---|---|
| `app/(dashboard)/dashboard/finance/reports/page.tsx` | Catalogue-driven discovery, permission filtering, derived selection, formats from metadata, empty state |
| `tests/unit/reportsWorkspacePresentation.test.ts` | **New** — 34 cases |
| `scripts/qa/rd-analytics-12-10-shots.mjs` | **New** — browser QA |
| `docs/RD-ANALYTICS-12-10-IMPLEMENTATION.md` | This document |

## 14 · Confirmations

- **No backend changed.** No API route, no server module.
- **No report builders changed.** `builders.ts`, `adminBuilders.ts`, `exportJob.ts`, `registry.ts`, `catalog.ts` all untouched.
- **No navigation or route changes.** `WORKSPACE_NAV`, sidebar, breadcrumbs, `/dashboard/reports`, `/dashboard/analytics`, `eventSetup/items.ts` untouched. Canonical route remains `/dashboard/finance/reports`.
- **No Firestore rules, indexes or collections changed.** The 12-07 settlement index remains **undeployed**.
- **No History implemented** — no job listing, no endpoint, no tab, no retention. That is 12-11.
- **No deploy, no commit, no push.**

## 15 · Outstanding

`docs/RD-ANALYTICS-12-01-IMPLEMENTATION.md` remains missing, as noted in earlier phases. Not
created here, per instruction.
