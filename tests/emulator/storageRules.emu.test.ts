// RD-SEC-01 — storage.rules, exercised against the Storage EMULATOR with real Auth-emulator ID
// tokens through the Firebase Storage REST API (the same surface the client SDK uses).
//
// Pins: owner-scoped writes on every organizer path (another organizer and anonymous are
// refused), type/size limits, owner-only certificate template reads, and the deny-all default.
// Public READ of event/organizer branding assets is current, documented behaviour (event pages
// load banners anonymously) — pinned here so a change to it is deliberate.

import { describe, it, expect, beforeAll } from 'vitest'

const HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST
const BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? 'demo-registerdesk.appspot.com'
const describeEmu = HOST && AUTH ? describe : describe.skip
const T = 60_000
const P = `strules-${process.pid}`
const PASSWORD = 'StRulesPassw0rd!'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function signUp(email: string): Promise<{ uid: string; token: string }> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  })
  const j = await r.json() as { localId: string; idToken: string }
  return { uid: j.localId, token: j.idToken }
}
const objUrl = (path: string) => `http://${HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(path)}`
async function upload(path: string, token: string | null, body: Uint8Array = PNG, type = 'image/png'): Promise<number> {
  const r = await fetch(`http://${HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'content-type': type, ...(token ? { authorization: `Firebase ${token}` } : {}) },
    body,
  })
  return r.status
}
async function read(path: string, token: string | null): Promise<number> {
  return (await fetch(objUrl(path), { headers: token ? { authorization: `Firebase ${token}` } : {} })).status
}
async function del(path: string, token: string | null): Promise<number> {
  return (await fetch(objUrl(path), { method: 'DELETE', headers: token ? { authorization: `Firebase ${token}` } : {} })).status
}
const ok = (s: number) => s >= 200 && s < 300
const denied = (s: number) => s === 401 || s === 403

describeEmu('RD-SEC-01 · storage.rules', () => {
  let a: { uid: string; token: string }
  let b: { uid: string; token: string }
  beforeAll(async () => {
    a = await signUp(`${P}-a@registerdesk.test`)
    b = await signUp(`${P}-b@registerdesk.test`)
  }, T)

  it('event-assets: only the path owner writes/deletes; others and anonymous are refused', async () => {
    const path = `event-assets/${a.uid}/evt1/banner/b.png`
    expect(denied(await upload(path, null))).toBe(true)
    expect(denied(await upload(path, b.token))).toBe(true)
    expect(ok(await upload(path, a.token))).toBe(true)
    expect(denied(await del(path, b.token))).toBe(true)
    expect(ok(await read(path, null))).toBe(true)          // public by design (event pages)
    expect(ok(await del(path, a.token))).toBe(true)
  }, T)

  it('event-assets / organizer-assets: non-image types and SVG are refused even for the owner', async () => {
    expect(denied(await upload(`event-assets/${a.uid}/evt1/logo/x.svg`, a.token, new TextEncoder().encode('<svg/>'), 'image/svg+xml'))).toBe(true)
    expect(denied(await upload(`organizer-assets/${a.uid}/x.html`, a.token, new TextEncoder().encode('<b>'), 'text/html'))).toBe(true)
  }, T)

  it('organizer-assets: owner-scoped writes', async () => {
    const path = `organizer-assets/${a.uid}/logo.png`
    expect(denied(await upload(path, b.token))).toBe(true)
    expect(denied(await upload(path, null))).toBe(true)
    expect(ok(await upload(path, a.token))).toBe(true)
    expect(denied(await del(path, b.token))).toBe(true)
  }, T)

  it('certificate templates: owner-only read/write — another organizer cannot read the design', async () => {
    const path = `certificates/templates/${a.uid}/evt1/t.png`
    expect(denied(await upload(path, b.token))).toBe(true)
    expect(ok(await upload(path, a.token))).toBe(true)
    expect(ok(await read(path, a.token))).toBe(true)
    expect(denied(await read(path, b.token))).toBe(true)
    expect(denied(await read(path, null))).toBe(true)
  }, T)

  it('every other path is denied (server-only print/report objects included)', async () => {
    for (const path of [`printAssets/${a.uid}/job/x.png`, `reportExports/${a.uid}/job/x.png`, `random/${a.uid}.png`]) {
      expect(denied(await upload(path, a.token)), path).toBe(true)
      expect(denied(await read(path, a.token)), path).toBe(true)
    }
  }, T)
})
