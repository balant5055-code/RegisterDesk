// RD-STAFF-PW-01 / RD-STAFF-SEC-02 — source contracts for the staff gates.
// Behaviour with real Auth tokens: tests/emulator/staffPasswordChangeEnforcement.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')
const WS = read('lib/team/workspace.ts')

describe('forced first-login password change — enforced server-side', () => {
  const body = WS.slice(WS.indexOf('export async function authorizeWorkspace('), WS.indexOf('export const PASSWORD_CHANGE_REQUIRED_ERROR'))
  it('authorizeWorkspace refuses a staff credential that still has to change its password, before any permission is granted', () => {
    const gate = body.indexOf('ctx.isStaffCredential && !ctx.isOwner && await staffMustChangePassword(caller.uid)')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('ctx.permissions.includes(permission)'))
    expect(body).toContain('error: PASSWORD_CHANGE_REQUIRED_ERROR')
  })
  it('it reads the staff profile flag the login screen already uses (no new setting)', () => {
    expect(WS).toContain("(snap.data() as { mustChangePassword?: unknown }).mustChangePassword === true")
    expect(WS).toContain('adminDb.collection(STAFF_COLLECTION).doc(staffUid).get()')
  })
  it('every gate path enters authorizeWorkspace (authorizeEvent + the download variant delegate)', () => {
    const ev = WS.slice(WS.indexOf('export async function authorizeEvent('))
    expect(ev.slice(0, 600)).toContain('await authorizeWorkspace(req, permission)')
    expect(WS).toContain('return authorizeWorkspace(authedReq, permission)')
  })
  it('the endpoints the change itself needs do NOT go through it', () => {
    for (const f of ['app/api/staff/me/route.ts', 'app/api/staff/password/route.ts']) {
      const src = read(f)
      expect(src, f).toContain('await verifyCaller(req)')
      expect(src, f).not.toMatch(/authorizeWorkspace|authorizeEvent/)
    }
  })
})

describe('print downloads — same gate as every sibling print route', () => {
  for (const f of [
    'app/api/organizer/print-jobs/[jobId]/items/[registrationId]/download/route.ts',
    'app/api/organizer/print-packages/[jobId]/download/route.ts',
  ]) {
    it(f, () => {
      const src = read(f)
      expect(src).toContain('const ctx = await authorizeAnyWorkspace(authReq)')
      expect(src).toContain('if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })')
      expect(src).not.toContain('resolveWorkspaceUid(')
    })
  }
})
