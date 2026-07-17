# RegisterDesk v1.0 — General Availability Readiness

_Consolidated during GA-2 Sprint 8 (final GA validation). This document is
descriptive: it records the admin platform's Information Architecture, the reused
infrastructure behind each command center, environment variables, and the GA /
deployment checklists. It introduces **no** new behavior — code is the source of
truth; where this doc and the code disagree, the code wins._

---

## 1. Platform Overview

RegisterDesk is a Next.js 16 (App Router) + Firebase Admin SDK + Razorpay platform
with three shells:

- **Public** — marketing, event/campaign pages, registration, tickets, verification.
- **Organizer** (`/dashboard/*`) — event lifecycle, registrations, check-in,
  certificates, print, communications, reports, finance, team.
- **Admin** (`/admin/*`) — the enterprise control plane consolidated across GA-2.

All admin reads/writes are gated by `resolveAdminUid()` (Firebase custom claim
`admin === true` **or** uid present in `ADMIN_UIDS`). There is no admin RBAC — access
is a single binary role.

---

## 2. Admin Information Architecture (GA-2 S7)

Navigation is data-driven from [`config/navigation.ts`](../config/navigation.ts) and
rendered by the `(admin)` layout. Hero quick-links stay in the top bar; the full IA
lives in the grouped "More ▾" menu and the mobile drawer.

| Group | Pages (all existing routes) |
| --- | --- |
| **Hero** | Dashboard · Operations Center · Organizers · Finance · Support |
| **Operations** | Operations Center · Platform Monitor · Operations Health · Analytics · Reports |
| **Organizations** | Organizers *(Organizer 360 / Event 360 / Participant 360 are deep-link-only — reached via Organizers, Global Search, or Support)* |
| **Commerce** | Finance · License Center · Licenses · Top-ups · Clawbacks |
| **Governance** | Approvals · Moderation · Audit · Incidents |
| **Platform** | Communications · Reminders · Domains · Configuration · ID Migration |
| **Support** | Support Workspace · Global Search |

**Command palette:** `⌘K` / `Ctrl+K` anywhere in the admin shell (also the header
**Search** button) opens global search — navigation-only, recent/pinned in
localStorage.

---

## 3. GA-2 Command Centers & Reused Infrastructure

Every GA-2 workspace is **read-first** and **reuse-first**: a thin admin-gated
endpoint resolves the entity, calls an existing service, and returns a lightweight
DTO. Mutations always reuse an existing, audited route. No new engines were built.

| Workspace | Route | Reuses |
| --- | --- | --- |
| **Event 360** | `/admin/events/[slug]` | `getLicenseDetail`, `getEventStats`/counters, `getEventAnalytics`, `getBaseline`, `adminAuditLogs`; mutations via `POST /api/admin/licenses/[eventId]` (all 21 EA-4 actions), `…/review`, `PATCH …/[slug]` |
| **Organizer 360** | `/admin/organizers/[organizerUid]` | `getWorkspaceEntitlements`, `listTeam`, wallet/payout/settlement docs, counters, `adminAuditLogs`; mutations via `PATCH /api/admin/organizers/[uid]` + `…/plan` |
| **License & Coupon Center** | `/admin/license-center` | `listLicenses`, `getLicenseDetail`, `listCoupons`, `getAdminAnalytics`, `licenseHistory`; coupon engine (`licenseCouponService`) + all license actions |
| **Operations Center (NOC)** | `/admin/operations-center` | The generic job kernel (`lib/jobs`) + all 8 job collections; `cancelJob` for the only mutation (no retry engine exists) |
| **Platform Monitoring** | `/admin/platform-monitor` | `getAdminAnalytics`, `getAdminCommunications`, `getOperationsHealth`, Ops Center monitoring/timeline; honest "Unavailable" for underivable metrics |
| **Global Search** | `/admin/search` + `⌘K` | Existing bounded endpoints (`/organizers?search=`, `/licenses?search=`, `/license-coupons`) + one thin bounded events provider |
| **Support** | `/admin/support` | The global-search hook, the Ops/Monitor timelines, and bounded recent/count reads |

**Honesty rule (applied throughout):** metrics or entities that cannot be derived
without a collection scan are reported as **Unavailable** / omitted and documented —
never estimated. Examples: Firestore/Storage internals, global participant/payment
free-text search, and job **Retry/Restart** (kernel supports Cancel only).

---

## 4. Job Engines (Operations Center)

| Engine | Collection(s) | Cancel | Retry |
| --- | --- | --- | --- |
| Print | `printGenerationJobs`, `printPackageJobs` | ✅ `cancelJob` | ❌ not supported |
| Certificate | `certificateJobs` | ✅ | ❌ |
| Import | `registrationImportJobs` | ✅ | ❌ |
| Reports & Exports | `reportExportJobs` | ✅ | ❌ |
| Broadcast | `emailBroadcastJobs`, `whatsappBroadcastJobs` | ✅ | ❌ |
| Bulk | `registrationBulkJobs` | ✅ | ❌ |

All share the generic `Job` shape (`status`, `counts`, `error`, timestamps). Cancel
reuses the kernel; there is intentionally **no** generic retry engine.

---

## 5. Environment Variables

Names below are referenced in code (source of truth: `lib/env.ts`,
`lib/whatsapp/config.ts`, `lib/admin/auth.ts`, `lib/cron/auth.ts`,
`lib/certificates/urlGuard.ts`). Configure per environment; never commit secrets.

| Variable | Purpose |
| --- | --- |
| `ADMIN_UIDS` | Comma-separated admin uids (fallback to the `admin` custom claim) |
| `APP_URL`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_APP_URL` | Absolute base URLs (links, tokens) |
| `APP_VERSION` (opt.) | Surfaced in Platform Monitoring; falls back to `VERCEL_GIT_COMMIT_SHA`, else "Unavailable" |
| `CRON_SECRET` | Bearer secret for `/api/cron/*` |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signature verification |
| `FIREBASE_STORAGE_BUCKET` | Storage SSRF guard / uploads |
| `META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_BUSINESS_ACCOUNT_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_API_VERSION` | WhatsApp (Meta) integration |
| `SES_TIMEOUT_MS` (opt.) | Email (SES) request timeout |
| `NODE_ENV`, `VERCEL_ENV`, `NEXT_PHASE` | Runtime/build phase detection |

Firebase Admin credentials are provided via the platform's standard service-account
mechanism (see `lib/firebase/admin`). This table is not exhaustive — treat the
referenced modules as authoritative.

---

## 6. GA Checklist

- [x] `tsc --noEmit` clean
- [x] ESLint clean on all GA-2 surfaces
- [x] `next build` compiles successfully
- [x] Admin routes gated by `resolveAdminUid` (403 on non-admin)
- [x] All GA-2 reads bounded (counters / `.count()` aggregations / capped pages) — no scans
- [x] All mutations reuse existing audited routes (`logAdminAction`)
- [x] Command palette is keyboard-accessible (`⌘K`, ↑↓/Enter/Esc, focus restore, `role="dialog"`, live region)
- [x] Every command center reachable from the consolidated navigation
- [x] Honest "Unavailable" / omission for underivable metrics and unsupported ops
- [x] Backward compatible — no route, API, or schema change across GA-2

## 7. Deployment Checklist

1. Set all environment variables (§5) for the target environment.
2. Ensure Firestore composite indexes are deployed (`firestore.indexes.json`).
3. Confirm Razorpay keys + webhook secret and the webhook endpoint.
4. Configure Meta/WhatsApp credentials if broadcasts are enabled (else the service
   reports Unavailable — non-fatal).
5. Set `ADMIN_UIDS` and/or grant the `admin` custom claim to platform admins.
6. Verify `CRON_SECRET` and that scheduled jobs (broadcasts, webhooks, reconciliations,
   release-funds) are wired — health is visible in Operations Health + the NOC.
7. Run `next build` in the target pipeline; deploy.
8. Post-deploy smoke test: admin login → Dashboard → ⌘K search → open Event 360 /
   Organizer 360 / License Center / Operations Center / Platform Monitor / Support.

---

## 8. Release Notes — GA-2 (Enterprise Admin Platform)

- **S1 Event 360** — single command center per event (4 workspaces, all 21 EA-4
  license actions, health panel, merged timeline).
- **S2 Organizer 360** — single command center per organizer (overview / operations /
  business / governance).
- **S3 License & Coupon Center** — platform-wide license + coupon command center; the
  coupon engine gained a console.
- **S4 Operations Center (NOC)** — cross-engine background-job monitoring; Cancel via
  the kernel; Retry honestly unsupported.
- **S5 Platform Monitoring** — health dashboard (infrastructure / services /
  performance / security / observability) with strict "Unavailable" honesty.
- **S6 Global Search & Command Palette** — `⌘K` navigation over existing indexes only.
- **S7 Navigation IA + Support Workspace** — enterprise navigation consolidation and
  the operational support dashboard.
- **S8 GA validation** — design-system / a11y / performance / code-quality
  consolidation; this document.

All GA-2 changes are additive. No breaking changes, no API changes, no schema
changes, no migration required.
