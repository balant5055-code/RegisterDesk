# Finisher Badges (RD-BADGE-01)

Shareable 1080×1080 PNG achievement badges, generated from published race results.

Full design: [`docs/RD-FINISHER-BADGES.md`](../../docs/RD-FINISHER-BADGES.md)

---

## The invariant

**A badge is built from the Official Snapshot and nothing else.**

`raceImportSessions` and its draft `results` are not in this module's import graph. Badge
generation calls `getLiveSnapshot`, which returns only `status === 'live'` snapshots. A badge
for an unpublished import is therefore *unreachable*, not merely forbidden.

## Layout

```
types/            SDK-free documents + render input
render/design.ts  PURE — every label, fallback and truncation (unit-tested)
render/renderBadge.tsx  IMPURE — JSX → PNG via next/og. Contains NO decisions.
repositories/     server-only Firestore metadata
services/         generation, storage, URL resolution
components/       BadgeShare (participant) · BadgeStatusClient (organizer)
tests/            29 cases
```

## How it renders

`next/og` (Satori + resvg), which **ships with Next.js** — no new dependency and no `sharp`.
Verified rendering a real 1080×1080 PNG in the **Node** runtime, so the same route can also
use firebase-admin.

Satori constraints when editing `renderBadge.tsx`: no CSS variables, no Tailwind (literal
values only), explicit `display` on every element with children, no `gap` on block layout,
and remote images must be optional because they are fetched at render time.

## Generation

**Lazy by default.** The first request for a published result renders and stores the PNG;
later requests serve the stored one. Organizers can pre-render in bulk from
Race Operations → Finisher Badges, or regenerate.

A snapshot version bump makes an existing badge stale and it re-renders automatically —
otherwise a participant could keep seeing a rank that was corrected.

## Status

| | |
|---|---|
| PNG generation | ✅ smoke-verified in Node |
| Storage integration | ✅ reuses `event-finisher-badge`, which Sprint 5 already defined |
| Runner page download + share | ✅ |
| Organizer status + regenerate | ✅ |
| Run against live R2 / Firestore | ❌ **never** — no credentials in this environment |

Not started: AI photo matching.
