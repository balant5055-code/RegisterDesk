// RD-FEATURE-REQ-01 — Feature Requests: validation (both roles), the organizer-safe view,
// notification policy, duplicate suggestions, and the wiring that keeps every endpoint authorized
// and the rollout plan inert. The real routes + transactions are in tests/emulator/featureRequests.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  validateSubmission, validateAdminPatch, declineNeedsResponse, notifiesOrganizer, toOrganizerView,
  titleSimilarity, FEATURE_REQUEST_STATUSES, LIMITS,
} from '@/lib/featureRequests/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const good = {
  title: 'Bulk-edit pass prices', problem: 'Changing 20 pass prices one by one takes far too long before launch.',
  proposal: 'Select several passes and set a new price once; saves me an hour per event.', eventId: null, eventType: 'sports', organizerPriority: 'high',
}
const FLAGS = ['coupons', 'betaFeatures']

describe('organizer submission', () => {
  it('accepts a complete request and trims it', () => {
    const r = validateSubmission({ ...good, title: `  ${good.title}  ` })
    expect(r).toEqual({ ok: true, value: { ...good, title: good.title } })
  })

  it('stores ONLY the whitelisted fields — status, workspace and admin fields are ignored', () => {
    const r = validateSubmission({ ...good, status: 'released', workspaceUid: 'someone-else', adminPriority: 'p0', organizerResponse: 'x', rollout: { scope: 'all_eligible' } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(['eventId', 'eventType', 'organizerPriority', 'problem', 'proposal', 'title'])
  })

  it('reports every invalid field', () => {
    const r = validateSubmission({ title: 'short', problem: '', proposal: 'x'.repeat(LIMITS.proposal.max + 1), eventId: '../evil', eventType: 'rocket', organizerPriority: 'urgent' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['eventId', 'eventType', 'organizerPriority', 'problem', 'proposal', 'title'])
  })

  it('treats an empty event as "none"', () => {
    for (const eventId of ['', null, undefined]) {
      const r = validateSubmission({ ...good, eventId })
      expect(r.ok && r.value.eventId).toBe(null)
    }
  })
})

describe('Super Admin changes', () => {
  it('accepts only whitelisted fields', () => {
    const r = validateAdminPatch({ status: 'planned', workspaceUid: 'x', title: 'renamed', createdAt: 1, submittedBy: 'y' }, FLAGS)
    expect(r).toEqual({ ok: true, value: { status: 'planned' } })
  })

  it('refuses unknown statuses, priorities and an empty change', () => {
    expect(validateAdminPatch({ status: 'shipped' }, FLAGS).ok).toBe(false)
    expect(validateAdminPatch({ adminPriority: 'p9' }, FLAGS).ok).toBe(false)
    expect(validateAdminPatch({ expectedStatus: 'submitted' }, FLAGS)).toEqual({ ok: false, errors: { _: 'Nothing to change.' } })
    expect(validateAdminPatch({ duplicateOf: '../x' }, FLAGS).ok).toBe(false)
  })

  it('a rollout plan is always enforced:false, keeps only the list its scope uses, and names only existing flags', () => {
    const r = validateAdminPatch({ rollout: { scope: 'event_types', eventTypes: ['sports'], eventSlugs: ['a'], organizerUids: ['b'], flagKey: 'coupons', enforced: true } }, FLAGS)
    expect(r).toEqual({ ok: true, value: { rollout: { scope: 'event_types', eventSlugs: [], organizerUids: [], eventTypes: ['sports'], flagKey: 'coupons', enforced: false } } })
    expect(validateAdminPatch({ rollout: { scope: 'all_eligible', flagKey: 'invented' } }, FLAGS).ok).toBe(false)
    expect(validateAdminPatch({ rollout: { scope: 'selected_events', eventSlugs: [] } }, FLAGS).ok).toBe(false)
    expect(validateAdminPatch({ rollout: { scope: 'event_types', eventTypes: ['rocketry'] } }, FLAGS).ok).toBe(false)
    expect(validateAdminPatch({ rollout: { scope: 'selected_organizers', organizerUids: Array.from({ length: LIMITS.rolloutList + 1 }, (_, i) => `u${i}`) } }, FLAGS).ok).toBe(false)
  })

  it('a decline must explain itself', () => {
    expect(declineNeedsResponse('declined', null)).toBe(true)
    expect(declineNeedsResponse('declined', 'too short')).toBe(true)
    expect(declineNeedsResponse('declined', 'Not on our roadmap this year.')).toBe(false)
    expect(declineNeedsResponse('planned', null)).toBe(false)
  })

  it('every status except a return to Submitted notifies the organizer', () => {
    expect(FEATURE_REQUEST_STATUSES.filter(notifiesOrganizer)).toEqual(['under_review', 'planned', 'in_development', 'released', 'declined'])
  })
})

describe('the organizer view', () => {
  it('is a whitelist — no notes, rollout targets, admin ids or duplicate target', () => {
    const v = toOrganizerView('r1', {
      ...good, workspaceUid: 'ws', status: 'planned', organizerResponse: 'Coming soon', internalNotes: 'secret',
      adminPriority: 'p0', rollout: { scope: 'selected_organizers', organizerUids: ['other-org'] }, duplicateOf: 'r0', statusChangedBy: 'admin-1', updatedBy: 'admin-1',
    })
    const json = JSON.stringify(v)
    for (const leak of ['secret', 'p0', 'other-org', 'admin-1', 'r0', 'ws']) expect(json, leak).not.toContain(`"${leak}"`)
    expect(v).toMatchObject({ status: 'planned', organizerResponse: 'Coming soon', linkedToExisting: true })
  })
})

describe('duplicate suggestions', () => {
  it('score similar titles, ignore filler words', () => {
    expect(titleSimilarity('Bulk edit pass prices', 'Edit pass prices in bulk')).toBeGreaterThan(0.6)
    expect(titleSimilarity('Bulk edit pass prices', 'WhatsApp reminder templates')).toBe(0)
    expect(titleSimilarity('Add the ability to', 'Support an option for')).toBe(0)
  })
})

// ─── Wiring ────────────────────────────────────────────────────────────────────

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const n of readdirSync(resolve(process.cwd(), dir))) {
    const p = join(dir, n)
    if (statSync(resolve(process.cwd(), p)).isDirectory()) out.push(...routeFiles(p))
    else if (n === 'route.ts') out.push(p)
  }
  return out
}

describe('every endpoint is authorized', () => {
  it('organizer routes resolve the workspace before anything else', () => {
    const files = routeFiles('app/api/organizer/feature-requests')
    expect(files.length).toBe(2)
    for (const f of files) {
      const src = code(read(f))
      const handlers = src.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? []
      expect((src.match(/await authorizeWorkspace\(req, 'events'\)/g) ?? []).length, f).toBe(handlers.length)
    }
  })

  it('admin routes require a Super Admin on every handler', () => {
    const files = routeFiles('app/api/admin/feature-requests')
    expect(files.length).toBe(3)
    for (const f of files) {
      const src = code(read(f))
      const handlers = src.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? []
      expect((src.match(/await requireSuperAdmin\(req\)/g) ?? []).length, f).toBe(handlers.length)
      expect(src, f).not.toContain('resolveAdminUid')   // claim-only admins are refused
    }
  })

  it('history, audit and notification are staged in the same transaction as the change', () => {
    const svc = code(read('lib/featureRequests/service.ts'))
    const txn = svc.slice(svc.indexOf('export async function adminUpdateRequest'), svc.indexOf('export async function adminAddNote'))
    expect(txn).toContain("txn.create(historyRef, { from: current, to: nextStatus, actorUid: adminUid, actorRole: 'super_admin', at: now })")
    expect(txn).toContain('stageOutboxMessage(txn, outbox)')
    expect(txn).toContain("stageAdminAudit(txn, {")
    expect(txn).toContain('id: `feature-request_${idPart(id)}_${historyRef.id}`')   // one notification per change
  })
})

describe('a rollout plan enables nothing', () => {
  it('no code outside the feature-request module reads the plan', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(resolve(process.cwd(), dir))) {
        const p = join(dir, n)
        if (statSync(resolve(process.cwd(), p)).isDirectory()) { if (!['node_modules'].includes(n)) walk(p); continue }
        if (!/\.(ts|tsx)$/.test(n)) continue
        if (/featureRequests|feature-requests/.test(p)) continue
        if (/RolloutPlan|rollout\.(scope|eventSlugs|organizerUids|eventTypes|flagKey)/.test(read(p))) hits.push(p)
      }
    }
    for (const d of ['app', 'lib', 'components', 'features']) walk(d)
    expect(hits).toEqual([])
  })

  it('the existing flag resolver still ignores its context (no second flag system)', () => {
    expect(code(read('lib/config/resolveFeatureFlags.ts'))).toContain("return businessConfig.getSection('featureFlags')")
  })
})

describe('entry points', () => {
  it('the organizer top bar links to the request form', () => {
    expect(code(read('components/dashboard/DashboardHeader.tsx'))).toContain('href={`${ROUTES.DASHBOARD_FEATURE_REQUESTS}?new=1`}')
  })
  it('the Super Admin nav lists the console', () => {
    expect(code(read('config/navigation.ts'))).toContain("{ label: 'Feature Requests',  href: ROUTES.ADMIN_FEATURE_REQUESTS")
  })
  it('the form validates with the server’s own function', () => {
    expect(code(read('app/(dashboard)/dashboard/feature-requests/FeatureRequestsClient.tsx'))).toContain('const check = validateSubmission(body)')
  })
})
