// RD-ORGANIZER-SIGNUP-02 — the organizer signup lifecycle: pending → active.
//
// ═══ WHAT THIS PINS, AND WHY IT IS WORTH PINNING ═════════════════════════════
// A signup writes users/{uid} with role=organizer BEFORE the email OTP is verified.
// That is deliberate — the profile carries form data the verification round-trip does
// not, and orphan recovery decides "incomplete signup vs real duplicate" by asking
// whether that profile exists — but it meant an unverified signup was published to the
// admin console as an ACTIVE organizer. `accountStatus: 'pending'` is what closes that,
// and these tests hold the two halves of it: the field is written at signup, and
// nothing flattens it back to 'active' on the way out.
//
// The flattening is the real risk. Three readers had each written
// `s === 'suspended' || s === 'banned' ? s : 'active'` independently, a shape that is
// correct for three values and silently wrong for a fourth. The resolver is now one
// function and §2 below pins its whole truth table, including the backward-compatibility
// case (a document with NO accountStatus is still active — every organizer created
// before this field existed depends on that and none of them is migrated).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAccountStatus, type AccountStatus } from '@/lib/admin/organizerTypes'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comments stripped — a claim must be made by CODE, not by a comment. */
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

const PROFILE   = 'lib/firebase/firestore/index.ts'
const VERIFY    = 'app/api/auth/verify-otp/route.ts'
const ADMINLIST = 'app/api/admin/organizers/route.ts'
const TYPES     = 'lib/admin/organizerTypes.ts'
const STATUS    = 'lib/admin/organizerStatus.ts'
const O360      = 'lib/admin/organizer360Service.ts'
const ACCESS    = 'lib/team/access.ts'
const HEAL      = 'lib/organizer/ensureProfile.ts'
const DETAIL    = 'app/api/admin/organizers/[uid]/route.ts'
const SUPPORT   = 'lib/admin/supportService.ts'
const SERVICE   = 'lib/admin/organizerService.ts'
const ADMINUI   = 'app/(admin)/admin/organizers/PageClient.tsx'
const ORG360UI  = 'app/(admin)/admin/organizers/[organizerUid]/PageClient.tsx'
const SIGNUP    = 'app/(auth)/login/page.tsx'
const VERIFYUI  = 'app/(auth)/verify-email/page.tsx'

/**
 * Every non-test source file under app/ + lib/ that mentions accountStatus at all.
 *
 * The sweep exists because the enumerated alternative failed: see the D7 note in §2.
 * Discovering readers instead of listing them is the only version of this gate that can
 * catch a copy nobody remembered writing.
 */
function accountStatusReaders(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      if (read(p).includes('accountStatus')) out.push(p)
    }
  }
  walk('app'); walk('lib')
  return out
}

// ═══ 1 · A · a new signup is created PENDING ═════════════════════════════════

describe('A · signup writes accountStatus: pending', () => {
  it('createOrganizerProfile writes the pending lifecycle state', () => {
    const src = code(PROFILE)
    expect(src).toMatch(/accountStatus:\s*'pending'/)
  })

  it('and keeps every field the signup profile already carried', () => {
    const src = code(PROFILE)
    for (const field of [
      'role:             ORGANIZER_ROLE',
      'emailVerified:    false',
      "verified:        false",
      "level:  'unverified'",
    ]) {
      expect(src, `signup profile lost ${field}`).toContain(field)
    }
  })
})

// ═══ 2 · C/D/E/F · the resolver's whole truth table ══════════════════════════

describe('C-F · resolveAccountStatus is the one reader, and it flattens nothing', () => {
  const cases: [unknown, AccountStatus, string][] = [
    [undefined,    'active',    'D · a pre-existing organizer with NO field stays active'],
    [null,         'active',    'D · an explicitly null field stays active'],
    ['active',     'active',    'an active organizer stays active'],
    ['pending',    'pending',   'C · pending is NEVER converted to active'],
    ['suspended',  'suspended', 'E · a suspended organizer stays suspended'],
    ['banned',     'banned',    'F · a banned organizer stays banned'],
    ['nonsense',   'active',    'an unknown value falls back to active (unchanged contract)'],
    ['',           'active',    'an empty string falls back to active'],
  ]
  for (const [stored, expected, why] of cases) {
    it(why, () => expect(resolveAccountStatus(stored)).toBe(expected))
  }

  it('every reader delegates to it — no second copy of the rule survives', () => {
    // RD-ORGANIZER-SIGNUP-FIX-02 (D7) · this test used to iterate an ENUMERATED list of
    // three files — and that is precisely how D1 and D2 shipped. Two further copies of the
    // rule lived in app/api/admin/organizers/[uid]/route.ts and lib/admin/supportService.ts,
    // were never in the list, and so passed a gate whose own name claims that no second
    // copy survives. An enumerated list can only pin the copies somebody remembered.
    //
    // It now sweeps every source file that mentions accountStatus, so a fifth copy written
    // anywhere in app/ or lib/ fails here instead of waiting for an audit to find it.
    const OLD = /===\s*'suspended'\s*\|\|\s*\w+\s*===\s*'banned'\s*\?\s*\w+\s*:\s*'active'/
    const readers = accountStatusReaders()
    // The sweep proves nothing if it is not actually finding files.
    expect(readers.length).toBeGreaterThan(5)
    expect(readers).toContain(DETAIL)
    expect(readers).toContain(SUPPORT)
    for (const f of readers) {
      // TYPES is the canonical definition — the one place this shape belongs.
      if (f === TYPES) continue
      expect(code(f), `${f} carries its own copy of the status rule`).not.toMatch(OLD)
    }
  })

  it('every reader that resolves a stored status calls the resolver', () => {
    for (const f of [ADMINLIST, STATUS, O360, DETAIL, SUPPORT]) {
      expect(code(f), `${f} does not use the canonical resolver`).toContain('resolveAccountStatus')
    }
  })

  it('the resolver lives beside the type it interprets', () => {
    expect(code(TYPES)).toContain('export function resolveAccountStatus')
    expect(code(TYPES)).toMatch(/AccountStatus\s*=\s*'active'\s*\|\s*'pending'\s*\|\s*'suspended'\s*\|\s*'banned'/)
  })
})

// ═══ 3 · B · the admin list excludes pending ═════════════════════════════════

describe('B · a pending signup is not in the normal admin organizer list', () => {
  it('the unfiltered list skips pending rows', () => {
    const src = code(ADMINLIST)
    expect(src).toContain("if (!status && item.accountStatus === 'pending') continue")
  })

  it('pending is reachable only by asking for it explicitly', () => {
    const src = code(ADMINLIST)
    expect(src).toMatch(/statusRaw === 'pending'/)
    // and the per-row equality filter is still the only other way a status narrows
    expect(src).toContain('if (status && item.accountStatus !== status) continue')
  })

  it('the admin UI offers Pending as its own filter and never as "All"', () => {
    const src = code('app/(admin)/admin/organizers/PageClient.tsx')
    expect(src).toMatch(/value: 'pending'/)
    // "All" must stay the empty value — the route excludes pending from it.
    expect(src).toMatch(/value: '',\s*label: 'All'/)
  })
})

// ═══ 4 · G/H/I/J · activation happens once, inside the OTP transaction ═══════

describe('G-J · activation is transactional and only ever pending → active', () => {
  const src = code(VERIFY)

  it('G · a successful verification promotes the pending row', () => {
    // RD-PHASE4 signup transition — the promotion covers a pending row AND a never-verified
    // legacy row (no accountStatus, neither verified flag set); nothing else.
    expect(src).toContain("const promote = storedStatus === 'pending' || legacyUnverified")
    expect(src).toContain("...(promote ? { accountStatus: 'active' } : {})")
    expect(src).toMatch(/legacyUnverified = storedStatus == null\s*&& stored\.emailVerified !== true\s*&& stored\.verification\?\.email\?\.verified !== true/)
  })

  it('G · and does so inside the EXISTING transaction — no second one was added', () => {
    // One transaction in this route, and the activation is inside its callback.
    expect((src.match(/runTransaction/g) ?? [])).toHaveLength(1)
    const tx = src.slice(src.indexOf('runTransaction'), src.indexOf('switch (outcome.kind)'))
    expect(tx).toContain('accountStatus')
  })

  it('H/I · a wrong or expired code returns before any profile write', () => {
    // The guards that precede the success branch, in order. Each one returns, so a
    // pending row cannot be promoted by a failed attempt.
    const tx = src.slice(src.indexOf('runTransaction'), src.indexOf('return { kind: \'ok\''))
    for (const guard of [
      "return { kind: 'forbidden' }",     // OTP bound to another uid
      "kind: 'expired'",                  // past expiresAt
      "return { kind: 'max' }",           // attempts exhausted
      "kind: 'invalid'",                  // wrong code
    ]) {
      expect(tx, `missing guard: ${guard}`).toContain(guard)
    }
    // …and every one of them appears BEFORE the single activation write, so a failed
    // attempt returns without ever reaching it.
    const activation = tx.indexOf('accountStatus')
    expect(activation).toBeGreaterThan(-1)
    for (const guard of ["kind: 'forbidden'", "kind: 'expired'", "kind: 'max'", "kind: 'invalid'"]) {
      expect(tx.indexOf(guard), `${guard} is not before the activation`).toBeLessThan(activation)
    }
    // exactly two WRITES of the activated state in the whole transaction, and no more:
    // the conditional promotion of an existing pending row, and the orphan-heal branch
    // that creates an already-verified profile. (Other mentions of the field are the
    // read of the stored value, which writes nothing.)
    expect((tx.match(/accountStatus:\s*'active'/g) ?? []).length).toBe(2)
    expect(tx).not.toMatch(/accountStatus:\s*'pending'/)
  })

  it('J · a replayed OTP cannot activate a second time', () => {
    expect(src).toMatch(/kind:\s*'already'/)
  })

  it('a suspended or banned document is never silently reactivated by a verification', () => {
    // The promotion is conditional on the STORED value being 'pending' — so moderation
    // survives an OTP. An unconditional `accountStatus: 'active'` here would undo a ban.
    expect(src).not.toMatch(/emailVerified:\s*true,\s*\n\s*accountStatus:\s*'active'/)
    expect(src).toContain('storedStatus')
  })

  it('the orphan self-heal branch creates an already-activated profile', () => {
    // That branch runs only when no profile exists, so there is no pending row to
    // promote — the account is created in the state a completed verification means.
    const healBranch = src.slice(src.indexOf('} else {'), src.indexOf('return { kind: \'ok\''))
    expect(healBranch).toContain("accountStatus:    'active'")
  })
})

// ═══ 5 · K/L · the gates and the existing flows are untouched ════════════════

describe('K-L · nothing else in the lifecycle moved', () => {
  it('K · verifyCaller still refuses any unverified token, and was not modified', () => {
    expect(code(ACCESS)).toContain('if (decoded.email_verified !== true) return null')
    // It gates on the Firebase flag, NOT on accountStatus — a pending signup is blocked
    // by the token, which is why this phase adds no new gate.
    expect(code(ACCESS)).not.toContain('accountStatus')
  })

  it('L · the OTP engine itself is unchanged — binding, caps, expiry, hashing', () => {
    const verify = code(VERIFY)
    expect(verify).toContain("if (otp.uid !== uid)")               // uid binding
    expect(verify).toContain('sec.otpMaxAttempts')                  // attempt cap
    expect(verify).toContain('FieldValue.increment(1)')             // attempt accounting
    expect(verify).toContain('verifyIdToken(bearer, true)')         // checkRevoked: revoked sessions
    const send = code('app/api/auth/send-otp/route.ts')
    expect(send).toContain('hashCode')                              // never plaintext
    expect(send).toContain('otpRateLimits')                         // resend limit
    expect(send).not.toContain('accountStatus')                     // untouched by this phase
  })

  it('L · orphan recovery still decides by the PROFILE existing, not by its status', () => {
    const src = code('lib/firebase/auth/index.ts')
    expect(src).toContain('organizerProfileExists')
    expect(src).not.toContain('accountStatus')
  })

  it('the dashboard self-heal writes the same lifecycle field as the canonical flows', () => {
    expect(code(HEAL)).toContain("accountStatus:    authEmailVerified ? 'active' : 'pending'")
  })

  it('no migration of existing organizers was introduced', () => {
    // Pre-existing rows have no accountStatus and are grandfathered by the resolver.
    for (const f of [PROFILE, VERIFY, ADMINLIST, STATUS, O360, TYPES]) {
      expect(code(f), `${f} looks like it back-fills existing documents`)
        .not.toMatch(/updateMany|bulkWriter|migrat/i)
    }
  })
})

// ═══ 5 · RD-ORGANIZER-SIGNUP-FIX-02 · D3 ═════════════════════════════════════
//
// 'pending' is not a moderation state. Reactivating it wrote accountStatus: 'active'
// while Auth emailVerified stayed false — and because nothing anywhere writes 'pending'
// back, that was irreversible: the unverified signup became permanently
// indistinguishable from a verified organizer and re-entered the default admin list.

describe('D3 · an unverified signup cannot be reactivated', () => {
  it('the moderation service refuses reactivate from pending', () => {
    const src = code(SERVICE)
    // Keyed off the RESOLVED status, not the raw field — otherwise a document with no
    // accountStatus would take the same branch as an explicit 'pending'.
    expect(src).toContain('resolveAccountStatus')
    expect(src).toMatch(/action === 'reactivate'\s*&&\s*current === 'pending'/)
    expect(src).toMatch(/invalidTransition:\s*true/)
  })

  it('but suspend and ban stay available for a pending signup', () => {
    // The guard names reactivate ONLY, deliberately: an abusive signup must be
    // stoppable before it verifies. Widening it would remove that.
    const src = code(SERVICE)
    expect(src).not.toMatch(/action === 'suspend'\s*&&\s*current === 'pending'/)
    expect(src).not.toMatch(/action === 'ban'\s*&&\s*current === 'pending'/)
  })

  it('the route reports a refused transition as 409, not 404', () => {
    const src = code(DETAIL)
    expect(src).toContain('result.invalidTransition')
    expect(src).toMatch(/invalidTransition[\s\S]{0,400}status:\s*409/)
  })

  it('the admin UI offers Reactivate only from suspended or banned', () => {
    const src = code(ADMINUI)
    expect(src).toMatch(/accountStatus === 'suspended' \|\| o\.accountStatus === 'banned'/)
    // The old gate showed the button for ANY non-active status, pending included.
    expect(src).not.toMatch(/o\.accountStatus !== 'active' &&/)
  })

  it('and the 360 console — the OTHER moderation entry point — is gated the same way', () => {
    // Both UIs reach the same PATCH. Fixing only the list would leave the console
    // offering an action the service refuses, and — because its gate was a ternary —
    // would keep Suspend hidden from the pending signups that most need it.
    const src = code(ORG360UI)
    expect(src).toMatch(/account\.status === 'suspended' \|\| o\.account\.status === 'banned'/)
    expect(src).not.toMatch(/o\.account\.status !== 'active'\s*$/m)
  })
})

// ═══ 6 · RD-ORGANIZER-SIGNUP-FIX-02 · D4 ═════════════════════════════════════
//
// send-otp commits the OTP BEFORE attempting delivery and returns `otpId` alongside a
// 502 EMAIL_DELIVERY_FAILED, precisely so the code stays usable when the provider is
// down. Signup discarded that body, so the organizer landed on /verify-email with no
// otpId — where submitCode() returns early and typing six digits did nothing at all.

describe('D4 · a delivery failure never produces an inert verification screen', () => {
  it('signup carries the otpId through whatever status send-otp returned', () => {
    const src = code(SIGNUP)
    expect(src).toMatch(/const \{ otpId \} = await res\.json\(\)\.catch/)
    expect(src).toMatch(/verifyEmailHref\(\{ otpId, delivered: res\.ok \}\)/)
    // The branch that threw the body away.
    expect(src).not.toMatch(/if \(res\.ok\) \{\s*const \{ otpId \}/)
  })

  it('an undelivered code is flagged so the verify screen cannot claim it was sent', () => {
    // BLOCKER-04 · observed in the browser: with send-otp returning 502 the screen still
    // read "We sent a 6-digit code to …". The code was real; the email was not.
    expect(code(SIGNUP)).toMatch(/q\.set\('delivery', 'failed'\)/)
    const src = code(VERIFYUI)
    expect(src).toMatch(/searchParams\.get\('delivery'\) === 'failed'/)
    expect(src).toContain("couldn&apos;t email it to")
    // A successful resend means a code really did go out — the notice must clear.
    expect(src).toMatch(/setDeliveryFailed\(false\)/)
  })

  it('the verify screen states the missing-code state and disables the dead inputs', () => {
    const src = code(VERIFYUI)
    expect(src).toMatch(/const awaitingCode = !currentOtpId/)
    expect(src).toMatch(/disabled=\{verifying \|\| awaitingCode\}/)
    // The copy must name the state rather than leaving the disabled boxes unexplained,
    // and must not claim a send failed — the dashboard guard reaches this screen without
    // ever attempting one.
    expect(src).toContain('Request a verification code for')
    expect(src).not.toMatch(/couldn&apos;t send a code/)
    // Resend must stay enabled — it is the only control that can recover the screen.
    expect(src).not.toMatch(/disabled=\{cooldown > 0 \|\| resendLoading \|\| awaitingCode\}/)
  })
})
