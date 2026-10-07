// RD-CAPACITY-01 — capacity threshold notifications.
//
// ═══ WHAT COULD GO WRONG HERE ════════════════════════════════════════════════
// Three things, and each has its own section below:
//
//   1. SPAM — a burst of registrations crosses four thresholds at once and the organizer gets
//      four emails, or a repeated sweep re-sends the same one.
//   2. SILENCE — an organizer buys more capacity, and because the high-water mark was never
//      reset they are never warned again as the new capacity fills. This is the worse failure:
//      spam is annoying, silence means registrations start being refused unannounced.
//   3. SENDING FROM THE WRONG PLACE — a message dispatched inside the transaction that
//      guards against overselling.
//
// The decision function is pure and takes the stored state as an argument, so all of (1) and
// (2) are testable exactly, with no database and no clock.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CAPACITY_THRESHOLDS, CAPACITY_ALERT_FIELD,
  decideCapacityAlert, readAlertState, utilisationPercent, capacityAlertCopy,
} from '@/lib/licensing/capacityThresholds'
import { NotificationType, NOTIFICATION_META } from '@/lib/notifications/catalog'
import { EMAIL_DISPATCHERS } from '@/lib/notifications/dispatchers'
import { renderCapacityThresholdEmail } from '@/lib/notifications/templates/organizer'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

/** Decide, with the state a previous run would have persisted. */
const decide = (count: number, capacity: number | null, storedState: unknown = undefined) =>
  decideCapacityAlert({ count, capacity, storedState })

// ═══ 1 · the thresholds themselves ════════════════════════════════════════════

describe('the thresholds', () => {
  it('are exactly 50, 70, 85, 95 and 100, ascending', () => {
    expect([...CAPACITY_THRESHOLDS]).toEqual([50, 70, 85, 95, 100])
  })

  it('fire at the boundary, not one registration late', () => {
    // 50 of 100 IS 50% — an organizer told at 51% was told late.
    expect(decide(50, 100).threshold).toBe(50)
    expect(decide(49, 100).threshold).toBe(null)
    expect(decide(100, 100).threshold).toBe(100)
  })

  it('measure utilisation as a true percentage', () => {
    expect(utilisationPercent(437, 1_000)).toBeCloseTo(43.7)
    expect(utilisationPercent(0, 500)).toBe(0)
    // No capacity to measure against, and nonsense inputs, are 0 rather than NaN/Infinity —
    // a NaN percentage compares false against every threshold and would silently never fire.
    expect(utilisationPercent(10, null)).toBe(0)
    expect(utilisationPercent(10, 0)).toBe(0)
    expect(utilisationPercent(Number.NaN, 100)).toBe(0)
    expect(utilisationPercent(-5, 100)).toBe(0)
  })
})

// ═══ 2 · no spam ══════════════════════════════════════════════════════════════

describe('a burst produces ONE message', () => {
  it('announces only the HIGHEST threshold crossed, not every one', () => {
    // A bulk import takes an event from 45% to 97% between two sweeps. That crosses 50, 70,
    // 85 and 95 — four emails for one import would be indefensible, and the most urgent one
    // is the only one worth sending.
    const d = decide(970, 1_000)
    expect(d.threshold).toBe(95)
    expect(d.nextState.lastNotified).toBe(95)
  })

  it('jumping straight past everything to full announces 100 only', () => {
    expect(decide(1_000, 1_000).threshold).toBe(100)
  })

  it('is idempotent — re-running with the persisted state sends nothing', () => {
    const first = decide(700, 1_000)
    expect(first.threshold).toBe(70)
    // The state the first run persisted, fed back in.
    expect(decide(700, 1_000, first.nextState).threshold).toBe(null)
    expect(decide(749, 1_000, first.nextState).threshold).toBe(null)
  })

  it('advances one threshold at a time as the event fills gradually', () => {
    let state: unknown = undefined
    const fired: (number | null)[] = []
    for (const count of [400, 500, 600, 700, 800, 850, 900, 950, 990, 1_000]) {
      const d = decide(count, 1_000, state)
      state = d.nextState
      if (d.threshold !== null) fired.push(d.threshold)
    }
    expect(fired).toEqual([50, 70, 85, 95, 100])
  })

  it('never fires for an uncapped event', () => {
    expect(decide(1_000_000, null).threshold).toBe(null)
    expect(decide(1_000_000, 0).threshold).toBe(null)
  })

  it('never goes backwards when registrations are cancelled', () => {
    const at95 = decide(950, 1_000)
    // Refunds drop the count back to 60%. The organizer has already been told about 50/70/85
    // /95; re-announcing a lower one as the count recovers would be noise.
    expect(decide(600, 1_000, at95.nextState).threshold).toBe(null)
    expect(decide(999, 1_000, at95.nextState).threshold).toBe(null)
    expect(decide(1_000, 1_000, at95.nextState).threshold).toBe(100)
  })
})

// ═══ 3 · no silence after a capacity increase ═════════════════════════════════

describe('a capacity change re-arms the warnings', () => {
  it('an increase makes the lower thresholds eligible again', () => {
    // The event filled 500/500 and was told "capacity reached". The organizer then bought
    // 500 more. It is now 50% of 1,000 and MUST be warnable again — otherwise it silently
    // fills to 1,000 and starts refusing registrations with no warning at all.
    const full = decide(500, 500)
    expect(full.threshold).toBe(100)

    const afterIncrease = decide(500, 1_000, full.nextState)
    expect(afterIncrease.reset).toBe(true)
    expect(afterIncrease.threshold).toBe(50)
    expect(afterIncrease.nextState.capacity).toBe(1_000)
  })

  it('a DECREASE also re-stamps the state against the new capacity', () => {
    const at50 = decide(500, 1_000)
    expect(at50.threshold).toBe(50)
    // Capacity cut to 600 → the same 500 registrations are now 83%.
    const afterDecrease = decide(500, 600, at50.nextState)
    expect(afterDecrease.reset).toBe(true)
    expect(afterDecrease.threshold).toBe(70)
    expect(afterDecrease.nextState.capacity).toBe(600)
  })

  it('records the new capacity even when there is nothing to announce', () => {
    // This is what makes the re-arm durable: the stamp is persisted on the capacity change
    // itself, so a crash before the next threshold does not lose it.
    const d = decide(10, 1_000, { lastNotified: 100, capacity: 500 })
    expect(d.reset).toBe(true)
    expect(d.threshold).toBe(null)
    expect(d.nextState).toEqual({ lastNotified: 0, capacity: 1_000 })
  })

  it('an unchanged capacity is NOT a reset', () => {
    const d = decide(700, 1_000, { lastNotified: 70, capacity: 1_000 })
    expect(d.reset).toBe(false)
    expect(d.threshold).toBe(null)
  })
})

// ═══ 4 · stored state is read defensively ═════════════════════════════════════

describe('stored state', () => {
  it('treats anything unrecognisable as "nothing has been sent"', () => {
    for (const junk of [undefined, null, 'x', 42, [], { lastNotified: 'a' }, { capacity: Number.NaN }]) {
      const s = readAlertState(junk)
      expect(Number.isFinite(s.lastNotified)).toBe(true)
      expect(Number.isFinite(s.capacity)).toBe(true)
    }
    expect(readAlertState(null)).toEqual({ lastNotified: 0, capacity: 0 })
  })

  it('a corrupt state errs towards sending, never towards silence', () => {
    // An unreadable high-water mark must not be treated as "already told them everything".
    expect(decide(950, 1_000, 'garbage').threshold).toBe(95)
  })
})

// ═══ 5 · the message ══════════════════════════════════════════════════════════

describe('the copy', () => {
  it('asks for an action only at 100%, where registrations are actually being refused', () => {
    const full = capacityAlertCopy(100, 500)
    expect(full.subject).toContain('capacity has been reached')
    expect(full.body).toContain('Increase your capacity to continue accepting registrations')

    const partial = capacityAlertCopy(85, 500)
    expect(partial.subject).toContain('85% full')
    expect(partial.body).not.toContain('no longer being accepted')
  })

  it('renders an email that states the counts, not just a percentage', () => {
    const { subject, html } = renderCapacityThresholdEmail({
      to: 'o@example.com', organizerName: 'Asha', eventName: 'Puliyampatti Half Marathon',
      eventSlug: 'phm-2026', threshold: 85, capacity: 1_000, registrations: 850,
    })
    expect(subject).toContain('85% full')
    expect(html).toContain('850')
    expect(html).toContain('1,000')
    expect(html).toContain('Asha')
  })

  it('escapes the event name, which the organizer typed', () => {
    const { html } = renderCapacityThresholdEmail({
      to: 'o@example.com', organizerName: '<script>x()</script>', eventName: '</td><script>y()</script>',
      eventSlug: 's', threshold: 100, capacity: 10, registrations: 10,
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('says registrations are refused at 100%', () => {
    const { html, subject } = renderCapacityThresholdEmail({
      to: 'o@example.com', organizerName: 'Asha', eventName: 'Run', eventSlug: 's',
      threshold: 100, capacity: 500, registrations: 500,
    })
    expect(subject).toContain('capacity reached')
    expect(html).toContain('no longer being accepted')
  })
})

// ═══ 6 · registered like every other notification ════════════════════════════

describe('the notification is a first-class catalog entry', () => {
  it('exists, is an email, and has a dispatcher', () => {
    expect(NotificationType.CAPACITY_THRESHOLD).toBe('CAPACITY_THRESHOLD')
    expect(NOTIFICATION_META.CAPACITY_THRESHOLD.channel).toBe('email')
    expect(typeof EMAIL_DISPATCHERS.CAPACITY_THRESHOLD).toBe('function')
  })

  it('reuses the existing provider surface — no new provider method', () => {
    const src = code('lib/notifications/dispatchers.ts')
    expect(src).toContain('CAPACITY_THRESHOLD:        (p, x) => p.sendCustomEmail(renderCapacityThresholdEmail(x))')
    for (const f of ['lib/email/provider.ts', 'lib/email/ses.ts']) {
      expect(code(f), `${f} was modified for this notification`).not.toContain('CapacityThreshold')
    }
  })

  it('is in the Communication Registry, as an organizer-facing platform message', () => {
    const src = code('lib/communications/registry/catalog.ts')
    expect(src).toContain('T.CAPACITY_THRESHOLD')
    expect(src).toContain("futureRuleKey: 'platform.capacity_threshold'")
  })

  it('has a WhatsApp template registered, honestly marked unverified', () => {
    const src = code('lib/whatsapp/registry.ts')
    expect(src).toContain('CAPACITY_THRESHOLD: {')
    expect(src).toContain("templateName:      'organizer_capacity_threshold'")
    // Unverified means Meta has not approved it, so a real send self-skips and the EMAIL
    // still goes out. Claiming 'approved' here would be claiming a channel that does not work.
    const entry = src.slice(src.indexOf('CAPACITY_THRESHOLD: {'))
    expect(entry.slice(0, 400)).toContain("metaStatus:        'unverified'")
  })
})

// ═══ 7 · the sweep sends from the right place ════════════════════════════════

describe('the sweep', () => {
  const src = code('lib/licensing/capacityAlertSweep.ts')

  it('does NOT send inside a transaction', () => {
    const txn = src.slice(src.indexOf('runTransaction'), src.indexOf('async function dispatch'))
    expect(txn).not.toContain('notificationEngine')
    expect(txn).not.toContain('sendOrganizerWhatsApp')
  })

  it('claims the threshold in a transaction that RE-DECIDES from stored state', () => {
    // Two overlapping cron runs must not both claim the same threshold. Re-deciding inside
    // the transaction — rather than trusting the caller's earlier read — is what prevents it.
    const txn = src.slice(src.indexOf('runTransaction'))
    expect(txn).toContain('await txn.get(evRef)')
    expect(txn).toContain('decideCapacityAlert({')
    expect(txn).toContain(`storedState: ev[CAPACITY_ALERT_FIELD]`)
  })

  it('leaves the registration counter transaction completely alone', () => {
    // The counter transaction is what prevents overselling. It is not touched, and this
    // module only READS the counter.
    expect(src).toContain("collection('registrationCounters')")
    expect(src).not.toContain('FieldValue.increment')
    for (const f of ['lib/firebase/firestore/registrations.ts', 'lib/registrations/gate.ts']) {
      expect(code(f), `${f} was pulled into threshold notification`).not.toContain('capacityThresholds')
      expect(code(f)).not.toContain('CAPACITY_ALERT_FIELD')
    }
  })

  it('is bounded by a count AND a time budget', () => {
    expect(src).toContain('limit = 200')
    expect(src).toContain('budgetMs = 45_000')
    expect(src).toContain('Date.now() - startedAt > budgetMs')
  })

  it('skips uncapped events before spending a counter read', () => {
    expect(src).toContain('if (capacity === null || capacity <= 0) { out.skipped++; continue }')
  })

  it('a failed message does not stop the sweep', () => {
    expect(src).toContain('out.failed++')
    expect(src).toContain('console.error')
  })
})

describe('the cron route', () => {
  const src = code('app/api/cron/capacity-alerts/route.ts')

  it('is fail-closed on authorization, like every other cron route', () => {
    expect(src).toContain('if (!isAuthorizedCron(req)) return cronUnauthorized()')
  })

  it('records its execution and stays inside maxDuration', () => {
    expect(src).toContain("recordCronExecution('capacity-alerts'")
    expect(src).toContain('export const maxDuration = 60')
    expect(src).toContain('sweepCapacityAlerts(200, 45_000)')
  })

  it('is scheduled by exactly ONE scheduler', () => {
    // This repo runs two schedulers, and a route registered in both would double-run.
    const wf = read('.github/workflows/cron-recovery.yml')
    expect((wf.match(/api\/cron\/capacity-alerts/g) ?? [])).toHaveLength(1)
  })
})

// ═══ 8 · the capacity change clears the high-water mark ══════════════════════

describe('buying capacity re-arms the alerts immediately', () => {
  const src = code('lib/licensing/capacityChange.ts')

  it('clears the alert state in the SAME write as the new capacity', () => {
    // Atomic with the capacity, so a crash between the two is impossible.
    expect(src).toContain('[CAPACITY_ALERT_FIELD]: FieldValue.delete()')
    // Both the paid path and the free path.
    expect((src.match(/\[CAPACITY_ALERT_FIELD\]: FieldValue\.delete\(\)/g) ?? [])).toHaveLength(2)
  })

  it('uses the same field name the sweep reads', () => {
    expect(CAPACITY_ALERT_FIELD).toBe('capacityAlert')
    expect(src).toContain("from './capacityThresholds'")
  })
})
