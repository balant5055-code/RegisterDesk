// RD-SEC-01 · every app/api/admin/** route × every exported HTTP method × four principals, with REAL
// Auth-emulator ID tokens (no identity mocks): anonymous, a fresh organizer, an organizer whose PROFILE
// claims to be an admin, and a user holding the legacy custom claim `admin: true` (NOT in ADMIN_UIDS).
// Two roles only: none of the four may get anything but 401/403 from any admin handler. A new admin
// route is covered automatically. The payment provider throws if any handler reaches it.
import { describe, it, expect, beforeAll, vi } from 'vitest'
vi.mock('@/lib/razorpay/client', () => new Proxy({}, { get(_t, k) { if (k === 'then' || typeof k === 'symbol') return undefined; if (k === 'RAZORPAY_KEY_ID' || k === 'RAZORPAY_KEY_SECRET') return 'rzp_test_sweep'; return new Proxy(() => { throw new Error('payment provider touched') }, { get() { throw new Error('payment provider touched') } }) } }))
import { NextRequest } from 'next/server'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const P = `sec${process.pid}`
const SUPER = `${P}_super`
process.env.ADMIN_UIDS = SUPER
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : n === 'route.ts' ? [p] : [] })
}
async function token(email: string, password: string): Promise<string> {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  return (await r.json() as { idToken: string }).idToken
}

const describeEmu = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST ? describe : describe.skip

describeEmu('RD-SEC-01 · every admin route refuses non-ADMIN_UIDS callers', () => {
  const tokens: Record<string, string | null> = { anonymous: null }
  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const { adminAuth, adminDb } = await import('@/lib/firebase/admin')
    const mk = async (uid: string, claims?: Record<string, unknown>) => {
      await adminAuth.deleteUser(uid).catch(() => null)
      await adminAuth.createUser({ uid, email: `${uid}@sec.test`, password: 'SecPassw0rd!', emailVerified: true })
      if (claims) await adminAuth.setCustomUserClaims(uid, claims)
      return token(`${uid}@sec.test`, 'SecPassw0rd!')
    }
    tokens.organizer = await mk(`${P}_org`)
    // a profile that LIES about being an admin (as a forged signup / client write would try)
    tokens.profileAdmin = await mk(`${P}_profadm`)
    await adminDb.doc(`users/${P}_profadm`).set({ uid: `${P}_profadm`, role: 'superadmin', admin: true, isAdmin: true, accountStatus: 'active', workspaceOwner: true })
    tokens.legacyClaim = await mk(`${P}_claim`, { admin: true, isAdmin: true, role: 'superadmin' })
    tokens.superAdmin = await mk(SUPER)
  }, 120_000)

  it('sweep', async () => {
    const files = walk('app/api/admin')
    const rows: string[] = []
    const leaks: string[] = []
    const claimOk: string[] = []
    let calls = 0
    for (const f of files) {
      const route = '/' + relative('app', f).replace(/\\/g, '/').replace(/\/route\.ts$/, '')
      let mod: Record<string, unknown>
      try { mod = await import(/* @vite-ignore */ '@/' + relative('.', f).replace(/\\/g, '/').replace(/\.ts$/, '')) as Record<string, unknown> }
      catch (e) { rows.push(`IMPORT-FAILED ${route} — ${String((e as Error).message).slice(0, 140)}`); continue }
      const params = Object.fromEntries([...route.matchAll(/\[(\w+)\]/g)].map(m => [m[1], `${P}x`]))
      for (const m of METHODS) {
        const fn = mod[m] as undefined | ((req: NextRequest, ctx: unknown) => Promise<Response>)
        if (typeof fn !== 'function') continue
        const res: Record<string, number> = {}
        for (const who of ['anonymous', 'organizer', 'profileAdmin', 'legacyClaim'] as const) {
          const headers: Record<string, string> = { 'content-type': 'application/json' }
          if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`
          const req = new NextRequest(`http://localhost${route.replace(/\[(\w+)\]/g, `${P}x`)}?view=overview&id=${P}x`, {
            method: m, headers, ...(m === 'GET' || m === 'DELETE' ? {} : { body: '{}' }),
          })
          let status = 0
          try { status = (await fn(req, { params: Promise.resolve(params) })).status } catch { status = -1 }
          calls++
          res[who] = status
          const denied = status === 401 || status === 403
          if (who !== 'legacyClaim' && !denied) leaks.push(`${m} ${route} as ${who} → ${status}`)
          if (who === 'legacyClaim' && !denied) claimOk.push(`${m} ${route} → ${status}`)
        }
        rows.push(`${m.padEnd(6)} ${route.padEnd(70)} anon=${res.anonymous} org=${res.organizer} profAdmin=${res.profileAdmin} claim=${res.legacyClaim}`)
      }
    }
    expect(rows.filter(r => r.startsWith('IMPORT-FAILED'))).toEqual([])
    expect(calls).toBeGreaterThan(400)
    expect(rows.length).toBeGreaterThan(100)
    expect(leaks).toEqual([])
    expect(claimOk).toEqual([])
  }, 1_800_000)
})
