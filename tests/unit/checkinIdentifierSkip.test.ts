// RD-CHECKIN-ID-OPT-02 — identifiers are OPTIONAL at check-in, even with identifiers enabled.
// Source contracts; behaviour on real Firestore: tests/emulator/checkinIdentifierOptional.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const SCAN   = code(read('app/api/checkin/scan/route.ts'))
const PROMPT = code(read('components/checkin/IdentifierPrompt.tsx'))
const WORK   = code(read('components/checkin/workspace/CheckinWorkspace.tsx'))

describe('scan route', () => {
  it('only a strict boolean true skips', () => {
    expect(SCAN).toContain('skipIdentifier = body.skipIdentifier === true')
  })
  it('a typed value is still validated even when skip is sent (the value wins)', () => {
    expect(SCAN).toContain('if (!hasIdentifier && !(skipIdentifier && !identifierValue)) {')
  })
  it('the gate still runs AFTER eligibility and BEFORE the check-in transaction', () => {
    const gate = SCAN.indexOf('skipIdentifier && !identifierValue')
    expect(gate).toBeGreaterThan(SCAN.indexOf('EVENT_NOT_ACCEPTING_CHECKINS'))
    expect(gate).toBeLessThan(SCAN.indexOf('adminDb.runTransaction<boolean>'))
  })
  it('every prompt response says it is optional', () => {
    expect(SCAN.match(/identifierOptional: true,/g)?.length).toBe(2)
  })
})

describe('prompt + workspace', () => {
  it('the shared prompt offers "Check in without …" only when a skip handler is given', () => {
    expect(PROMPT).toContain('{onSkip && (')
    expect(PROMPT).toContain('Check in without {label}')
  })
  it('the workspace retries the SAME ticket with skipIdentifier, and never offers skip while correcting', () => {
    expect(WORK).toContain('onSkip={prompt.correcting ? undefined : () => void submitCode(prompt.ticketCode, undefined, true)}')
    expect(WORK).toContain('...(skipIdentifier ? { skipIdentifier: true } : {})')
  })
  it('the choice banner no longer says identifiers are required', () => {
    const CHOICE = read('components/checkin/IdentifierCheckinChoice.tsx')
    expect(CHOICE).toContain('It is optional: you can check them in without it.')
    expect(CHOICE).not.toContain('is asked for one')
  })
})
