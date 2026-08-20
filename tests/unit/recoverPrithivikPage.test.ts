// RD-RECOVER-01 · the temporary client execution page.
//
// This page moves real money by proxy, so the properties worth pinning are the negative ones:
// it must hold no target of its own, must not be able to fire twice, and must not leak the
// token it attaches. Those are structural facts about the source, which is how the rest of
// this suite tests client modules (there is no DOM testing library in the project).
//
// The page is scaffolding for one incident. These tests exist so that while it is alive it
// cannot quietly become a general repair console.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DIR    = 'app/(admin)/admin/recover-prithivik'
const CLIENT = `${DIR}/PageClient.tsx`
const PAGE   = `${DIR}/page.tsx`

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
   .replace(/^\s*\/\/.*$/gm, '')

const SRC = strip(read(CLIENT))

// ─── It holds no target ───────────────────────────────────────────────────────

describe('the page carries no knowledge of which payment it recovers', () => {
  it.each([
    ['order id',   'order_TS6MJY6uL9NgCw'],
    ['payment id', 'pay_TS6MPmXBJ9bHsj'],
    ['paise',      '51840'],
    ['event slug', 'noyyal-marathon-2026'],
    ['pass id',    'pass_riwintpf'],
    ['phone',      '9994349808'],
  ])('does not contain the %s', (_label, value) => {
    expect(SRC).not.toContain(value)
  })

  it('sends NO request body', () => {
    // Scoped to the fetch options object: the page has a state field also called `body`
    // (the rendered response text), which is not a request body.
    const opts = SRC.slice(SRC.indexOf('await fetch(RECOVERY_ENDPOINT, {'), SRC.indexOf('const body'))
    expect(opts).not.toMatch(/\bbody\s*:/)
    expect(SRC).not.toContain('JSON.stringify({')
  })

  it('takes no input from the URL, storage, or form fields', () => {
    for (const bad of [
      'useSearchParams', 'searchParams', 'useParams', 'localStorage', 'sessionStorage',
      'document.cookie', '<input', '<form', 'onChange',
    ]) {
      expect(SRC, bad).not.toContain(bad)
    }
  })

  it('the rupee figure is display-only — never sent or compared', () => {
    expect(SRC).toContain('518.40')
    // It appears inside JSX copy, never in the fetch call or a comparison.
    const fetchCall = SRC.slice(SRC.indexOf('await fetch('), SRC.indexOf('const body'))
    expect(fetchCall).not.toContain('518')
    expect(SRC).not.toMatch(/51840\s*[=!]==/)
  })
})

// ─── Exactly one POST, to exactly one endpoint ───────────────────────────────

describe('exactly one request, to one endpoint', () => {
  it('has a single fetch call', () => {
    expect(SRC.match(/fetch\(/g) ?? []).toHaveLength(1)
  })

  it('is a POST to the recovery route', () => {
    expect(SRC).toContain("const RECOVERY_ENDPOINT = '/api/admin/recover-orphaned-capture'")
    expect(SRC).toContain('await fetch(RECOVERY_ENDPOINT, {')
    expect(SRC).toContain("method:  'POST',")
  })

  it('calls no other API route', () => {
    const paths = SRC.match(/'\/api\/[^']*'/g) ?? []
    expect(paths).toEqual(["'/api/admin/recover-orphaned-capture'"])
  })

  it('never retries — no retry loop, no timer, no recursion', () => {
    for (const bad of ['setTimeout', 'setInterval', 'retry', 'while (', 'for (']) {
      expect(SRC, bad).not.toContain(bad)
    }
  })
})

// ─── It cannot fire on load, and cannot fire twice ───────────────────────────

describe('firing requires one deliberate click and can happen only once', () => {
  it('does not run on mount', () => {
    expect(SRC).not.toContain('useEffect')
  })

  it('the POST is reachable only from the click handler', () => {
    const handler = SRC.slice(SRC.indexOf('async function handleRecover'), SRC.indexOf('const label'))
    expect(handler).toContain('await fetch(RECOVERY_ENDPOINT')
    expect(SRC).toContain('onClick={handleRecover}')
  })

  it('a synchronous ref guard — not React state — blocks the second request', () => {
    // `disabled` alone is insufficient: setState is async, so a double-click can land two
    // events before a re-render applies the prop.
    const handler = SRC.slice(SRC.indexOf('async function handleRecover'), SRC.indexOf('const label'))
    expect(handler).toMatch(/if \(fired\.current\) return\s*\n\s*fired\.current = true/)
    // The guard is set BEFORE the request, and never cleared.
    expect(handler.indexOf('fired.current = true')).toBeLessThan(handler.indexOf('await fetch('))
    expect(SRC).not.toContain('fired.current = false')
  })

  it('also disables the button for the visible affordance', () => {
    expect(SRC).toContain("disabled={outcome.state !== 'idle'}")
  })

  it('offers exactly one button, and no button for any other payment', () => {
    expect(SRC.match(/<button/g) ?? []).toHaveLength(1)
  })

  it('shows the confirmation copy before execution', () => {
    expect(SRC).toContain('This will attempt recovery for S.P. PRITHIVIK')
  })

  it('the idle button is labelled exactly "Recover PRITHIVIK"', () => {
    expect(SRC).toContain(": 'Recover PRITHIVIK'")
  })
})

// ─── The token is attached, never exposed ────────────────────────────────────

describe('the ID token is attached and nothing else', () => {
  it('uses the established auth import and null-checked helper', () => {
    expect(SRC).toContain("from '@/lib/firebase/auth'")
    expect(SRC).toContain('const u = auth.currentUser')
    expect(SRC).toContain("if (!u) throw new Error('Not authenticated')")
    expect(SRC).toContain('return u.getIdToken()')
  })

  it('sends it as the authorization header', () => {
    expect(SRC).toContain('headers: { authorization: `Bearer ${token}` },')
  })

  it('never logs, renders, or persists the token', () => {
    expect(SRC).not.toContain('console.')
    expect(SRC).not.toContain('localStorage')
    expect(SRC).not.toContain('{token}<')
    // The identifier appears only where it is created and where it is attached.
    expect(SRC.match(/\btoken\b/g) ?? []).toHaveLength(2)
  })
})

// ─── It implements none of the server's responsibilities ─────────────────────

describe('the server route remains the sole authority', () => {
  it('imports nothing that could perform server work', () => {
    // The strongest form of this guarantee, and the one immune to prose: an exhaustive
    // allow-list of imports. Words like "Razorpay" DO appear in the page's explanatory copy,
    // which is intentional and harmless; what matters is that no module capable of Razorpay,
    // Firestore, wallet or notification work is in scope.
    const imports = (SRC.match(/from\s+'([^']+)'/g) ?? []).map(m => m.replace(/from\s+'|'/g, '')).sort()
    expect(imports).toEqual(['@/components/admin', '@/components/admin', '@/lib/firebase/auth', 'react'])
  })

  it('names no server-side operation — those identifiers cannot appear in prose', () => {
    for (const bad of [
      'adminDb', 'getFirestore', 'collection(', 'settleCapturedRegistration',
      'recoverOrphanedCapture', 'sendConfirmationEmail', 'sendWhatsApp', 'ticketCode',
      'razorpay.', 'runTransaction',
    ]) {
      expect(SRC, bad).not.toContain(bad)
    }
  })

  it('renders the response as text — it does not interpret the outcome itself', () => {
    expect(SRC).toContain('const body = await res.text()')
    expect(SRC).toContain('outcome.ok')   // derived from res.ok, not from parsing fields
  })
})

// ─── Marked temporary ────────────────────────────────────────────────────────

describe('this page is marked as temporary', () => {
  it('both files say so, so it is not mistaken for a feature', () => {
    expect(read(PAGE)).toContain('DELETE THIS DIRECTORY ONCE THE RECOVERY HAS RUN')
    expect(read(CLIENT)).toContain('TEMPORARY. Delete this directory once the recovery has run.')
  })

  it('is NOT registered in the admin navigation SSOT', () => {
    // The Cmd-K palette derives from this SSOT; listing a money-moving button there would put
    // it one keystroke away for every admin.
    expect(read('config/navigation.ts')).not.toContain('recover-prithivik')
  })
})
