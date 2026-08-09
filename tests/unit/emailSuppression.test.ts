// RD-LAUNCH-05 — suppression scope + idempotency.
//
// The Firestore admin SDK is mocked at the module boundary so the suppression logic
// itself is exercised: doc-ID determinism (which is what makes re-delivered SNS
// notifications idempotent), the platform-vs-organizer scope split, and the batched
// canonical check.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Firestore admin mock ──────────────────────────────────────────────────────
const store = new Map<string, Record<string, unknown>>()
const setSpy = vi.fn()

function docRef(id: string) {
  return {
    id,
    get:  async () => ({ exists: store.has(id), data: () => store.get(id) }),
    set:  async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      setSpy(id, data, opts)
      store.set(id, opts?.merge ? { ...(store.get(id) ?? {}), ...data } : data)
    },
  }
}

const collectionRef = {
  doc: (id: string) => docRef(id),
  where: (_f: string, _op: string, value: string) => ({
    get: async () => ({
      docs: [...store.entries()]
        .filter(([, d]) => d.organizerUid === value)
        .map(([id, d]) => ({ id, data: () => d })),
    }),
  }),
}

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => collectionRef,
    getAll: async (...refs: { id: string }[]) =>
      refs.map(r => ({ exists: store.has(r.id), data: () => store.get(r.id) })),
  },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}))

const {
  suppressEmailPlatformWide, isSuppressed, addToSuppressionList,
  getOrganiserSuppressionSet, PLATFORM_SCOPE,
} = await import('@/lib/firebase/firestore/emailSuppressionList')

beforeEach(() => { store.clear(); setSpy.mockClear() })

describe('platform-wide suppression (SES bounces & complaints)', () => {
  it('records a hard bounce with its SES metadata', async () => {
    await suppressEmailPlatformWide('Dead@Example.com', 'bounce', {
      bounceType: 'Permanent', bounceSubType: 'NoEmail', providerMessageId: 'msg-1',
    })
    const doc = store.get(`${PLATFORM_SCOPE}_dead@example.com`)!
    expect(doc.email).toBe('dead@example.com')
    expect(doc.scope).toBe('platform')
    expect(doc.reason).toBe('bounce')
    expect(doc.bounceType).toBe('Permanent')
    expect(doc.bounceSubType).toBe('NoEmail')
  })

  it('records a complaint with its feedback id', async () => {
    await suppressEmailPlatformWide('angry@example.com', 'complaint', {
      complaintType: 'abuse', feedbackId: 'fb-9',
    })
    const doc = store.get(`${PLATFORM_SCOPE}_angry@example.com`)!
    expect(doc.reason).toBe('complaint')
    expect(doc.complaintType).toBe('abuse')
    expect(doc.feedbackId).toBe('fb-9')
  })

  it('is idempotent — a re-delivered notification creates no second record', async () => {
    const first  = await suppressEmailPlatformWide('dup@example.com', 'bounce')
    const second = await suppressEmailPlatformWide('dup@example.com', 'bounce')

    expect(first.alreadySuppressed).toBe(false)
    expect(second.alreadySuppressed).toBe(true)
    expect(store.size).toBe(1)
  })

  it('preserves the original createdAt when re-delivered', async () => {
    await suppressEmailPlatformWide('dup@example.com', 'bounce')
    await suppressEmailPlatformWide('dup@example.com', 'bounce')

    // Second write must not restamp the timestamp.
    const secondPayload = setSpy.mock.calls[1][1] as Record<string, unknown>
    expect(secondPayload).not.toHaveProperty('createdAt')
  })

  it('normalises case and whitespace so one mailbox is one record', async () => {
    await suppressEmailPlatformWide('  MiXeD@Example.COM  ', 'bounce')
    await suppressEmailPlatformWide('mixed@example.com', 'bounce')
    expect(store.size).toBe(1)
  })
})

describe('isSuppressed — the canonical check', () => {
  it('blocks a platform-suppressed address for every sender', async () => {
    await suppressEmailPlatformWide('dead@example.com', 'bounce')
    expect(await isSuppressed('dead@example.com')).toBe(true)
    expect(await isSuppressed('dead@example.com', 'organizer-A')).toBe(true)
    expect(await isSuppressed('dead@example.com', 'organizer-B')).toBe(true)
  })

  it('scopes an unsubscribe to the organizer it was made against', async () => {
    await addToSuppressionList('opted-out@example.com', 'organizer-A', 'unsubscribe')
    expect(await isSuppressed('opted-out@example.com', 'organizer-A')).toBe(true)
    // Another organizer's ticket must still reach them.
    expect(await isSuppressed('opted-out@example.com', 'organizer-B')).toBe(false)
    expect(await isSuppressed('opted-out@example.com')).toBe(false)
  })

  it('allows an address that was never suppressed', async () => {
    expect(await isSuppressed('fine@example.com', 'organizer-A')).toBe(false)
  })

  it('treats an empty address as not suppressed rather than throwing', async () => {
    expect(await isSuppressed('')).toBe(false)
  })
})

describe('broadcast pre-filter includes platform suppressions', () => {
  it('unions the organizer opt-outs with platform bounces', async () => {
    await addToSuppressionList('unsub@example.com', 'organizer-A', 'unsubscribe')
    await suppressEmailPlatformWide('bounced@example.com', 'bounce')
    await addToSuppressionList('other@example.com', 'organizer-B', 'unsubscribe')

    const set = await getOrganiserSuppressionSet('organizer-A')
    expect(set.has('unsub@example.com')).toBe(true)
    expect(set.has('bounced@example.com')).toBe(true)   // never unsubscribed from A
    expect(set.has('other@example.com')).toBe(false)    // belongs to another organizer
  })
})
