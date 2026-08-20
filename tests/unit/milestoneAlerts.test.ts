// Booking Milestone Alerts — the pure resolver.
//
// WHAT THESE TESTS PROTECT. This function runs on the render path of a LIVE registration page,
// so the invariant that matters most is not "it picks the right message" but "it can never
// throw and never blocks". Every malformed-input case below exists because a half-finished
// organizer draft, a legacy event with an empty counter, or a counter that failed to load must
// all resolve to "no alert" rather than an error on a page where people are paying.
//
// The second invariant is that this stays PRESENTATION. Nothing here returns a decision about
// availability, price or eligibility — only a message to display or null.

import { describe, it, expect } from 'vitest'
import {
  resolveMilestoneAlert,
  resolveMilestoneAlertsByPass,
  MILESTONE_THRESHOLD_MAX,
  MILESTONE_MESSAGE_MAX,
  type MilestoneAlert,
} from '@/lib/events/milestoneAlerts'

const TSHIRT: MilestoneAlert = { threshold: 2000, message: 'T-shirt benefit is available for this pass.' }
const EARLY:  MilestoneAlert = { threshold: 1000, message: 'Early registration notice' }
const MEDAL:  MilestoneAlert = { threshold: 3000, message: 'Special finisher medal available' }

// ─── 1. Absent / empty configuration ⇒ today's behaviour exactly ───────────────

describe('no configuration behaves exactly as before the feature existed', () => {
  it('undefined ⇒ null', () => {
    expect(resolveMilestoneAlert(undefined, 5000)).toBeNull()
  })

  it('null ⇒ null', () => {
    expect(resolveMilestoneAlert(null, 5000)).toBeNull()
  })

  it('empty array ⇒ null', () => {
    expect(resolveMilestoneAlert([], 5000)).toBeNull()
  })

  it('a non-array (corrupt stored value) ⇒ null, not a throw', () => {
    for (const bad of ['x', 42, {}, true] as unknown[]) {
      expect(resolveMilestoneAlert(bad as MilestoneAlert[], 5000), String(bad)).toBeNull()
    }
  })
})

// ─── 2. Threshold boundary ────────────────────────────────────────────────────

describe('threshold boundary', () => {
  it('below threshold ⇒ nothing', () => {
    expect(resolveMilestoneAlert([TSHIRT], 1999)).toBeNull()
  })

  it('EXACTLY at threshold ⇒ shows (>=, not >)', () => {
    expect(resolveMilestoneAlert([TSHIRT], 2000)?.threshold).toBe(2000)
  })

  it('above threshold ⇒ still shows', () => {
    expect(resolveMilestoneAlert([TSHIRT], 2500)?.threshold).toBe(2000)
  })

  it('count 0 ⇒ nothing, even with a threshold of 1', () => {
    expect(resolveMilestoneAlert([{ threshold: 1, message: 'hi' }], 0)).toBeNull()
  })

  it('a threshold of 1 fires at 1', () => {
    expect(resolveMilestoneAlert([{ threshold: 1, message: 'hi' }], 1)?.threshold).toBe(1)
  })
})

// ─── 3. Highest crossed wins ──────────────────────────────────────────────────

describe('highest crossed milestone wins — one banner, never a stack', () => {
  const ALL = [EARLY, TSHIRT, MEDAL]

  it('at 2,500 shows the 2,000 notice, not the 1,000 one', () => {
    const r = resolveMilestoneAlert(ALL, 2500)
    expect(r?.threshold).toBe(2000)
    expect(r?.message).toBe(TSHIRT.message)
  })

  it('at 999 shows nothing', () => {
    expect(resolveMilestoneAlert(ALL, 999)).toBeNull()
  })

  it('at 1,000 shows the early notice', () => {
    expect(resolveMilestoneAlert(ALL, 1000)?.threshold).toBe(1000)
  })

  it('at 3,000+ shows the medal notice', () => {
    expect(resolveMilestoneAlert(ALL, 12_000)?.threshold).toBe(3000)
  })

  it('order of configuration does not matter', () => {
    const shuffled = [MEDAL, EARLY, TSHIRT]
    expect(resolveMilestoneAlert(shuffled, 2500)?.threshold).toBe(2000)
  })

  it('on a tie the FIRST configured entry wins, deterministically', () => {
    const tie: MilestoneAlert[] = [
      { threshold: 100, message: 'first' },
      { threshold: 100, message: 'second' },
    ]
    expect(resolveMilestoneAlert(tie, 100)?.message).toBe('first')
  })
})

// ─── 4. Invalid configuration is ignored, never fatal ─────────────────────────

describe('invalid entries are skipped safely', () => {
  it('rejects non-positive, fractional and non-finite thresholds', () => {
    const bad = [0, -1, -2000, 1.5, NaN, Infinity, -Infinity]
    for (const t of bad) {
      expect(resolveMilestoneAlert([{ threshold: t, message: 'x' }], 999_999), String(t)).toBeNull()
    }
  })

  it('rejects a threshold above the platform maximum', () => {
    expect(resolveMilestoneAlert(
      [{ threshold: MILESTONE_THRESHOLD_MAX + 1, message: 'x' }], Number.MAX_SAFE_INTEGER,
    )).toBeNull()
  })

  it('accepts a threshold exactly at the maximum', () => {
    expect(resolveMilestoneAlert(
      [{ threshold: MILESTONE_THRESHOLD_MAX, message: 'x' }], MILESTONE_THRESHOLD_MAX,
    )?.threshold).toBe(MILESTONE_THRESHOLD_MAX)
  })

  it('rejects an empty or whitespace-only message', () => {
    for (const m of ['', '   ', '\t', '\n  \n']) {
      expect(resolveMilestoneAlert([{ threshold: 10, message: m }], 100), JSON.stringify(m)).toBeNull()
    }
  })

  it('rejects a non-string message and a non-number threshold', () => {
    const bad = [
      { threshold: 10, message: 42 },
      { threshold: '10', message: 'x' },
      { threshold: 10 },
      { message: 'x' },
      null, undefined, 'nope', 7,
    ] as unknown[]
    expect(resolveMilestoneAlert(bad as MilestoneAlert[], 100)).toBeNull()
  })

  it('one invalid entry does not suppress a valid one', () => {
    const mixed = [{ threshold: -5, message: 'bad' }, TSHIRT, { threshold: 10, message: '  ' }]
    expect(resolveMilestoneAlert(mixed as MilestoneAlert[], 2500)?.threshold).toBe(2000)
  })
})

// ─── 5. Counter unavailable ⇒ no alert, never a throw ─────────────────────────

describe('an unreadable counter degrades to no alert', () => {
  it('null / undefined / NaN / negative counts all resolve to null', () => {
    for (const c of [null, undefined, NaN, -1, -9999, Infinity] as unknown[]) {
      expect(resolveMilestoneAlert([TSHIRT], c as number), String(c)).toBeNull()
    }
  })

  it('never throws for any combination of malformed inputs', () => {
    const configs = [null, undefined, [], [TSHIRT], 'x', 5, {}] as unknown[]
    const counts  = [null, undefined, NaN, -1, 0, 2500, Infinity] as unknown[]
    for (const cfg of configs) {
      for (const c of counts) {
        expect(() => resolveMilestoneAlert(cfg as MilestoneAlert[], c as number)).not.toThrow()
      }
    }
  })
})

// ─── 6. Live count dropping back below the threshold (no latching) ────────────

describe('no latching — the alert follows the live net count', () => {
  it('appears at 2,000, stays at 2,001, disappears at 1,999 after cancellations', () => {
    expect(resolveMilestoneAlert([TSHIRT], 2000)).not.toBeNull()
    expect(resolveMilestoneAlert([TSHIRT], 2001)).not.toBeNull()
    expect(resolveMilestoneAlert([TSHIRT], 1999)).toBeNull()
  })

  it('falls back to the lower milestone rather than vanishing entirely', () => {
    expect(resolveMilestoneAlert([EARLY, TSHIRT], 2500)?.threshold).toBe(2000)
    expect(resolveMilestoneAlert([EARLY, TSHIRT], 1500)?.threshold).toBe(1000)
  })
})

// ─── 7. Output normalisation ──────────────────────────────────────────────────

describe('resolved output is fully populated and normalised', () => {
  it('defaults tone to info and showOnSelection to false', () => {
    const r = resolveMilestoneAlert([TSHIRT], 2000)
    expect(r).toEqual({
      threshold: 2000, message: TSHIRT.message, tone: 'info', showOnSelection: false,
    })
  })

  it('preserves a valid tone and coerces an invalid one to info', () => {
    expect(resolveMilestoneAlert([{ ...TSHIRT, tone: 'success' }], 2000)?.tone).toBe('success')
    expect(resolveMilestoneAlert([{ ...TSHIRT, tone: 'warning' }], 2000)?.tone).toBe('warning')
    expect(resolveMilestoneAlert(
      [{ ...TSHIRT, tone: 'explode' as 'info' }], 2000,
    )?.tone).toBe('info')
  })

  it('showOnSelection is strictly boolean true, never truthy coercion', () => {
    expect(resolveMilestoneAlert([{ ...TSHIRT, showOnSelection: true }], 2000)?.showOnSelection).toBe(true)
    expect(resolveMilestoneAlert(
      [{ ...TSHIRT, showOnSelection: 'yes' as unknown as boolean }], 2000,
    )?.showOnSelection).toBe(false)
  })

  it('trims the message for display and caps it at the platform limit', () => {
    expect(resolveMilestoneAlert([{ threshold: 1, message: '  padded  ' }], 5)?.message).toBe('padded')
    const long = 'x'.repeat(MILESTONE_MESSAGE_MAX + 50)
    expect(resolveMilestoneAlert([{ threshold: 1, message: long }], 5)?.message.length)
      .toBe(MILESTONE_MESSAGE_MAX)
  })

  it('returns the message as PLAIN TEXT — markup is data, never interpreted here', () => {
    const raw = '<b>Bold</b> & <script>alert(1)</script>'
    const r = resolveMilestoneAlert([{ threshold: 1, message: raw }], 5)
    // Unchanged: escaping is React's job at render, not a transformation this layer applies.
    expect(r?.message).toBe(raw)
    expect(typeof r?.message).toBe('string')
  })
})

// ─── 8. Purity ────────────────────────────────────────────────────────────────

describe('purity — the input is never mutated', () => {
  it('leaves the array and its entries byte-identical', () => {
    const alerts: MilestoneAlert[] = [
      { threshold: 3000, message: ' c ' },
      { threshold: 1000, message: ' a ' },
      { threshold: 2000, message: ' b ' },
    ]
    const before = JSON.parse(JSON.stringify(alerts))
    resolveMilestoneAlert(alerts, 5000)
    expect(alerts).toEqual(before)
    expect(alerts[0].threshold).toBe(3000)   // not sorted in place
  })

  it('is deterministic across repeated calls', () => {
    const a = resolveMilestoneAlert([EARLY, TSHIRT, MEDAL], 2500)
    const b = resolveMilestoneAlert([EARLY, TSHIRT, MEDAL], 2500)
    expect(a).toEqual(b)
  })
})

// ─── 9. Per-pass resolution + isolation ───────────────────────────────────────

describe('resolveMilestoneAlertsByPass', () => {
  const passes = [
    { id: '5k',   milestoneAlerts: [TSHIRT] },
    { id: '10k',  milestoneAlerts: [MEDAL] },
    { id: 'half' },                                   // no config — an existing pass
  ]

  it('only includes passes that currently have an alert', () => {
    const out = resolveMilestoneAlertsByPass(passes, { '5k': 2500, '10k': 10, half: 99_999 })
    expect(Object.keys(out)).toEqual(['5k'])
    expect(out['5k'].message).toBe(TSHIRT.message)
  })

  it('passes are isolated — one pass crossing does not affect another', () => {
    const out = resolveMilestoneAlertsByPass(passes, { '5k': 2500, '10k': 5000 })
    expect(out['5k'].threshold).toBe(2000)
    expect(out['10k'].threshold).toBe(3000)
    expect(out.half).toBeUndefined()
  })

  it('a pass with no configuration never appears, at any count', () => {
    const out = resolveMilestoneAlertsByPass([{ id: 'half' }], { half: 1_000_000 })
    expect(out).toEqual({})
  })

  it('a missing count for a pass reads 0', () => {
    expect(resolveMilestoneAlertsByPass(passes, {})).toEqual({})
    expect(resolveMilestoneAlertsByPass(passes, { '10k': 3000 })['10k'].threshold).toBe(3000)
  })

  it('an unreadable counter yields no alerts at all', () => {
    expect(resolveMilestoneAlertsByPass(passes, null)).toEqual({})
    expect(resolveMilestoneAlertsByPass(passes, undefined)).toEqual({})
  })

  it('tolerates malformed pass entries without throwing', () => {
    const bad = [null, undefined, {}, { id: '' }, { id: 5 }, ...passes] as unknown[]
    let out: Record<string, unknown> = {}
    expect(() => {
      out = resolveMilestoneAlertsByPass(
        bad as { id: string; milestoneAlerts?: MilestoneAlert[] }[], { '5k': 2500 },
      )
    }).not.toThrow()
    expect(Object.keys(out)).toEqual(['5k'])
  })

  it('a non-array passes argument yields an empty record', () => {
    expect(resolveMilestoneAlertsByPass(
      null as unknown as { id: string }[], { '5k': 2500 },
    )).toEqual({})
  })
})
