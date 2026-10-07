// RD-WALLET-W2.e — Super Admin Wallet Management: security + read-only source contracts.
// (The behaviour on real Firestore is tests/emulator/walletManagement.emu.test.ts.)

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (p: string) => readFileSync(p, 'utf8')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const ROUTE   = 'app/api/admin/wallet-management/route.ts'
const SERVICE = 'lib/admin/walletManagementService.ts'
const CLIENT  = 'app/(admin)/admin/wallet-management/PageClient.tsx'

describe('authorization', () => {
  const src = code(ROUTE)
  it('exports GET only', () => {
    expect(src).toMatch(/export async function GET\(/)
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\(/)
  })
  it('gates on requireSuperAdmin (ADMIN_UIDS) before reading anything — never the legacy admin:true check alone', () => {
    expect(src).toContain("import { requireSuperAdmin } from '@/lib/admin/financialGuard'")
    expect(src).not.toContain('resolveAdminUid')
    const gate = src.indexOf('await requireSuperAdmin(req)')
    expect(gate).toBeGreaterThan(-1)
    for (const fn of ['getWalletOverview(', 'listOrganizerWallets(', 'getOrganizerWalletDetail(', 'listEventServices(', 'listWalletTransactions(', 'listRefundRequests(', 'getReconciliationPage(']) {
      expect(src.indexOf(fn), fn).toBeGreaterThan(gate)
    }
    expect(src).toContain('if (gate.response)')
  })
})

describe('read-only', () => {
  it('the service and route never write, log an audit row, persist a cursor or touch a payment provider', () => {
    for (const f of [SERVICE, ROUTE]) {
      const src = code(f)
      // Firestore-shaped writes (in-memory Map.set / Set.add are fine; the emulator suite traps every real write API).
      expect(src, f).not.toMatch(/\.doc\([^)]*\)\.(set|update|delete|create)\(/)
      expect(src, f).not.toMatch(/\.collection\([^)]*\)\.add\(/)
      expect(src, f).not.toMatch(/\b(tx|txn|transaction|batch|ref|docRef|snap\.ref)\.(set|update|delete|create)\(/)
      expect(src, f).not.toMatch(/runTransaction|\.batch\(|bulkWriter|recursiveDelete/)
      expect(src, f).not.toMatch(/writeCursor|logAdminAction|stageAdminAudit|flagSuspicious/)
      expect(src, f).not.toMatch(/razorpay|cashfree|resolvePaymentProvider/i)
    }
  })
  it('the console only issues GETs to its own read API', () => {
    const src = code(CLIENT)
    expect(src).toContain('/api/admin/wallet-management?')
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/)
    expect((src.match(/fetch\(/g) ?? []).length).toBe(1)
  })
})

describe('honest about missing data', async () => {
  const { UNAVAILABLE_SOURCES } = await import('@/lib/admin/walletManagementService')
  it('carry-forward, communication-wallet refunds, SMS allowance and media usage are declared unavailable', () => {
    // RD-WALLET-REQ — carry-forward now exists for event service units only (deliberate change).
    expect(UNAVAILABLE_SOURCES.carryForward).toMatch(/no carry-forward for communication-wallet balances or media credits/i)
    expect(UNAVAILABLE_SOURCES.communicationRefunds).toMatch(/no refund-request record/i)
    // RD-INTEG — SMS has no transport: nothing is sent or charged (it used to claim per-send billing).
    expect(UNAVAILABLE_SOURCES.smsAllowance).toMatch(/SMS is not available/i)
    expect(UNAVAILABLE_SOURCES.smsAllowance).not.toMatch(/billed/i)
    expect(UNAVAILABLE_SOURCES.mediaUsage).toMatch(/not a ledger counter/i)
  })
  it('the carry-forward tab shows the real request queue (RD-WALLET-REQ) and the note for what has none', () => {
    expect(code(CLIENT)).toContain('<ServiceRequestsQueue kind="carry_forward" />')
    expect(code(CLIENT)).toContain('overview?.unavailable.carryForward')
  })
})

describe('navigation', async () => {
  const { ADMIN_SIDEBAR_NAV, ROUTES } = await import('@/config/navigation')
  it('a separate Wallet Management item in Finance', () => {
    expect(ROUTES.ADMIN_WALLET_MANAGEMENT).toBe('/admin/wallet-management')
    const finance = ADMIN_SIDEBAR_NAV.find(g => g.label === 'Finance')!
    expect(finance.items.some(i => i.label === 'Wallet Management' && i.href === '/admin/wallet-management')).toBe(true)
  })
})

describe('W2.e.1 acceptance fixes', () => {
  const svc = code(SERVICE), ui = code(CLIENT)
  it('organizer paging covers BOTH wallet collections with one uid cursor (media-only organizers are listed)', () => {
    expect(svc).toContain("pageOf('organizerWallets'), pageOf('mediaCreditWallets')")
    expect(svc).toContain('Buffer.compare(')
  })
  it('empty detail sections are one compact line, not an empty table', () => {
    expect(ui).toContain('rows.length === 0 ? <EmptyLine>{empty}</EmptyLine>')
    expect(ui).not.toContain('<TableStateRow colSpan={head.length}>{empty}</TableStateRow>')
  })
  it('reconciliation detail shows money in rupees, not raw paise', () => {
    expect(ui).toContain('function detailText(')
    expect(ui).toContain("/Paise$/.test(k) && typeof v === 'number' ? rupees(v)")
  })
})

describe('W2.d S4 · reconciliation states are never read as a clean result', () => {
  const ui = code(CLIENT)
  it('an empty S2 result says it is NOT verified against the gateway, never "consistent"', () => {
    expect(ui).not.toContain('the records checked are consistent')
    expect(ui).toContain('This is not verified against the payment gateway.')
  })
  it('an error with no results says the run failed, not "no findings so far"', () => {
    expect(ui).toContain('The reconciliation could not be run — see the error above.')
  })
  it('a mock run that checked nothing says so, instead of "no findings"', () => {
    expect(ui).toContain('No top-ups were checked against the mock gateway.')
  })
})

describe('W2.d S4 · identifiers and confidence stay readable', () => {
  const ui = code(CLIENT)
  it('identifier values (…Id / …Ids) are shown exactly as stored — never underscore-mangled', () => {
    expect(ui).toContain(": /Ids?$/.test(k) ? String(v) : String(v).replace(/_/g, ' ')")
  })
  it('on small screens the confidence label travels with the finding (both reconciliation tables)', () => {
    expect((ui.match(/<span className="mt-1 block sm:hidden"><Pill value=\{f\.confidence\} map=\{CONFIDENCE_TONE\} \/><\/span>/g) ?? []).length).toBe(2)
  })
})
