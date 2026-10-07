// RD-ORGANIZER-REMAINING-ALL — the organizer deletion manifest, and what must never be in it.
//
// ═══ WHAT THESE TESTS ARE ACTUALLY PROTECTING ════════════════════════════════
// The behaviour — does it block, does it delete, does it resume — is proved against real
// Firestore in tests/emulator/organizerDeletion.emu.test.ts. What CANNOT be proved there is the
// negative: that a collection nobody thought about did not quietly end up in the delete plan.
//
// So the assertions below are mostly about absence. Every financial collection, every shared
// collection, and every event-scoped collection is checked against the manifest and must NOT
// appear — and the ordering constraints that make the job safe to interrupt are pinned
// positionally, because "Auth last" is not a property you can observe from a passing run.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildOrganizerDeletionManifest,
  ORGANIZER_RETAINED_COLLECTIONS,
  SHARED_COLLECTIONS,
  encodeProgress, decodeProgress,
  ORGANIZER_DELETION_JOBS,
  type OrganizerDeletionStep,
} from '@/lib/admin/organizerDeletionManifest'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

const UID = 'org-under-test'
const manifest = buildOrganizerDeletionManifest(UID)

/** Every collection the manifest touches, however it is addressed. */
function collectionsTouched(steps: OrganizerDeletionStep[]): string[] {
  const out = new Set<string>()
  for (const s of steps) {
    if (s.kind === 'query') out.add(s.collection)
    if (s.kind === 'doc') out.add(s.path.split('/')[0])
    if (s.kind === 'subcollection') out.add(s.name)
  }
  return [...out]
}

const touched = collectionsTouched(manifest)
const labels  = manifest.map(s => s.label)
const at      = (label: string) => labels.indexOf(label)

// ═══ 1 · the manifest is explicit, and scoped to this organizer ════════════════

describe('the manifest', () => {
  it('is non-empty and every step is scoped to the target uid', () => {
    expect(manifest.length).toBeGreaterThan(10)
    for (const s of manifest) {
      const scope =
        s.kind === 'query'              ? s.value
        : s.kind === 'doc'              ? s.path
        : s.kind === 'subcollection'    ? s.parentPath
        : s.kind === 'storagePrefix'    ? s.prefix
        : s.kind === 'staffUsernameLocks' || s.kind === 'staffAuthUsers' ? s.organizerUid
        : s.uid
      expect(scope, `step ${s.label} is not scoped to the uid`).toContain(UID)
    }
  })

  it('every label is unique, so progress is unambiguous in a report', () => {
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('scopes every query by an ownership field, never by a free-text match', () => {
    // All three are uid fields, which is the property that matters: each identifies a
    // SUBJECT by its Firebase uid, so a step can only ever match rows belonging to the
    // account being deleted. `memberUid` (RD-WORKSPACE-OWNERSHIP-01) names the uid a
    // membership grants access TO — the grants this organizer HELD, as opposed to
    // `organizerUid`, which names the workspace they OWNED.
    //
    // The exclusion this case exists for is unchanged: never an email, a name or any
    // other free text, because those can collide with a different person's record.
    const UID_FIELDS = ['organizerUid', 'memberUid', 'uid']
    for (const s of manifest) {
      if (s.kind !== 'query') continue
      expect(UID_FIELDS, `${s.label} scoped by ${s.field}`).toContain(s.field)
      expect(s.value, `${s.label} is not scoped to the uid`).toBe(UID)
    }
  })

  it('addresses storage ONLY by a uid-scoped prefix ending in a slash', () => {
    const prefixes = manifest.filter(s => s.kind === 'storagePrefix')
    expect(prefixes.length).toBeGreaterThan(0)
    for (const s of prefixes) {
      if (s.kind !== 'storagePrefix') continue
      // The trailing slash is what stops `organizer-assets/abc` also matching `…/abcdef/`.
      expect(s.prefix.endsWith('/'), `${s.label} prefix lacks a trailing slash`).toBe(true)
      expect(s.prefix).toContain(`/${UID}/`)
      expect(s.prefix).not.toContain('..')
    }
  })
})

// ═══ 2 · NOTHING financial, shared or event-scoped is in the plan ══════════════

describe('what the manifest must never touch', () => {
  it('no financial or audit collection', () => {
    for (const c of ORGANIZER_RETAINED_COLLECTIONS) {
      expect(touched, `manifest deletes retained collection ${c}`).not.toContain(c)
    }
  })

  it('no shared or platform collection', () => {
    for (const c of SHARED_COLLECTIONS) {
      expect(touched, `manifest deletes shared collection ${c}`).not.toContain(c)
    }
  })

  it('no event-scoped collection — that is eventDeletion’s job, not this one', () => {
    // Eligibility guarantees zero events, so these can only be empty. Listing them anyway
    // would imply this manifest is a safe way to remove event data. It is not.
    const eventScoped = [
      'events', 'registrations', 'registrationAuditLogs', 'registrationCounters',
      'waitlists', 'waitlistCounters', 'certificateRecords', 'certificateTemplates',
      'identifierConfigs', 'identifierLocks', 'identifierCounters', 'bibLocks',
      'speakerApplications', 'sponsorApplications', 'eventNominations',
      'donationCampaigns', 'donationCounters', 'coupons', 'scheduledReminders',
      'raceResultSnapshots', 'attendanceShards', 'emailLogs',
    ]
    for (const c of eventScoped) {
      expect(touched, `manifest deletes event-scoped collection ${c}`).not.toContain(c)
    }
  })

  it('the two classification lists do not overlap', () => {
    const shared = new Set<string>(SHARED_COLLECTIONS)
    for (const c of ORGANIZER_RETAINED_COLLECTIONS) {
      expect(shared.has(c), `${c} is both retained and shared`).toBe(false)
    }
  })

  it('the module contains no blanket "delete everything by uid" sweep', () => {
    const src = code('lib/admin/organizerDeletion.ts')
    // The one strategy this whole design exists to avoid.
    expect(src).not.toMatch(/listCollections\(\)/)
    expect(src).not.toMatch(/recursiveDelete/)
    expect(src).not.toMatch(/bulkWriter/i)
  })
})

// ═══ 3 · ORDERING — the part a passing run cannot demonstrate ═════════════════

describe('ordering', () => {
  it('Firebase Auth is the LAST step, and there is exactly one', () => {
    const authSteps = manifest.filter(s => s.kind === 'auth')
    expect(authSteps).toHaveLength(1)
    expect(manifest[manifest.length - 1].kind).toBe('auth')
  })

  it('the user profile is deleted second-to-last, after everything it anchors', () => {
    // While `users/{uid}` exists the account is still identifiable and the job is still
    // attributable. Deleting the anchor early would strand whatever remained.
    expect(at('userProfile')).toBe(manifest.length - 2)
  })

  it('every subcollection of the user is removed BEFORE the user document', () => {
    for (const s of manifest) {
      if (s.kind !== 'subcollection') continue
      expect(at(s.label), `${s.label} runs after userProfile`).toBeLessThan(at('userProfile'))
    }
  })

  it('staff username locks and staff Auth users are removed BEFORE staffAccounts', () => {
    // Both are found THROUGH staffAccounts. Deleting the staff rows first would strand a
    // global `staffUsernames` lock with no owner — reserving that username for nobody, for ever.
    expect(at('staffUsernames')).toBeLessThan(at('staffAccounts'))
    expect(at('staffAuthUsers')).toBeLessThan(at('staffAccounts'))
  })

  it('staff Auth users are removed before the organizer’s own Auth user', () => {
    expect(at('staffAuthUsers')).toBeLessThan(at('authUser'))
  })

  it('storage is cleaned before the identity is destroyed', () => {
    for (const s of manifest) {
      if (s.kind !== 'storagePrefix') continue
      expect(at(s.label)).toBeLessThan(at('authUser'))
    }
  })
})

// ═══ 4 · the resume cursor ════════════════════════════════════════════════════

describe('the progress cursor', () => {
  it('round-trips the step and the count', () => {
    const p = { step: 7, deleted: 431, failures: ['x'] }
    const back = decodeProgress(encodeProgress(p))
    expect(back.step).toBe(7)
    expect(back.deleted).toBe(431)
  })

  it('starts from the beginning for an absent or unusable cursor', () => {
    for (const c of [null, '', 'garbage', '-1:-1:0', 'NaN:NaN:0']) {
      const p = decodeProgress(c)
      expect(p.step).toBe(0)
      expect(p.deleted).toBe(0)
    }
  })

  it('never resumes with a negative step, which would re-run nothing', () => {
    expect(decodeProgress('-5:10:0').step).toBe(0)
  })
})

// ═══ 5 · the API contract ═════════════════════════════════════════════════════

describe('the admin delete endpoint', () => {
  const src = code('app/api/admin/organizers/[uid]/delete/route.ts')

  it('is admin-authenticated on BOTH verbs, with no organizer path', () => {
    // RD-INTEG — GET (the eligibility verdict) stays an admin read; DELETE — irreversible removal
    // of an account that has held money — is Super Admin only (ADMIN_UIDS via requireSuperAdmin).
    expect((src.match(/resolveAdminUid\(req\.headers\.get\('authorization'\)\)/g) ?? [])).toHaveLength(1)
    expect(src).toContain('const gate = await requireSuperAdmin(req)')
    // An organizer must not reach this endpoint even for their own account.
    expect(src).not.toContain('verifyCaller')
    expect(src).not.toContain('resolveWorkspaceUid')
    expect((src.match(/status: 403/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('takes the target uid from the ROUTE, never from the body', () => {
    expect(src).toContain('const { uid } = await params')
    // A body-supplied target would make the endpoint's authorization a function of its input.
    expect(src).not.toMatch(/body\.\s*uid|body\.organizerUid|body\.target/)
    // RD-PREPROD · D3 — the body is now read, for the REASON only: exactly one read, and no
    // field other than `reason` is taken from it.
    expect(src.match(/req\.json\(\)/g) ?? []).toHaveLength(1)
    expect(src).toContain('parseFinancialReason(payload?.reason)')
    expect(src).not.toMatch(/payload\??\.(?!reason\b)\w+/)
  })

  it('D3 · requires a written reason and audits BEFORE any data is touched', () => {
    const del = src.slice(src.indexOf('export async function DELETE'))
    const fin = src.slice(src.indexOf('async function finishDeletion'))
    expect(del).toContain('if (!parsedReason.ok) return reasonErrorResponse(parsedReason)')
    // The reason is checked before eligibility is evaluated or the job is driven.
    expect(del.indexOf('parseFinancialReason')).toBeLessThan(del.indexOf('evaluateDeletionEligibility'))
    // The requested row is AWAITED before the job runs, and its failure refuses (503).
    expect(fin).toContain("action: 'organizer.deletion_requested'")
    expect(fin.indexOf('await logAdminAction(')).toBeLessThan(fin.indexOf('driveOrganizerDeletion('))
    expect(fin).toContain('Nothing was deleted.')
    expect(fin).toContain('status: 503')
    // Actor and target; the timestamp is the audit writer's server timestamp.
    expect(fin).toContain("adminUid, actorRole: 'super_admin'")
    expect(fin).toContain("entityType: 'organizer', entityId: uid")
    // Every run's outcome is recorded — with a failure COUNT, never the failure detail.
    expect(fin).toContain("action: 'organizer.deletion_result'")
    expect(fin).toContain('await recordResult(r.outcome, r.deleted, r.failures.length)')
    expect(fin).not.toMatch(/metadata: \{[^}]*(email|name|failures:)/)
  })

  it('re-evaluates eligibility inside DELETE, not just in GET', () => {
    const del = src.slice(src.indexOf('export async function DELETE'))
    expect(del).toContain('await evaluateDeletionEligibility(uid)')
    expect(del).toContain('if (!eligibility.deletable)')
    expect(del).toContain('status: 409')
  })

  it('a failed eligibility probe REFUSES rather than proceeding', () => {
    // "I could not determine whether this organizer has events" is not permission.
    const del = src.slice(src.indexOf('export async function DELETE'))
    expect(del).toContain('status: 503')
    expect(del).toContain('Could not verify that this organizer is safe to delete.')
  })

  it('refuses an admin deleting their own account', () => {
    expect(src).toContain('if (uid === adminUid)')
  })

  it('distinguishes every outcome the console needs to act on', () => {
    for (const outcome of ['completed', 'already_completed', 'busy', 'cancelled', 'not_found', 'unfinished']) {
      expect(src, `outcome ${outcome} is not handled`).toContain(`case '${outcome}'`)
    }
  })

  it('never reports partial work as success', () => {
    expect(src).toContain('success: false, finished: false')
  })

  it('does not return amounts or document ids in a blocker', () => {
    // An admin needs to know a settlement is pending, not what it is worth.
    const del = src.slice(src.indexOf('export async function DELETE'))
    expect(del).not.toMatch(/balancePaise|amountPaise|docId|documentId/)
  })
})

// ═══ 6 · the job ══════════════════════════════════════════════════════════════

describe('the job', () => {
  const src = code('lib/admin/organizerDeletion.ts')

  it('uses a deterministic id, so a repeated request resumes rather than forking', () => {
    expect(src).toContain('const jobId = `orgdel_${uid}`')
    expect(ORGANIZER_DELETION_JOBS).toBe('organizerDeletionJobs')
  })

  it('is leased and fenced, so two admins cannot both walk the manifest', () => {
    expect(src).toContain('await leaseJob(ORGANIZER_DELETION_JOBS, jobId, leaseMs)')
    expect(src).toContain('expectedLeaseTag: leaseTag')
    expect(src).toContain('if (commit.fenced)')
  })

  it('commits the cursor after EVERY page, so an interruption resumes', () => {
    expect(src).toContain('cursor:         encodeProgress(progress)')
  })

  it('is bounded by a time budget and never loops unbounded', () => {
    expect(src).toContain('budgetMs')
    expect(src).toContain("Date.now() - startedAt > budgetMs")
  })

  it('batches Firestore deletes below the 500-operation limit', () => {
    expect(src).toContain('const PAGE = 300')
    expect(src).toContain('adminDb.batch()')
  })

  it('does NOT re-check eligibility mid-run', () => {
    // A resumed job would refuse itself: its first pages already deleted what the gate reads.
    const driver = src.slice(src.indexOf('export async function driveOrganizerDeletion'))
    expect(driver).not.toContain('evaluateDeletionEligibility')
  })

  it('reports ok only when nothing failed', () => {
    expect(src).toContain('ok: progress.failures.length === 0')
  })
})

// ═══ 7 · the unsafe self-delete is gone ══════════════════════════════════════

describe('the organizer self-delete', () => {
  const route = code('app/api/organizer/settings/route.ts')

  it('no longer exports a DELETE handler', () => {
    expect(route).not.toMatch(/export async function DELETE/)
  })

  it('no longer deletes an Auth user or a user profile anywhere in the route', () => {
    expect(route).not.toContain('adminAuth.deleteUser')
    expect(route).not.toMatch(/collection\('users'\)\.doc\(uid\)\.delete\(\)/)
  })

  it('documents where deletion moved to, so it is not reinvented', () => {
    const raw = read('app/api/organizer/settings/route.ts')
    expect(raw).toContain('/api/admin/organizers/[uid]/delete')
    expect(raw).toMatch(/DO NOT reintroduce a self-delete/)
  })

  it('the organizer settings UI no longer offers self-deletion', () => {
    const page = code('app/(dashboard)/dashboard/settings/page.tsx')
    expect(page).not.toContain('handleDeleteAccount')
    expect(page).not.toMatch(/Delete my account/)
    expect(page).not.toMatch(/Permanently delete/)
    // What replaced it points at a human, and does not pretend to be a working control.
    expect(page).toContain('Request account closure')
  })

  it('the closure request goes to the PLATFORM inbox, not the organizer’s own', () => {
    const page = code('app/(dashboard)/dashboard/settings/page.tsx')
    expect(page).toContain('PLATFORM_SUPPORT_EMAIL')
    // `orgSupportEmail` is the organizer's public, attendee-facing address — mailing it would
    // send the closure request straight back to the person asking.
    expect(page).not.toMatch(/mailto:\$\{orgSupportEmail\}/)
  })
})

// ═══ 8 · the confirmation dialog ══════════════════════════════════════════════

describe('the delete dialog', () => {
  const src = code('components/admin/DeleteOrganizerDialog.tsx')

  it('requires the exact string DELETE, case-sensitively', () => {
    expect(src).toContain("export const DELETE_CONFIRMATION = 'DELETE'")
    expect(src).toContain('const confirmed = typed === DELETE_CONFIRMATION')
    // No case-insensitive comparison anywhere — `delete` must not count.
    expect(src).not.toMatch(/toUpperCase\(\)|toLowerCase\(\)|localeCompare/)
  })

  it('enables confirm only when the SERVER said deletable AND the text matches AND a reason is given', () => {
    expect(src).toContain('const canDelete = deletable && confirmed && reasonOk && !busy && !loading')
    expect(src).toContain('disabled={!canDelete}')
    // RD-PREPROD · D3 — the reason travels to the server, which is the gate.
    expect(src).toContain('body: JSON.stringify({ reason: reason.trim() })')
  })

  it('treats an unknown verdict as NOT deletable (fails closed)', () => {
    expect(src).toContain('const deletable = elig?.deletable === true')
    const c = src.slice(src.indexOf('catch'))
    expect(c).toContain('setElig(null)')
  })

  it('shows the identity being deleted', () => {
    for (const f of ['organizationName', 'identity.name', 'identity.email']) {
      expect(src, `dialog does not show ${f}`).toContain(f)
    }
  })

  it('distinguishes itself from Suspend and Ban', () => {
    expect(src).toMatch(/not Suspend or Ban/)
    expect(src).toMatch(/cannot be undone/)
  })

  it('shows the server’s blocking reasons verbatim', () => {
    expect(src).toContain('blockers.map(b =>')
    expect(src).toContain('{b.reason}')
  })

  it('surfaces a 409 from the DELETE as blockers, not a generic failure', () => {
    expect(src).toContain('if (body.blockers?.length)')
  })

  it('is mounted in the admin organizer list, last in the action cluster', () => {
    const page = code('app/(admin)/admin/organizers/PageClient.tsx')
    expect(page).toContain('<DeleteOrganizerDialog')
    expect(page).toContain('setDeleteTarget(o)')
    // After Ban in the cluster: the irreversible action is last.
    expect(page.indexOf("moderate(o.uid, 'ban')")).toBeLessThan(page.indexOf('setDeleteTarget(o)'))
  })
})

// ═══ 9 · protected files were not touched ════════════════════════════════════

describe('blast radius', () => {
  it('the OTP engine, send-otp, verifyCaller and admin auth are untouched by deletion', () => {
    for (const f of [
      'app/api/auth/send-otp/route.ts',
      'lib/team/access.ts',
      'lib/admin/auth.ts',
      'lib/events/eventDeletion.ts',
    ]) {
      expect(code(f), `${f} references organizer deletion`).not.toContain('organizerDeletion')
    }
  })

  it('event deletion still retains the financial collections it always did', () => {
    // Untouched by this task, and asserted so a shared-constant refactor cannot erode it.
    const src = read('lib/events/eventDeletion.ts')
    for (const c of ['platformTransactions', 'walletTransactions', 'eventLicenses', 'licenseOrders']) {
      expect(src, `eventDeletion no longer retains ${c}`).toContain(`'${c}'`)
    }
  })
})
