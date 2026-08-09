# Race Operations (RD-RACEOPS-01)

An **isolated** organizer feature for publishing race results, managing race
photography, and reaching the existing certificate module.

Full architecture rationale: [`docs/RD-RACEOPS-01-phase0-audit.md`](../../docs/RD-RACEOPS-01-phase0-audit.md).

---

## Isolation contract

| Rule | Status |
|---|---|
| Nothing outside the module imports from inside it | ✅ only the 4 route files, and only via `features/race-operations/index.ts` |
| No new API route | ✅ reads the pre-existing `GET /api/organizer/events` and `GET /api/organizer/workspace` |
| No new Firestore collection, index, or rule | ✅ nothing is written; no collection is owned yet |
| No new permission model | ✅ reuses the existing team matrix — owner + `admin` |
| Existing certificate module untouched | ✅ linked to via `ROUTES.DASHBOARD_CERTIFICATES`; zero certificate files read or changed |
| Files modified outside the module | **2** — `config/navigation.ts`, `config/workspaceNav.ts` |

## Layout

```
types/          SDK-free domain vocabulary (no firebase-admin, no next/*, no React)
utils/          PURE helpers — unit-tested in tests/unit/raceOps*.test.ts
hooks/          client data access over EXISTING endpoints only
components/     module UI, composed from components/ui + components/admin
publish-results/  photos/  history/     feature slices
index.ts        the module's ONLY public surface
```

Directories reserved by the approved Phase 0 plan and **not yet created**, because
nothing would go in them this sprint: `services/`, `repositories/`, `validators/`,
`ranking/`, `import/`. They arrive with the sprint that first needs them.

## Access

`utils/access.ts` → `canAccessRaceOperations({ isOwner, role })` is the single
expression of the rule: **workspace owner, or an `admin` team member**. It mirrors
the server's `requireAdmin(callerUid, organizerUid)` (`lib/team/access.ts`).

This is **UI gating only**. From Sprint 3, every Race Operations route handler will
call `requireAdmin` server-side, which is the authoritative boundary.

## Key domain decision — distance = pass

RegisterDesk has no distance field. A race distance **is a pass** on the event
(`events/{slug}.pricing.passes[]`, optionally carrying
`raceDetails: { category, minAge, maxAge }`). The race selector therefore renders the
passes the organizer already configured — no schema change, no second source of truth.

## Sprint status

| Sprint | Scope | State |
|---|---|---|
| 1 | Navigation, pages, access gate, event + race selection, placeholders | ✅ **done** |
| 2 | Pure engines: time parsing, column mapping, row validation, ranking | pending approval |
| 3 | Upload → validate → preview (read-only; writes nothing) | pending |
| 4 | Import execution on the generic job kernel (`lib/jobs/`) | pending |
| 5 | Ranking + transactional publish / unpublish | pending |
| 6 | Certificate placeholder wiring — **needs explicit approval** (see audit · D3) | pending |
| 7 | Photos (Cloudflare R2) | pending |
| 8 | History timeline + rollback | pending |
