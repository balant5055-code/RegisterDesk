// RD-CERT-PHOTO-01 — the attendee-photo service: ownership, replace, remove.
//
// These are the paths where a mistake is expensive rather than merely wrong:
//   • ownership — a miss lets anyone write to a stranger's registration
//   • replace   — deleting the OLD object before the NEW key is committed loses a photo
//   • remove    — clearing the reference must come first, so a failed object delete
//                 leaves an orphan rather than a registration pointing at nothing
//
// Firestore and object storage are mocked in the style the lookup route test already uses,
// so this stays a unit test and needs no emulator.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────
const calls: string[] = []
let stored: Record<string, unknown> | null = null
let updatePayload: Record<string, unknown> | null = null

vi.mock('@/lib/firebase/admin', () => {
  const doc = () => ({
    get: async () => ({ exists: stored !== null, data: () => stored }),
    update: async (patch: Record<string, unknown>) => {
      calls.push('firestore.update')
      updatePayload = patch
    },
  })
  return { adminDb: { collection: () => ({ doc }) } }
})

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__DELETED__' },
}))

const deleted: string[] = []
vi.mock('@/features/platform-storage', () => ({
  storage: {
    upload: async () => {
      calls.push('storage.upload')
      return { metadata: { path: 'events/evt/attendee-photos/new-object' } }
    },
    delete: async (key: string) => {
      calls.push('storage.delete')
      deleted.push(key)
    },
  },
}))

import {
  loadOwnedRegistration, setAttendeePhoto, removeAttendeePhoto,
} from '@/lib/registrations/attendeePhoto'
import type { RegistrationDocument } from '@/lib/registrations/types'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function reg(extra: Partial<RegistrationDocument> = {}): RegistrationDocument {
  return {
    eventSlug: 'evt',
    attendee: { name: 'Bala', email: 'owner@example.com' },
    ...extra,
  } as RegistrationDocument
}

beforeEach(() => {
  calls.length = 0
  deleted.length = 0
  stored = null
  updatePayload = null
})

// ─── Ownership ────────────────────────────────────────────────────────────────

describe('ownership is derived from the session, never from the request', () => {
  it('accepts the registration whose attendee email matches the session', async () => {
    stored = reg()
    const r = await loadOwnedRegistration('reg-1', 'owner@example.com')
    expect(r.ok).toBe(true)
  })

  it('REFUSES another attendee\'s registration — the id alone is not a credential', async () => {
    stored = reg()
    const r = await loadOwnedRegistration('reg-1', 'attacker@example.com')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('forbidden')
  })

  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    stored = reg({ attendee: { name: 'B', email: '  Owner@Example.COM ' } } as Partial<RegistrationDocument>)
    expect((await loadOwnedRegistration('reg-1', 'owner@example.com')).ok).toBe(true)
  })

  it('refuses a registration with no attendee email rather than matching empty to empty', async () => {
    stored = reg({ attendee: { name: 'B', email: '' } } as Partial<RegistrationDocument>)
    const r = await loadOwnedRegistration('reg-1', '')
    expect(r.ok).toBe(false)
  })

  it('reports not_found for a missing registration', async () => {
    stored = null
    const r = await loadOwnedRegistration('nope', 'owner@example.com')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('not_found')
  })
})

// ─── Upload / replace ─────────────────────────────────────────────────────────

describe('upload and replace', () => {
  const args = { registrationId: 'reg-1', bytes: JPEG, declaredMime: 'image/jpeg', actorEmail: 'owner@example.com' }

  it('stores the object and points the registration at the new key', async () => {
    const r = await setAttendeePhoto({ ...args, reg: reg() })
    expect(r.ok).toBe(true)
    expect(updatePayload).toEqual({ attendeePhotoKey: 'events/evt/attendee-photos/new-object' })
  })

  it('a FIRST upload deletes nothing', async () => {
    await setAttendeePhoto({ ...args, reg: reg() })
    expect(deleted).toEqual([])
  })

  it('a REPLACE removes the previous object only AFTER the new key is committed', async () => {
    await setAttendeePhoto({ ...args, reg: reg({ attendeePhotoKey: 'events/evt/attendee-photos/old' }) })
    // Order is the point: losing power between upload and update must leave the OLD photo
    // intact, never a registration pointing at a key whose object was already deleted.
    expect(calls).toEqual(['storage.upload', 'firestore.update', 'storage.delete'])
    expect(deleted).toEqual(['events/evt/attendee-photos/old'])
  })

  it('rejects bytes that disagree with the declared type, before storing anything', async () => {
    const html = new TextEncoder().encode('<!doctype html><html></html>')
    const r = await setAttendeePhoto({ ...args, bytes: html, reg: reg() })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('unsupported_type')
    expect(calls).toEqual([])            // nothing uploaded, nothing written
  })

  it('rejects an empty body', async () => {
    const r = await setAttendeePhoto({ ...args, bytes: new Uint8Array([]), reg: reg() })
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('rejects an oversized body before storing anything', async () => {
    const big = new Uint8Array(5 * 1024 * 1024)
    big.set(JPEG, 0)
    const r = await setAttendeePhoto({ ...args, bytes: big, reg: reg() })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('too_large')
    expect(calls).toEqual([])
  })
})

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('remove', () => {
  it('clears the reference FIRST, then deletes the object', async () => {
    await removeAttendeePhoto({ registrationId: 'reg-1', reg: reg({ attendeePhotoKey: 'events/evt/attendee-photos/old' }) })
    expect(calls).toEqual(['firestore.update', 'storage.delete'])
    expect(updatePayload).toEqual({ attendeePhotoKey: '__DELETED__' })
    expect(deleted).toEqual(['events/evt/attendee-photos/old'])
  })

  it('is idempotent — removing a photo that is not there touches nothing', async () => {
    const r = await removeAttendeePhoto({ registrationId: 'reg-1', reg: reg() })
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
  })

  it('after removal the registration carries no key, which is the no-photo certificate path', async () => {
    await removeAttendeePhoto({ registrationId: 'reg-1', reg: reg({ attendeePhotoKey: 'k' }) })
    // FieldValue.delete() — the field is removed, not set to null, so `attendeePhotoKey`
    // is absent exactly as it is on every registration that never had a photo.
    expect(updatePayload).toEqual({ attendeePhotoKey: '__DELETED__' })
  })
})
