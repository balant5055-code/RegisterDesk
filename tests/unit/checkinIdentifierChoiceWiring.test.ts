// RD-CHECKIN-ID-OPT-01 — the check-in workspace's "use identifiers for this event?" choice.
// Source contract (the component is fetch-driven; behaviour is proven on real Firestore in
// tests/emulator/checkinIdentifierOptional.emu.test.ts).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const CHOICE = readFileSync('components/checkin/IdentifierCheckinChoice.tsx', 'utf8')
const WS     = readFileSync('components/checkin/workspace/CheckinWorkspace.tsx', 'utf8')

describe('identifier choice at check-in', () => {
  it('is rendered by the check-in workspace, once per event', () => {
    expect(WS).toContain("import IdentifierCheckinChoice from '@/components/checkin/IdentifierCheckinChoice'")
    expect(WS).toContain('<IdentifierCheckinChoice eventId={eventId} getToken={getToken}')
  })
  it('stores the answer in the EXISTING identifier config — enabled only, nothing else, no new setting', () => {
    expect(CHOICE).toContain('/identifiers/config`')
    expect(CHOICE).toContain("method: 'PUT'")
    expect(CHOICE).toContain('body: JSON.stringify({ enabled })')
    expect(CHOICE.match(/method: 'PUT'/g)).toHaveLength(1)
  })
  it('asks only when the event never configured identifiers; otherwise states the stored choice', () => {
    expect(CHOICE).toContain("if (o.configured) return { kind: 'set'")
    expect(CHOICE).toContain("{ kind: 'ask' }")
    expect(CHOICE).toContain('Use identifiers at check-in for this event?')
  })
  it('never offers "No" when identifiers are already assigned (would switch identifier search off)', () => {
    expect(CHOICE).toContain("assigned > 0 ? { kind: 'existing', assigned, label } : { kind: 'ask' }")
    expect(CHOICE).toContain("if (assigned === null) return { kind: 'hidden' }")
  })
  it('is hidden for callers who cannot read the identifier setup (gate staff get the configured behaviour)', () => {
    expect(CHOICE).toContain("if (!res || !res.ok) return { kind: 'hidden' }")
  })
})
