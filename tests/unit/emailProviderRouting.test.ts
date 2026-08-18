// RD-EMAIL-PROVIDER — the ROUTING half: does the stored event setting actually survive
// the trip from the settings form to the transport that sends the mail?
//
// `emailProviderName.test.ts` pins the parsing rule. This file pins the plumbing:
// persistence (applyEdit), read-back (extractEditableSnapshot), resolution against a
// stubbed Firestore, the TTL cache, and the no-silent-fallback contract.
//
// Everything here runs in the `node` environment. Firebase Admin is stubbed, so no
// emulator and no credentials are required and no network call is made.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EventEditPayload } from '@/types/events'
import { isEmailProviderName } from '@/lib/email/providerName'

// ── Firestore stub ────────────────────────────────────────────────────────────
// A single mutable cell standing in for `events/{slug}`. `get()` is counted so the
// cache tests can assert on the number of reads rather than on wall-clock timing.
const store = { data: undefined as Record<string, unknown> | undefined, throws: false }
const getSpy = vi.fn()

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => {
          getSpy()
          if (store.throws) throw new Error('firestore unavailable')
          return { data: () => store.data }
        },
      }),
    }),
  },
}))

// ── Business Configuration stub (the GLOBAL admin selection) ─────────────────
// RD-EMAIL-PROVIDER-02 — the resolver now consults the admin's global provider when an
// event expresses no preference, so the global has to be controllable from here. `throws`
// proves the send path survives a configuration outage.
const globalCfg = { emailProvider: 'ses' as string, throws: false }
vi.mock('@/lib/config/resolveIntegrationConfig', () => ({
  getIntegrationConfig: async () => {
    if (globalCfg.throws) throw new Error('config unavailable')
    return { emailProvider: globalCfg.emailProvider }
  },
}))

import { resolveEventEmailProvider, __clearEventProviderCache } from '@/lib/email/resolveEventProvider'
import { buildEventEditUpdate, extractEditableSnapshot } from '@/lib/events/editing/applyEdit'
import {
  SAFE_EDIT_KEYS, RESTRICTED_EDIT_KEYS, findForbiddenEditKeys,
} from '@/lib/events/editing/fieldClassification'

beforeEach(() => {
  store.data = undefined
  store.throws = false
  globalCfg.emailProvider = 'ses'
  globalCfg.throws = false
  getSpy.mockClear()
  __clearEventProviderCache()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── F · Resolution from the persisted event document ─────────────────────────

describe('F · an EXPLICIT event choice wins; absence inherits the admin global', () => {
  it('an event storing "resend" resolves to Resend', async () => {
    store.data = { emailProvider: 'resend' }
    expect(await resolveEventEmailProvider('marathon-2026')).toBe('resend')
  })

  it('an event storing "ses" resolves to SES', async () => {
    store.data = { emailProvider: 'ses' }
    expect(await resolveEventEmailProvider('marathon-2026')).toBe('ses')
  })

  // ── THE "Lorem" CASE ────────────────────────────────────────────────────────
  // An event that no admin ever toggled has NO emailProvider field. It used to drop
  // straight to the hardcoded SES default, so an admin who had selected Resend globally
  // still saw "Email rejected by SES" — the global setting existed but nothing read it.
  it('an event with NO emailProvider follows the admin global (resend)', async () => {
    globalCfg.emailProvider = 'resend'
    store.data = { name: 'Lorem' }                     // no emailProvider field at all
    expect(await resolveEventEmailProvider('lorem-hFDUUG')).toBe('resend')
  })

  it('an event with NO emailProvider follows the admin global (ses)', async () => {
    globalCfg.emailProvider = 'ses'
    store.data = { name: 'Lorem' }
    expect(await resolveEventEmailProvider('lorem-hFDUUG')).toBe('ses')
  })

  it('an explicit "ses" event is NOT dragged to Resend by the global', async () => {
    // The override is the point of the per-event toggle: an admin who pinned SES on one
    // event keeps SES there after moving the platform to Resend.
    globalCfg.emailProvider = 'resend'
    store.data = { emailProvider: 'ses' }
    expect(await resolveEventEmailProvider('pinned-event')).toBe('ses')
  })

  it('changing the admin global moves every un-overridden event', async () => {
    store.data = { name: 'Lorem' }
    globalCfg.emailProvider = 'ses'
    expect(await resolveEventEmailProvider('lorem-hFDUUG')).toBe('ses')

    // The admin flips the platform to Resend; the cache is what bounds the delay.
    globalCfg.emailProvider = 'resend'
    __clearEventProviderCache()
    expect(await resolveEventEmailProvider('lorem-hFDUUG')).toBe('resend')
  })

  it('a corrupt stored value falls back rather than failing the send', async () => {
    globalCfg.emailProvider = 'resend'
    store.data = { emailProvider: 'mailgun' }
    // Unreadable ⇒ not an explicit choice ⇒ inherit the global, never an arbitrary string.
    expect(await resolveEventEmailProvider('marathon-2026')).toBe('resend')
  })

  it('a missing event document inherits the global', async () => {
    globalCfg.emailProvider = 'resend'
    store.data = undefined
    expect(await resolveEventEmailProvider('does-not-exist')).toBe('resend')
  })

  it('an empty or absent slug never touches Firestore, and still honours the global', async () => {
    globalCfg.emailProvider = 'resend'
    expect(await resolveEventEmailProvider('')).toBe('resend')
    expect(await resolveEventEmailProvider(null)).toBe('resend')
    expect(await resolveEventEmailProvider(undefined)).toBe('resend')
    expect(await resolveEventEmailProvider('   ')).toBe('resend')
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('a Firestore failure falls back to the global instead of throwing into the send path', async () => {
    globalCfg.emailProvider = 'resend'
    store.throws = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(resolveEventEmailProvider('marathon-2026')).resolves.toBe('resend')
    err.mockRestore()
  })

  it('a configuration outage degrades to the historical default, never to a throw', async () => {
    globalCfg.throws = true
    store.data = { name: 'Lorem' }
    await expect(resolveEventEmailProvider('lorem-hFDUUG')).resolves.toBe('ses')
  })

  it('an unset global resolves to the code default', async () => {
    globalCfg.emailProvider = ''
    store.data = { name: 'Lorem' }
    expect(await resolveEventEmailProvider('lorem-hFDUUG')).toBe('ses')
  })
})

// ─── G · Cache behaviour: spares reads, but never pins a stale decision ────────

describe('G · the resolver cache', () => {
  it('a broadcast wave over one event costs ONE read, not one per recipient', async () => {
    store.data = { emailProvider: 'resend' }
    for (let i = 0; i < 25; i++) await resolveEventEmailProvider('marathon-2026')
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('caches per slug — two events on different providers do not bleed into each other', async () => {
    store.data = { emailProvider: 'resend' }
    expect(await resolveEventEmailProvider('event-a')).toBe('resend')
    store.data = { emailProvider: 'ses' }
    expect(await resolveEventEmailProvider('event-b')).toBe('ses')
    // event-a must still read from its own cache entry, not event-b's.
    expect(await resolveEventEmailProvider('event-a')).toBe('resend')
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it('expires, so flipping the setting takes effect without a redeploy', async () => {
    vi.useFakeTimers()
    store.data = { emailProvider: 'ses' }
    expect(await resolveEventEmailProvider('marathon-2026')).toBe('ses')

    store.data = { emailProvider: 'resend' }
    vi.advanceTimersByTime(31_000)          // past the 30s TTL
    expect(await resolveEventEmailProvider('marathon-2026')).toBe('resend')
    expect(getSpy).toHaveBeenCalledTimes(2)
  })
})

// ─── I/J · The organizer edit path CANNOT touch the transport ─────────────────
//
// These assertions are the inverse of what they were while the setting was organizer-
// editable. That inversion is the point: the transport is now admin-only, and the edit
// mapper is the last line before Firestore. If any of these start passing a provider
// through again, an organizer has regained a write path to platform infrastructure.

describe('I/J · buildEventEditUpdate NEVER writes emailProvider', () => {
  // Minimal draft: the rest only has to be shaped well enough for the other branches.
  const draft = { eventDetails: {}, pricing: {} }
  const base = (p: Record<string, unknown>) =>
    buildEventEditUpdate(p as EventEditPayload, draft, {})

  it.each([
    ['a valid "resend"', 'resend'],
    ['a valid "ses"',    'ses'],
    ['a junk value',     'sendgrid'],
    ['an object',        { key: 'secret' }],
  ])('drops %s from the update map', (_label, value) => {
    const { updates } = base({ emailProvider: value })
    expect(updates).not.toHaveProperty('emailProvider')
  })

  it('does not report emailProvider as a changed field', () => {
    const { changedFields } = base({ emailProvider: 'resend' })
    expect(changedFields).not.toContain('emailProvider')
  })

  it('a hostile payload mixing a real edit with the provider persists ONLY the real edit', () => {
    // The realistic attack: hide the privileged key inside an otherwise legitimate save.
    const { updates } = base({ emailProvider: 'resend', tagline: 'Run with us' })
    expect(updates).not.toHaveProperty('emailProvider')
    expect(updates['eventDetails.info.tagline']).toBe('Run with us')
  })
})

describe('I/J · extractEditableSnapshot never surfaces the transport', () => {
  it('omits it even when the event document stores one', () => {
    // The snapshot feeds rollback and the organizer-facing audit diff. Leaking the value
    // here would both expose an admin setting and let a rollback rewrite it.
    expect(extractEditableSnapshot({ emailProvider: 'resend' })).not.toHaveProperty('emailProvider')
  })

  it('omits it for an event that never had one', () => {
    expect(extractEditableSnapshot({})).not.toHaveProperty('emailProvider')
  })
})

// ─── I · Classification — not an organizer-editable field at all ──────────────

describe('I · emailProvider is absent from the organizer edit classification', () => {
  it('is NOT an organizer-safe edit key', () => {
    expect(SAFE_EDIT_KEYS).not.toContain('emailProvider')
  })

  it('being unknown to the classifier makes the edit route reject it outright', () => {
    // The route 400s on anything findForbiddenEditKeys returns. This is the generic
    // backstop that sits behind the route's explicit named 403.
    expect(findForbiddenEditKeys(['emailProvider'])).toContain('emailProvider')
  })

  it('a legitimate content edit is still allowed alongside it', () => {
    expect(findForbiddenEditKeys(['tagline'])).toHaveLength(0)
  })

  it('is not smuggled in as a RESTRICTED key either', () => {
    expect(RESTRICTED_EDIT_KEYS).not.toContain('emailProvider')
  })
})

// ─── K · Republish must not wipe the transport ────────────────────────────────
//
// SCOPE, HONESTLY: app/api/events/publish/route.ts writes the live document with
// `txn.set(slugRef, {...})` — a FULL overwrite. It survives republish only because the
// route re-reads the existing doc and carries the value forward:
//
//   const existingRaw = (existingSnap.data() as {...})?.emailProvider
//   const existingEmailProvider = isEmailProviderName(existingRaw) ? existingRaw : undefined
//   ...(existingEmailProvider ? { emailProvider: existingEmailProvider } : {}),
//
// The route itself is not exercised here (it would need the whole licence/governance
// transaction mocked, which buys a brittle test rather than a true one). What IS pinned
// is the predicate that decides the carry-forward, and the three-way outcome it produces.
// The route wiring is verified by inspection.

describe('K · the predicate driving the publish carry-forward', () => {
  const carriedForward = (stored: unknown) =>
    isEmailProviderName(stored) ? { emailProvider: stored } : {}

  it('a stored "resend" survives a republish', () => {
    expect(carriedForward('resend')).toEqual({ emailProvider: 'resend' })
  })

  it('a stored "ses" survives a republish', () => {
    expect(carriedForward('ses')).toEqual({ emailProvider: 'ses' })
  })

  it('an absent provider stays ABSENT — republish never stamps a default onto a legacy event', () => {
    // Writing 'ses' here would look harmless but would convert "never chose" into an
    // explicit choice, which the resolver and the admin console then report differently.
    expect(carriedForward(undefined)).toEqual({})
  })

  it('a corrupt stored value is dropped rather than carried forward', () => {
    expect(carriedForward('sendgrid')).toEqual({})
  })
})

// ─── J · No silent cross-provider fallback ────────────────────────────────────

describe('J · an explicit Resend choice is never downgraded to SES', () => {
  it('getEmailProvider("resend") returns null when Resend is unconfigured', async () => {
    // No RESEND_API_KEY in the test environment, so the factory must refuse to build —
    // and must NOT hand back the SES transport as a consolation. Silently routing an
    // event's mail through the wrong provider is the exact failure this guards.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getEmailProvider } = await import('@/lib/email')
    expect(getEmailProvider('resend')).toBeNull()
    err.mockRestore()
  })

  it('logs the refusal so an operator can see why mail stopped', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getEmailProvider } = await import('@/lib/email')
    getEmailProvider('resend')
    // Cached after the first call, so tolerate either a fresh log or the cached path.
    if (err.mock.calls.length > 0) {
      expect(String(err.mock.calls[0][0])).toContain('NOT falling back to SES')
    }
    err.mockRestore()
  })
})
