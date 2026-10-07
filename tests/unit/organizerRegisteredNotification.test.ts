// RD-ORGANIZER-NOTIFY-03 — the platform's notice that a new organizer registered.
//
// ═══ WHAT MATTERS ABOUT THIS NOTIFICATION ════════════════════════════════════
// It is the first entry in the catalog the platform sends to ITSELF, and the values in
// it are typed by a stranger. Two properties therefore carry the whole risk:
//
//   the recipient cannot be chosen by the signup   — it is resolved server-side
//   the content cannot be authored by the signup   — every field is escaped
//
// The rendering half is pure, so it is tested directly here against hostile input. The
// timing half — "only after the commit, only once" — is behaviour and is proved on real
// Firestore in tests/emulator/organizerRegisteredNotification.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderOrganizerRegisteredEmail } from '@/lib/notifications/templates/organizer'
import { NotificationType, NOTIFICATION_META } from '@/lib/notifications/catalog'
import { EMAIL_DISPATCHERS } from '@/lib/notifications/dispatchers'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

const ROUTE = 'app/api/auth/verify-otp/route.ts'

const params = {
  to:               'support@registerdesk.in',
  organizerName:    'Asha Menon',
  organizationName: 'Puliyampatti Runners',
  organizerEmail:   'asha@example.com',
  uid:              'uid-123',
  registeredAt:     '2026-09-23T10:15:00.000Z',
}

// ═══ 1 · registered like every other notification ════════════════════════════

describe('the type is a first-class catalog entry', () => {
  it('exists, is an email, and is scoped to the platform', () => {
    expect(NotificationType.ORGANIZER_REGISTERED).toBe('ORGANIZER_REGISTERED')
    expect(NOTIFICATION_META.ORGANIZER_REGISTERED.group).toBe('platform')
    expect(NOTIFICATION_META.ORGANIZER_REGISTERED.channel).toBe('email')
  })

  it('has a dispatcher, so the engine can deliver it', () => {
    expect(typeof EMAIL_DISPATCHERS.ORGANIZER_REGISTERED).toBe('function')
  })

  it('reuses the existing provider surface — no new provider method was added', () => {
    // It renders to CustomEmailParams and goes out through sendCustomEmail, exactly as
    // LICENSE_PURCHASED and WALLET_RECHARGED already do. A new sendXEmail() would have
    // meant editing the provider contract and both implementations.
    const src = code('lib/notifications/dispatchers.ts')
    expect(src).toContain('ORGANIZER_REGISTERED:      (p, x) => p.sendCustomEmail(renderOrganizerRegisteredEmail(x))')
    for (const f of ['lib/email/provider.ts', 'lib/email/ses.ts', 'lib/email/resend.ts']) {
      expect(code(f), `${f} was modified for this notification`).not.toContain('OrganizerRegistered')
    }
  })
})

// ═══ 2 · I · the content is escaped, and says only what it should ════════════

describe('I · rendering', () => {
  it('names the organization, the person, the email, the account and the time', () => {
    const { subject, html } = renderOrganizerRegisteredEmail(params)
    expect(subject).toContain('Puliyampatti Runners')
    for (const fact of ['Puliyampatti Runners', 'Asha Menon', 'asha@example.com', 'uid-123', '2026-09-23T10:15:00.000Z']) {
      expect(html, `missing ${fact}`).toContain(fact)
    }
    expect(html).toContain('Verified')
  })

  it('escapes every organizer-controlled value', () => {
    const hostile = renderOrganizerRegisteredEmail({
      ...params,
      organizerName:    '<img src=x onerror="alert(1)">',
      organizationName: '</td></tr><script>steal()</script>',
      organizerEmail:   'a"onmouseover="x@example.com',
    })
    // The property that matters is that no TAG survives: every angle bracket the signup
    // typed is an entity, so the browser renders characters rather than elements. Quote
    // characters legitimately remain — these values sit in TEXT content, not in an
    // attribute, and the codebase keeps escAttr for the attribute case (base.ts).
    expect(hostile.html).not.toContain('<script>')
    expect(hostile.html).not.toContain('<img src=x')
    expect(hostile.html).not.toContain('</td></tr><script')
    expect(hostile.html).toContain('&lt;script&gt;')
    expect(hostile.html).toContain('&lt;img src=x')
    expect(hostile.html).toContain('&lt;/td&gt;&lt;/tr&gt;')
    // the row structure the payload tried to break out of is still intact
    expect((hostile.html.match(/<tr>/g) ?? []).length).toBe((hostile.html.match(/<\/tr>/g) ?? []).length)
  })

  it('carries no OTP, token, password or secret — none is even a parameter', () => {
    const { html, subject } = renderOrganizerRegisteredEmail(params)
    const blob = `${subject} ${html}`.toLowerCase()
    for (const forbidden of ['otp', 'code', 'token', 'password', 'secret', 'bearer']) {
      expect(blob, `email mentions ${forbidden}`).not.toContain(forbidden)
    }
    // …and the params type itself offers no way to pass one.
    expect(Object.keys(params).sort()).toEqual([
      'organizationName', 'organizerEmail', 'organizerName', 'registeredAt', 'to', 'uid',
    ])
  })

  it('an empty organization or name degrades to a readable line, never "undefined"', () => {
    const bare = renderOrganizerRegisteredEmail({ ...params, organizationName: '', organizerName: '' })
    expect(bare.subject).toContain('asha@example.com')
    expect(bare.html).not.toContain('undefined')
    expect(bare.html).toContain('—')
  })
})

// ═══ 3 · H · the recipient is server-resolved ════════════════════════════════

describe('H · recipient', () => {
  it('comes from the branding config, and is not hardcoded anywhere', () => {
    const src = code(ROUTE)
    expect(src).toContain('getBrandingConfig()')
    expect(src).toContain('const to = branding.supportEmail')
    // no literal address in the route or the template
    for (const f of [ROUTE, 'lib/notifications/templates/organizer.ts']) {
      expect(code(f), `${f} hardcodes an address`).not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i)
    }
  })

  it('is never taken from the request', () => {
    const src = code(ROUTE)
    // The only body fields the route reads are the otp id and the code.
    expect(src).toContain('await req.json() as { otpId?: string; code?: string }')
    const dispatch = src.slice(src.indexOf('ORGANIZER_REGISTERED'))
    expect(dispatch).not.toContain('body.')
  })
})

// ═══ 4 · A-F · dispatch position and the guard ═══════════════════════════════

describe('A-F · the notification is downstream of the commit', () => {
  const src = code(ROUTE)

  it('is dispatched AFTER the transaction, not inside it', () => {
    const txEnd   = src.indexOf('switch (outcome.kind)')
    const dispatch = src.indexOf('NotificationType.ORGANIZER_REGISTERED')
    expect(dispatch).toBeGreaterThan(txEnd)
    // and no email call sits inside the transaction callback
    const tx = src.slice(src.indexOf('runTransaction'), txEnd)
    expect(tx).not.toContain('notificationEngine')
  })

  it('B-F · every failure path returns before it', () => {
    const dispatch = src.indexOf('NotificationType.ORGANIZER_REGISTERED')
    for (const failure of ['OTP_NOT_FOUND', 'FORBIDDEN', 'ALREADY_VERIFIED', 'EXPIRED', 'MAX_ATTEMPTS_REACHED', 'INVALID_CODE']) {
      expect(src.indexOf(failure), `${failure} is not before the dispatch`).toBeLessThan(dispatch)
    }
  })

  it('A · it is gated on the activation the transaction reported', () => {
    expect(src).toContain('if (outcome.activated)')
    // RD-PHASE4 signup transition — the same predicate that drives the activation write.
    expect(src).toContain('activated = promote')
    expect(src).toContain("const promote = storedStatus === 'pending' || legacyUnverified")
  })

  it('no second transaction was introduced', () => {
    expect((src.match(/runTransaction/g) ?? [])).toHaveLength(1)
  })

  it('the existing welcome email still goes to the organizer, unchanged', () => {
    expect(src).toContain('NotificationType.ACCOUNT_WELCOME, { to: email, name, orgName }')
    // exactly one welcome dispatch — the admin notice did not duplicate it
    expect((src.match(/ACCOUNT_WELCOME/g) ?? [])).toHaveLength(1)
  })
})

// ═══ 5 · G · a failed notification cannot fail the registration ══════════════

describe('G · failure semantics', () => {
  const src = code(ROUTE)

  it('is fire-and-forget and cannot reject unhandled', () => {
    const dispatch = src.slice(src.indexOf('if (outcome.activated)'), src.indexOf('return NextResponse.json({ verified: true })'))
    expect(dispatch).toContain('void getBrandingConfig()')
    expect(dispatch).toContain('.catch(')
    expect(dispatch).not.toContain('await notificationEngine.send(NotificationType.ORGANIZER_REGISTERED')
  })

  it('logs through the existing console error convention rather than throwing', () => {
    expect(src).toContain("console.error('[verify-otp] ORGANIZER_REGISTERED failed:'")
  })

  it('the success response is unconditional once verification committed', () => {
    const tail = src.slice(src.indexOf('if (outcome.activated)'))
    expect(tail).toContain('return NextResponse.json({ verified: true })')
  })
})

// ═══ 6 · the files the brief protects are untouched ══════════════════════════

describe('protected surfaces', () => {
  it('send-otp, lib/otp, verifyCaller and admin auth were not modified', () => {
    for (const f of ['app/api/auth/send-otp/route.ts', 'lib/team/access.ts', 'lib/admin/auth.ts']) {
      expect(code(f), `${f} mentions the new notification`).not.toContain('ORGANIZER_REGISTERED')
    }
  })
})
