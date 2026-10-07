// RD-PAYMENT-ONBOARDING-03 — who is allowed to read the payout identifiers.
//
// ═══ THE EXPOSURE THIS CLOSES ════════════════════════════════════════════════
// GET /api/organizer/payout-profile authorizes on the `transactions` permission, which the
// delegated `finance` role holds. It decrypted and returned the owner's PAN, bank account
// number and IFSC to that caller — while PUT had been owner-only since GA-7B precisely so
// "a finance team member cannot redirect payouts". Read and write disagreed about who the
// destination belongs to; a finance member could not change the bank account but could read
// it in full, which is everything needed to impersonate it elsewhere.
//
// Read now matches write: the owner gets plaintext (their edit form has to be pre-filled),
// everybody else gets the same masks the audit history has always used.
//
// The fixture stores LEGACY PLAINTEXT rather than ciphertext. decryptPii treats a value
// without the `enc:v1:` prefix as legacy plaintext and returns it unchanged (documented
// backward compatibility), so these cases exercise the masking decision without needing an
// encryption key in the test environment — and they would still fail if the route started
// leaking, which is the point.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ACCOUNT = '123456789012'
const IFSC    = 'HDFC0001234'
const PAN     = 'ABCDE1234F'
const UPI     = 'organiser@okhdfc'

const state = { isOwner: true }

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '',
    callerUid: state.isOwner ? 'org-1' : 'member-9',
    workspaceUid: 'org-1',
    role: state.isOwner ? 'owner' : 'finance',
    permissions: ['wallet', 'settlements', 'transactions'],
    isOwner: state.isOwner,
    eventIds: [], isStaffCredential: false,
  }),
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({
          uid: 'org-1',
          accountHolderName: 'Priya Sharma',
          payoutMethod: 'bank',
          bankName: 'HDFC Bank',
          accountNumber: ACCOUNT,
          ifscCode: IFSC,
          upiId: UPI,
          panNumber: PAN,
          gstNumber: '29ABCDE1234F1Z5',
          isVerified: true,
          verifiedAt: null, verifiedBy: 'admin-1', rejectionNote: null,
          createdAt: null, updatedAt: null,
        }),
      }),
    }),
  },
  adminAuth: {},
}))

const req = () => new Request('http://localhost/api/organizer/payout-profile', {
  headers: { authorization: 'Bearer t' },
}) as never

async function get() {
  const { GET } = await import('@/app/api/organizer/payout-profile/route')
  const res = await GET(req())
  return { status: res.status, body: await res.json() as { profile: Record<string, unknown> | null } }
}

describe('RD-PAYMENT-ONBOARDING-03 · payout identifiers are owner-only', () => {
  beforeEach(() => { vi.resetModules() })

  describe('the OWNER', () => {
    beforeEach(() => { state.isOwner = true })

    it('receives the real values — the edit form cannot pre-fill without them', async () => {
      const { body } = await get()
      expect(body.profile).toMatchObject({
        accountNumber: ACCOUNT, ifscCode: IFSC, panNumber: PAN, secretsVisible: true,
      })
    })

    it('also receives the masks, so a summary never has to slice the plaintext', async () => {
      const { body } = await get()
      expect(body.profile).toMatchObject({
        accountNumberMasked: '••••9012',
        ifscMasked:          'HDFC••••',
        panMasked:           '••••234F',
      })
    })
  })

  describe('a DELEGATED finance member', () => {
    beforeEach(() => { state.isOwner = false })

    it('is still allowed to read the profile at all', async () => {
      const { status, body } = await get()
      expect(status).toBe(200)
      expect(body.profile).not.toBeNull()
      expect(body.profile).toMatchObject({ accountHolderName: 'Priya Sharma', isVerified: true })
    })

    it('receives a MASKED account number and PAN, not the real ones', async () => {
      const { body } = await get()
      expect(body.profile).toMatchObject({
        accountNumberMasked: '••••9012',
        panMasked:           '••••234F',
        ifscMasked:          'HDFC••••',
        secretsVisible:      false,
      })
    })

    it('receives a MASKED GSTIN — a GSTIN contains the PAN at characters 3-12', async () => {
      // Found by the whole-body assertion below: masking `panNumber` while returning
      // `29ABCDE1234F1Z5` in full hands over the very PAN that was just hidden.
      const { body } = await get()
      expect(body.profile!.gstNumber).toBe('29••••••••••1Z5')
    })

    it('receives NO plaintext in the dedicated fields', async () => {
      const { body } = await get()
      expect(body.profile!.accountNumber).toBeNull()
      expect(body.profile!.ifscCode).toBeNull()
      expect(body.profile!.panNumber).toBe('')
    })

    it('the WHOLE response body contains no secret anywhere — not in any field, masked or not', async () => {
      // The strongest form of the assertion: serialise everything the caller receives and
      // prove the raw values are absent. A future field that quietly re-adds one fails here
      // even if it is named something nobody thought to assert on.
      const { body } = await get()
      const raw = JSON.stringify(body)
      expect(raw).not.toContain(ACCOUNT)
      expect(raw).not.toContain(PAN)
      expect(raw).not.toContain(IFSC)
    })

    it('receives no ciphertext either — masks are derived, never the stored form', async () => {
      const { body } = await get()
      expect(JSON.stringify(body)).not.toContain('enc:v1:')
    })
  })

  it('the owner and the delegate get the SAME non-sensitive facts', async () => {
    // Masking must not become a second, quietly different view of the account.
    state.isOwner = true
    const owner = (await get()).body.profile!
    vi.resetModules()
    state.isOwner = false
    const member = (await get()).body.profile!

    for (const k of ['accountHolderName', 'payoutMethod', 'bankName', 'isVerified',
                     'accountNumberMasked', 'ifscMasked', 'panMasked'] as const) {
      expect(member[k]).toEqual(owner[k])
    }
  })
})
