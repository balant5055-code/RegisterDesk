// RD-CHECKIN-STAFF-01 — `checkin_staff` as a TRUE least-privilege gate role.
//
// WHAT WAS WRONG. The matrix granted `checkin_staff: ['checkin', 'participants']`.
// Because lib/identifiers/organizerScope.ts gates EVERY identifier route on
// `participants`, a gate operator could reach identifier pools, bulk assignment,
// export, history, migration, swap and release across the whole workspace — and
// `checkin` additionally admitted them to undo and walk-in registration.
//
// Three independent failures are pinned here, because any one of them alone would
// re-open the hole:
//   1. the matrix itself                      → `checkin` and nothing else
//   2. routes that used to accept `checkin`   → undo / walk-in now need `registrations`
//   3. workspace-wide reach                   → event assignment must contain it
//
// These are SOURCE-level and PREDICATE-level assertions. They deliberately do not
// boot Firestore: the rule under test is the authorization decision, and pinning it
// without infrastructure is what makes it cheap enough to keep passing.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ROLE_PERMISSIONS, ALL_PERMISSIONS, permissionsForRole, isCheckinOnlyRole,
  isEventInScope, sanitizeEventIds,
  type TeamRole, type TeamPermission, type EventScopeSubject,
} from '@/lib/team/types'


import { ticketCodeFromQr } from '@/lib/checkin/qr'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as TeamRole[]

/** Strips comments so an assertion can never be satisfied by prose ABOUT the code. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── 1. The permission matrix ────────────────────────────────────────────────

describe('1 — checkin_staff holds `checkin` and nothing else', () => {
  it('is exactly ["checkin"]', () => {
    expect(ROLE_PERMISSIONS.checkin_staff).toEqual(['checkin'])
  })

  it('no longer carries `participants` — the identifier-engine key', () => {
    expect(permissionsForRole('checkin_staff')).not.toContain('participants')
  })

  it.each([
    'events', 'registrations', 'broadcasts', 'certificates',
    'participants', 'wallet', 'settlements', 'transactions',
  ] as TeamPermission[])('denies %s', perm => {
    expect(permissionsForRole('checkin_staff')).not.toContain(perm)
  })

  it('is denied every permission in the matrix except `checkin`', () => {
    const denied = ALL_PERMISSIONS.filter(p => !permissionsForRole('checkin_staff').includes(p))
    expect(denied.sort()).toEqual(ALL_PERMISSIONS.filter(p => p !== 'checkin').sort())
  })

  it('permissionsForRole returns a COPY — a caller cannot mutate the matrix', () => {
    const p = permissionsForRole('checkin_staff')
    p.push('wallet')
    expect(ROLE_PERMISSIONS.checkin_staff).toEqual(['checkin'])
  })
})

describe('2 — the other roles are untouched (no collateral damage)', () => {
  it('owner still has everything', () => {
    expect(permissionsForRole('owner').sort()).toEqual([...ALL_PERMISSIONS].sort())
  })

  it('admin is unchanged', () => {
    expect(ROLE_PERMISSIONS.admin)
      .toEqual(['events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'participants'])
  })

  it('manager is unchanged', () => {
    expect(ROLE_PERMISSIONS.manager).toEqual(['events', 'registrations', 'checkin', 'participants'])
  })

  it('finance is unchanged', () => {
    expect(ROLE_PERMISSIONS.finance).toEqual(['wallet', 'settlements', 'transactions'])
  })

  it('owner/admin/manager keep `checkin` — the gate still works for them', () => {
    for (const r of ['owner', 'admin', 'manager'] as TeamRole[]) {
      expect(permissionsForRole(r)).toContain('checkin')
    }
  })

  it('owner/admin/manager keep `registrations` — undo and walk-in still work for them', () => {
    for (const r of ['owner', 'admin', 'manager'] as TeamRole[]) {
      expect(permissionsForRole(r)).toContain('registrations')
    }
  })
})

describe('3 — isCheckinOnlyRole is derived from the matrix, not hard-coded', () => {
  it('identifies checkin_staff', () => {
    expect(isCheckinOnlyRole('checkin_staff')).toBe(true)
  })

  it.each(['owner', 'admin', 'manager', 'finance'] as TeamRole[])('does not identify %s', role => {
    expect(isCheckinOnlyRole(role)).toBe(false)
  })

  it('exactly one role in the matrix is gate-only', () => {
    expect(ALL_ROLES.filter(isCheckinOnlyRole)).toEqual(['checkin_staff'])
  })
})

// ─── 4. Routes that must no longer accept `checkin` ──────────────────────────

describe('4 — undo and walk-in require `registrations`, not `checkin`', () => {
  const undo   = code(read('app/api/checkin/undo/route.ts'))
  const walkin = code(read('app/api/checkin/walkin/route.ts'))

  it('undo is gated on registrations', () => {
    expect(undo).toContain("authorizeWorkspace(req, 'registrations')")
    expect(undo).not.toContain("authorizeWorkspace(req, 'checkin')")
  })

  it('walk-in is gated on registrations on BOTH verbs', () => {
    // The GET leaks pass lists and remaining capacity, so it matters as much as the POST.
    expect(walkin.match(/authorizeWorkspace\(req, 'registrations'\)/g)).toHaveLength(2)
    expect(walkin).not.toContain("authorizeWorkspace(req, 'checkin')")
  })

  it('a gate-only role therefore fails both — it lacks `registrations`', () => {
    expect(permissionsForRole('checkin_staff')).not.toContain('registrations')
  })
})

describe('5 — the identifier engine stays behind `participants`', () => {
  // The tempting "fix" for a gate operator who cannot set a bib is to loosen this
  // to `checkin`. That would hand back pools, bulk, export, history and migration
  // in one line, so it is pinned.
  const scope = code(read('lib/identifiers/organizerScope.ts'))

  it('resolveIdentifierScope still requires participants', () => {
    expect(scope).toContain("authorizeWorkspace(req, 'participants')")
  })

  it('and never `checkin`', () => {
    expect(scope).not.toContain("authorizeWorkspace(req, 'checkin')")
  })
})

describe('6 — the organizer dashboard is not a permissionless back door', () => {
  const workspace = code(read('lib/team/workspace.ts'))

  it('authorizeAnyWorkspace refuses gate-only roles', () => {
    expect(workspace).toContain('isCheckinOnlyRole(ctx.role)')
  })

  it('the dashboard aggregate still routes through it', () => {
    expect(code(read('app/api/organizer/dashboard/route.ts'))).toContain('authorizeAnyWorkspace(req)')
  })
})

// ─── 7. Event isolation ──────────────────────────────────────────────────────

const ctx = (over: Partial<EventScopeSubject> = {}): EventScopeSubject => ({
  role: 'checkin_staff', isOwner: false, eventIds: ['evtA'],
  ...over,
})

describe('7 — a gate operator is confined to their assigned events', () => {
  it('Event A → ALLOWED', () => {
    expect(isEventInScope(ctx(), 'evtA')).toBe(true)
  })

  it('Event B → DENIED', () => {
    expect(isEventInScope(ctx(), 'evtB')).toBe(false)
  })

  it('multiple assignments are all honoured', () => {
    const c = ctx({ eventIds: ['evtA', 'evtB'] })
    expect(isEventInScope(c, 'evtA')).toBe(true)
    expect(isEventInScope(c, 'evtB')).toBe(true)
    expect(isEventInScope(c, 'evtC')).toBe(false)
  })

  it('an EMPTY assignment is unrestricted — rows predating the field keep working', () => {
    expect(isEventInScope(ctx({ eventIds: [] }), 'anything')).toBe(true)
  })

  it('owners are never restricted', () => {
    expect(isEventInScope(ctx({ isOwner: true, role: 'owner', eventIds: ['evtA'] }), 'evtB')).toBe(true)
  })

  it.each(['admin', 'manager'] as TeamRole[])('%s is not narrowed by this field', role => {
    // These roles hold workspace-wide permissions and can reach the same event
    // through the organizer surfaces, so scoping them here would be a false promise.
    expect(isEventInScope(ctx({ role, eventIds: ['evtA'] }), 'evtB')).toBe(true)
  })

  it('is case- and whitespace-exact — no fuzzy matching admits a neighbour', () => {
    expect(isEventInScope(ctx(), 'EVTA')).toBe(false)
    expect(isEventInScope(ctx(), ' evtA')).toBe(false)
    expect(isEventInScope(ctx(), 'evtA ')).toBe(false)
    expect(isEventInScope(ctx(), '')).toBe(false)
  })
})

describe('8 — every gate route enforces event scope server-side', () => {
  it('scan derives scope from the registration, not the request body', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan).toContain('isEventSlugInScope(authz, reg.eventSlug)')
    expect(scan).toContain('EVENT_NOT_ASSIGNED')
  })

  it('the offline cache — a BULK attendee download — is scoped too', () => {
    const cache = code(read('app/api/checkin/cache/route.ts'))
    expect(cache).toContain('isEventSlugInScope(authz, slug)')
  })

  it('search and attendance use the path-derived authorizeEvent', () => {
    for (const p of [
      'app/api/organizer/events/[eventId]/checkin/search/route.ts',
      'app/api/organizer/events/[eventId]/attendance/route.ts',
    ]) {
      const src = code(read(p))
      expect(src, p).toContain("authorizeEvent(req, 'checkin', eventId)")
      expect(src, p).not.toContain("authorizeWorkspace(req, 'checkin')")
    }
  })

  it('the ops bootstrap route is scoped', () => {
    expect(code(read('app/api/checkin/ops/[eventId]/route.ts')))
      .toContain("authorizeEvent(req, 'checkin', eventId)")
  })

  it('scan resolves the registration by ticketCode — never a client registrationId', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan).toContain("where('ticketCode', '==', ticketCode)")
    expect(scan).not.toMatch(/body\.registrationId/)
  })
})

// ─── 9. Event assignment input handling ──────────────────────────────────────

describe('9 — sanitizeEventIds', () => {
  it('absent means unrestricted', () => {
    expect(sanitizeEventIds(undefined)).toEqual([])
    expect(sanitizeEventIds(null)).toEqual([])
  })

  it('accepts and de-duplicates a clean list', () => {
    expect(sanitizeEventIds(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('trims', () => {
    expect(sanitizeEventIds([' a '])).toEqual(['a'])
  })

  it('REJECTS a non-array rather than widening to all events', () => {
    // Returning [] here would silently promote a malformed request into
    // workspace-wide access — the exact opposite of what the caller asked for.
    expect(sanitizeEventIds('evtA')).toBeNull()
    expect(sanitizeEventIds(42)).toBeNull()
    expect(sanitizeEventIds({ 0: 'a' })).toBeNull()
  })

  it('rejects non-string members', () => {
    expect(sanitizeEventIds(['a', 1])).toBeNull()
    expect(sanitizeEventIds([null])).toBeNull()
  })

  it('rejects ids that could escape a Firestore document path', () => {
    expect(sanitizeEventIds(['../../users'])).toBeNull()
    expect(sanitizeEventIds(['a/b'])).toBeNull()
    expect(sanitizeEventIds([''])).toBeNull()
  })

  it('rejects an unbounded list — this array is walked on the hottest path', () => {
    expect(sanitizeEventIds(Array.from({ length: 51 }, (_, i) => `e${i}`))).toBeNull()
    expect(sanitizeEventIds(Array.from({ length: 50 }, (_, i) => `e${i}`))).toHaveLength(50)
  })
})

// ─── 10. QR parsing is shared, and only the ticket code is trusted ───────────

describe('10 — ticketCodeFromQr', () => {
  it('extracts the ticket code from the full envelope', () => {
    expect(ticketCodeFromQr('RD:my-event:reg-123:RD-ABCD1234')).toBe('RD-ABCD1234')
  })

  it('passes a bare manual code through', () => {
    expect(ticketCodeFromQr('RD-ABCD1234')).toBe('RD-ABCD1234')
  })

  it('normalises case and whitespace', () => {
    expect(ticketCodeFromQr('  rd-abcd1234  ')).toBe('RD-ABCD1234')
  })

  it('discards the registrationId and eventSlug the payload carries', () => {
    // Both are attacker-controlled on a self-printed QR. The server re-derives them.
    const out = ticketCodeFromQr('RD:attacker-event:victim-registration:RD-ABCD1234')
    expect(out).toBe('RD-ABCD1234')
    expect(out).not.toContain('victim-registration')
    expect(out).not.toContain('attacker-event')
  })

  it('leaves a malformed envelope for the server to reject', () => {
    expect(ticketCodeFromQr('RD:only:three')).toBe('RD:ONLY:THREE')
    expect(ticketCodeFromQr('')).toBe('')
  })

  it('both check-in surfaces use the ONE parser — no second implementation', () => {
    for (const p of [
      'app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInClient.tsx',
      'app/ops/checkin/[eventId]/OpsCheckinClient.tsx',
    ]) {
      const src = code(read(p))
      expect(src, p).toContain('ticketCodeFromQr')
      expect(src, p).not.toMatch(/parts\[0\]\s*===\s*'RD'/)
    }
  })
})

// ─── 11. The gate surface carries no organizer chrome ────────────────────────

describe('11 — /ops is isolated from the organizer dashboard', () => {
  const client = read('app/ops/checkin/[eventId]/OpsCheckinClient.tsx')
  const layout = read('app/ops/layout.tsx')

  it('renders no organizer navigation component', () => {
    for (const banned of ['Sidebar', 'CommandPalette', 'NotificationBell', 'Breadcrumbs', 'WorkspaceBanner']) {
      expect(code(client) + code(layout), banned).not.toContain(banned)
    }
  })

  it('NAVIGATES to no organizer route', () => {
    // Import specifiers are excluded deliberately: this surface REUSES the
    // dashboard's QrScanner component, so its module path legitimately contains
    // "/dashboard/events". What must not exist is a way for the operator to travel
    // there — an href, a router push, or a redirect.
    const src = (code(client) + code(layout))
      .split('\n').filter(l => !/^\s*import\b/.test(l)).join('\n')

    const navigations = src.match(/(?:href|action)\s*=\s*["'`][^"'`]*|(?:push|replace|redirect)\(\s*["'`][^"'`]*/g) ?? []
    const organizerNav = navigations.filter(n => n.includes('/dashboard'))
    expect(organizerNav).toEqual([])
  })

  it('imports no organizer data surface — only the shared scanner', () => {
    const imports = code(client).split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
    expect(imports).toContain('checkin/QrScanner')
    for (const banned of ['/crm/', '/finance/', '/wallet/', '/reports/', '/team/', 'WalkInForm']) {
      expect(imports, banned).not.toContain(banned)
    }
  })

  it('offers no undo and no walk-in control', () => {
    const src = code(client)
    expect(src).not.toContain('/api/checkin/undo')
    expect(src).not.toContain('/api/checkin/walkin')
  })

  it('lives outside the (dashboard) route group, so it inherits no organizer layout', () => {
    // A file under app/ops/ cannot be captured by app/(dashboard)/layout.tsx.
    expect(() => read('app/ops/layout.tsx')).not.toThrow()
    expect(layout).toContain('OpsLayout')
  })

  it('the page itself claims no authority — the API is the gate', () => {
    const page = code(read('app/ops/checkin/[eventId]/page.tsx'))
    expect(page).toContain('OpsCheckinClient')
    expect(page).not.toContain('authorize')
  })
})

describe('12 — the dashboard redirect is a hint, never the control', () => {
  const guard = code(read('components/dashboard/CheckinStaffGuard.tsx'))

  it('reads checkinOnly from the SERVER, not from a local role guess', () => {
    expect(guard).toContain('/api/organizer/workspace')
    expect(guard).toContain('info.checkinOnly')
  })

  it('the server computes checkinOnly from the matrix', () => {
    const route = code(read('app/api/organizer/workspace/route.ts'))
    expect(route).toContain('isCheckinOnlyRole(ctx.role)')
    expect(route).toContain('!ctx.isOwner &&')
  })

  it('sends the operator to their assigned event', () => {
    expect(guard).toContain('/ops/checkin/')
    expect(guard).toContain('info.eventIds')
  })

  it('renders nothing and blocks nothing — a thrown fetch must not break the dashboard', () => {
    expect(guard).toContain('return null')
    expect(guard).toMatch(/catch\s*\{/)
  })

  it('the real containment is still server-side, independent of this component', () => {
    // If this assertion ever needs relaxing, the redirect has been mistaken for a
    // security boundary — it is not one.
    expect(code(read('lib/team/workspace.ts'))).toContain('isCheckinOnlyRole(ctx.role)')
    expect(permissionsForRole('checkin_staff')).toEqual(['checkin'])
  })
})
