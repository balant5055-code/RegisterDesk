// RD-DASH-06 · Communication usage — the metrics, their scope, and the four states.
//
// ═══ THE AUDIT THIS SUITE ENCODES ════════════════════════════════════════════
// The card reported six numbers. Five were wrong, each in a different way, and every
// describe() block below pins the fix for one of them:
//
//   "Emails sent"      counted REGISTRATIONS whose `emailStatus` said 'sent' — one per
//                      registration, confirmation mail only. Not a count of emails, and
//                      blind to reminders, broadcasts and WhatsApp entirely.
//   "Delivered today"  counted status in [sent, delivered]. `sent` means a provider
//                      ACCEPTED it, which is not delivery. Its index was also missing, so
//                      the query threw and the failure was swallowed into 0.
//   "Failed today"     same missing index, same swallowed 0.
//   "Campaigns"        count() and sum('successCount') shared one aggregate. An
//                      aggregation index must carry the summed field; it was never
//                      declared, so the missing index for "reached" zeroed the COUNT too.
//   "WhatsApp"         was the literal 0 — never queried at all.
//
// The derivation rules are exercised through the PURE resolver; the rendering rules are
// asserted at source level. Nothing here encodes a real workspace, event or total.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  resolveCommunicationUsage,
  ACCOUNTED_CHANNELS,
  type RawCommunicationCounts,
} from '@/lib/dashboard/communicationUsage'

const src = (p: string) => readFileSync(p, 'utf8')
/** Comments carry the audit's prose, including the words the code must not USE. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const USAGE  = src('lib/dashboard/communicationUsage.ts')
            + src('lib/dashboard/communicationUsageAdmin.ts')
const PANEL  = src('components/dashboard/CommunicationPanel.tsx')
const ROUTE  = src('app/api/organizer/dashboard/route.ts')
const PAGE   = src('app/(dashboard)/dashboard/page.tsx')
const TOKENS = src('styles/tokens.css')
const INDEXES = JSON.parse(src('firestore.indexes.json')) as {
  indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[]
}

/** Every figure measured. Each test perturbs only what it is about. */
const raw = (over: Partial<RawCommunicationCounts> = {}): RawCommunicationCounts => ({
  loggedTotal: 900, whatsapp: 600, delivered: 120, accepted: 700, failed: 80,
  campaigns: 7, reached: 640, ...over,
})

// ═══ 1 · a failed read is never a zero ═══════════════════════════════════════

describe('an unread figure stays unread', () => {
  it('every count is nullable, and null survives the resolver', () => {
    const u = resolveCommunicationUsage(raw({
      loggedTotal: null, whatsapp: null, delivered: null,
      accepted: null, failed: null, campaigns: null, reached: null,
    }))
    expect(u.loggedTotal).toBeNull()
    expect(u.delivered).toBeNull()
    expect(u.accepted).toBeNull()
    expect(u.failed).toBeNull()
    expect(u.campaigns).toBeNull()
    expect(u.reached).toBeNull()
    // The crucial distinction: not zero, anywhere.
    for (const v of [u.loggedTotal, u.delivered, u.accepted, u.failed, u.campaigns, u.reached]) {
      expect(v).not.toBe(0)
    }
  })

  it('a measured zero is preserved as a zero', () => {
    // The mirror of the rule above, and just as important: a genuinely quiet workspace
    // must not be told its counters are broken.
    const u = resolveCommunicationUsage(raw({ loggedTotal: 0, whatsapp: 0, delivered: 0, accepted: 0, failed: 0, campaigns: 0 }))
    expect(u.loggedTotal).toBe(0)
    expect(u.failed).toBe(0)
    expect(u.campaigns).toBe(0)
    expect(u.unavailable).toBe(false)
  })

  it('the reader resolves a failed aggregate to null rather than throwing or defaulting', () => {
    const code = strip(USAGE)
    expect(code).toContain('catch { return null }')
    // The exact line that produced four false zeros. It must not come back.
    expect(code).not.toMatch(/\?\?\s*0/)
  })

  it('the route no longer defaults any communication figure to zero', () => {
    const i = ROUTE.indexOf('const communications = {')
    const block = ROUTE.slice(i, ROUTE.indexOf('}', ROUTE.indexOf('costPaise', i)))
    expect(block).not.toMatch(/\?\?\s*0/)
    expect(block).toContain('...commUsage')
  })

  it('every figure failing is ONE stated failure, not six zeros', () => {
    const u = resolveCommunicationUsage(raw({
      loggedTotal: null, whatsapp: null, delivered: null, accepted: null, failed: null, campaigns: null, reached: null,
    }))
    expect(u.unavailable).toBe(true)
    expect(PANEL).toContain('usage.unavailable ?')
    expect(PANEL).toContain('role="alert"')
    expect(PANEL).toContain('nothing here is shown as zero')
  })

  it('one readable figure is enough to keep the card rendering', () => {
    // Partial failure must degrade per-figure, not blank the whole panel.
    const u = resolveCommunicationUsage(raw({
      loggedTotal: null, whatsapp: null, delivered: null, accepted: null, failed: null, campaigns: 3, reached: null,
    }))
    expect(u.unavailable).toBe(false)
    expect(u.campaigns).toBe(3)
  })
})

// ═══ 2 · the email figure, and what it is derived from ═══════════════════════

describe('email is derived by subtraction, because the channel field is sparse', () => {
  it('email = logged total minus whatsapp', () => {
    const u = resolveCommunicationUsage(raw({ loggedTotal: 900, whatsapp: 600 }))
    expect(u.channels.find(c => c.id === 'email')?.count).toBe(300)
  })

  it('a filter on channel == email is never used, because legacy rows have no channel', () => {
    // Every pre-existing email row predates the field, so an equality filter silently
    // misses them — on the audited workspace it found 1,457 of 4,707. Subtraction finds
    // all of them. This is the one assertion that stops the "obvious" query coming back.
    expect(strip(USAGE)).not.toMatch(/channel'?,\s*'==',\s*'email'/)
    expect(strip(USAGE)).toContain("where('channel', '==', 'whatsapp')")
  })

  it('the subtraction is only valid while exactly two channels are written', () => {
    // A third channel would land in `loggedTotal` but not in `whatsapp`, quietly inflating
    // the email figure by the new channel's entire volume. Adding one must break HERE.
    expect([...ACCOUNTED_CHANNELS].sort()).toEqual(['email', 'whatsapp'])
    const union = src('lib/email-logs/types.ts')
      .match(/export type CommunicationChannel\s*=\s*([^\n]+)/)?.[1] ?? ''
    const declared = [...union.matchAll(/'([a-z]+)'/g)].map(m => m[1]).sort()
    expect(declared).toEqual([...ACCOUNTED_CHANNELS].sort())
  })

  it('an unmeasured operand makes the difference unmeasured, not smaller', () => {
    for (const over of [{ loggedTotal: null }, { whatsapp: null }]) {
      const u = resolveCommunicationUsage(raw(over))
      expect(u.channels.find(c => c.id === 'email')?.count).toBeNull()
    }
  })

  it('a negative difference reports unmeasured rather than clamping to zero', () => {
    // Impossible unless a channel exists that the total does not cover — a data-model
    // change. Clamping would hide it behind a plausible small number.
    const u = resolveCommunicationUsage(raw({ loggedTotal: 10, whatsapp: 40 }))
    expect(u.channels.find(c => c.id === 'email')?.count).toBeNull()
  })
})

// ═══ 3 · a channel with no transport is not a quiet channel ══════════════════

describe('SMS reports availability, never a count', () => {
  it('carries no count and no share, even when everything else is measured', () => {
    const sms = resolveCommunicationUsage(raw()).channels.find(c => c.id === 'sms')
    expect(sms?.available).toBe(false)
    expect(sms?.count).toBeNull()
    expect(sms?.share).toBeNull()
    expect(sms?.count).not.toBe(0)
  })

  it('availability comes from the canonical capability gate, never a literal', () => {
    expect(strip(USAGE)).toContain("isChannelImplemented('sms')")
    expect(strip(USAGE)).toContain("from '@/lib/communications/health/channels'")
  })

  it('the gate still reports SMS as having no transport', () => {
    // If SMS ever ships, this test fails and the card starts counting it — which is the
    // correct outcome, and a deliberate prompt to revisit the copy.
    const ch = src('lib/communications/health/channels.ts')
    expect(ch).toMatch(/sms:\s*\{[^}]*implemented:\s*false/)
    expect(ch).toMatch(/whatsapp:\s*\{[^}]*implemented:\s*true/)
  })

  it('renders as "Not available" — a third state, distinct from zero and from unavailable', () => {
    expect(PANEL).toContain('>Not available</span>')
    expect(PANEL).toContain('>Unavailable</span>')
    expect(PANEL).toContain('not available on this workspace')
  })

  it('offers no configuration link, because there is nothing to configure', () => {
    // SMS has no transport at all — a "Configure SMS" action would lead nowhere. The card
    // links only to routes that already exist.
    const hrefs = [...PANEL.matchAll(/href[=:]\s*'([^']+)'/g)].map(m => m[1])
    for (const h of hrefs) expect(h).toBe('/dashboard/communications')
    expect(PANEL).not.toMatch(/sms[^\n]*href/i)
  })
})

// ═══ 4 · shares ══════════════════════════════════════════════════════════════

describe('channel shares divide the ONE logged total', () => {
  it('every share is taken on loggedTotal', () => {
    const u = resolveCommunicationUsage(raw({ loggedTotal: 1000, whatsapp: 750 }))
    expect(u.channels.find(c => c.id === 'whatsapp')?.share).toBeCloseTo(75, 6)
    expect(u.channels.find(c => c.id === 'email')?.share).toBeCloseTo(25, 6)
  })

  it('the measured shares sum to 100', () => {
    const u = resolveCommunicationUsage(raw({ loggedTotal: 337, whatsapp: 211 }))
    const sum = u.channels.reduce((t, c) => t + (c.share ?? 0), 0)
    expect(sum).toBeCloseTo(100, 6)
  })

  it('claims no share at all when the denominator is zero or unmeasured', () => {
    for (const over of [{ loggedTotal: 0, whatsapp: 0 }, { loggedTotal: null }]) {
      for (const c of resolveCommunicationUsage(raw(over)).channels) expect(c.share).toBeNull()
    }
  })
})

// ═══ 5 · outcomes, and the rate that is deliberately absent ══════════════════

describe('delivery outcomes are counts, and no delivery RATE is computed', () => {
  it('the three outcomes are carried through untouched', () => {
    const u = resolveCommunicationUsage(raw({ delivered: 120, accepted: 700, failed: 80 }))
    expect([u.delivered, u.accepted, u.failed]).toEqual([120, 700, 80])
  })

  it('no percentage is derived from delivered', () => {
    // `delivered / logged` read ~15% on the audited workspace, which invites "85% failed" —
    // and that is false. Those messages were ACCEPTED; no receipt arrived, because receipts
    // exist only for providers that send them. Such a rate measures the webhook, not the
    // delivery. See the note in the component.
    const code = strip(PANEL)
    expect(code).not.toMatch(/delivered\s*\/\s*/)
    expect(code).not.toMatch(/deliveryRate|successRate|failureRate/)
    expect(PANEL).toContain('Deliberately NOT a delivery rate')
  })

  it('"sent" is worded as a missing receipt, not as a success or a failure', () => {
    expect(PANEL).toContain('note="no receipt"')
    expect(PANEL).toContain("Outcome tone=\"accepted\"")
    // Neutral tone: an unconfirmed message must not be painted as either outcome.
    expect(TOKENS).toMatch(/--comm-accepted-fill:\s*linear-gradient\(90deg, #64748B/)
  })

  it('a measured zero failure says which zero it is', () => {
    // "Failed 0" alone cannot be told from "failed: not measured".
    expect(PANEL).toContain("failed > 0 ? 'needs attention' : 'none recorded'")
    expect(PANEL).toContain("failed === null ? 'not measured'")
  })

  it('the failure tone is not applied to a zero', () => {
    // Zero failures must not render as an alarm. The tint is constant; only the NOTE
    // changes, so a clean card never looks like a broken one.
    // The alarm tone is spent ONLY on an actual failure. A zero-failure tile in critical
    // pink is a clean workspace wearing an error state, and a reader scans the colour before
    // the digit. A measured zero takes the same neutral ground the unconfirmed tile uses —
    // and so does an UNMEASURED figure, which is not a failure either.
    expect(PANEL).toContain("const failedTone: CommTone = failed !== null && failed > 0 ? 'failed' : 'accepted'")
    expect(PANEL).toContain('<Outcome tone={failedTone}')
    expect(PANEL).not.toContain('<Outcome tone="failed"')
  })
})

// ═══ 6 · campaigns ═══════════════════════════════════════════════════════════

describe('campaigns keep their existing backend definition', () => {
  it('counts campaigns whose status is sent or partial — unchanged', () => {
    expect(strip(USAGE)).toContain("const SENT_CAMPAIGNS = ['sent', 'partial'] as const")
    expect(strip(USAGE)).toContain("camps().where('status', 'in', SENT_CAMPAIGNS)")
  })

  it('the COUNT and the SUM are separate reads', () => {
    // They shared one aggregate. An aggregation index must carry the summed field, that
    // index was never declared, and so a missing "recipients reached" reported the campaign
    // count as 0 to an organizer who had sent fifty.
    const code = strip(USAGE)
    expect(code).not.toMatch(/aggregate\(\{\s*campaigns:.*reached:/s)
    expect(code).toMatch(/aggregate\(\{\s*reached:\s*AggregateField\.sum\('successCount'\)\s*\}\)/)
  })

  it('recipients reached is omitted when unmeasured, never printed as zero', () => {
    expect(PANEL).toContain('{reached !== null && (')
    const u = resolveCommunicationUsage(raw({ reached: null }))
    expect(u.reached).toBeNull()
  })

  it('the aggregation index carries the SUMMED field, in both scopes', () => {
    const shapes = INDEXES.indexes
      .filter(i => i.collectionGroup === 'broadcastCampaigns')
      .map(i => i.fields.map(f => f.fieldPath).join(','))
    expect(shapes).toContain('organizerUid,status,successCount')
    expect(shapes).toContain('organizerUid,eventSlug,status,successCount')
  })
})

// ═══ 7 · scope and window ════════════════════════════════════════════════════

describe('scope and time window are stated, not assumed', () => {
  it('every query narrows to the selected event when there is one', () => {
    const code = strip(USAGE)
    expect(code).toContain("slug ? q.where('eventSlug', '==', slug) : q")
    // Both collections, so a scoped card cannot mix one event's logs with every campaign.
    expect((code.match(/slug \? q\.where\('eventSlug', '==', slug\) : q/g) ?? []).length).toBe(2)
  })

  it('the route passes the SELECTED slug, so the card follows the Event Selector', () => {
    expect(ROUTE).toContain('readCommunicationUsage(uid, { scoped, slug: selectedSlug })')
    // Scope travels as an INTENTION, not as a slug that might be missing: an event can be
    // selected while still unpublished, and an unpublished event has no slug. A bare null
    // there would drop every filter and read the whole workspace under that event's name.
    expect(USAGE).toContain('if (scoped && !slug) {')
  })

  it('the card no longer claims to be workspace-level', () => {
    // It carried a "All events" scope pill and a comment saying the index for scoping did
    // not exist. Both were stale: the queries are event-scoped and verified.
    expect(PAGE).not.toContain("wsNote('communications')")
    expect(PAGE).toContain('scopeLabel={scoped && scopeName ? scopeName : \'all events\'}')
  })

  it('ONE window covers the whole card, and it is named', () => {
    // The card mixed two "today" figures with an all-time total and marked neither.
    // Stated ONCE, on the line under the primary figure rather than in the header — a
    // subtitle there grew this card's header past its neighbours' and truncated the
    // event name at 1280 and below. Both measured in the browser.
    expect(PANEL).toContain('{scopeLabel} · all time')
    expect(PANEL).not.toContain('subtitle=')
    expect(strip(USAGE)).not.toMatch(/todayStart|createdAt/)
    // strip(): this file's header comment quotes the old labels it replaced, which is the
    // record of the audit. What must be gone is a today-window in the CODE.
    expect(strip(PANEL)).not.toMatch(/\btoday\b/i)
  })

  it('the registrations-derived "emails sent" read is gone', () => {
    // It counted registrations, not emails: `registrations.where('emailStatus','==','sent')`.
    expect(ROUTE).not.toMatch(/emailStatus'?,\s*'=='/)
    expect(ROUTE).not.toContain('emailsSentAgg')
  })

  it('the two broken today-window email aggregates are gone', () => {
    expect(ROUTE).not.toContain('emailsSentTodayAgg')
    expect(ROUTE).not.toContain('emailsFailedTodayAgg')
  })
})

// ═══ 8 · labels name what was counted ════════════════════════════════════════

describe('nothing is labelled as something it does not count', () => {
  it('the all-channel total is not called an email figure', () => {
    // `emailLogs` holds every channel; the collection name is historical. Calling a count
    // over it "emails sent" is the original defect.
    expect(PANEL).toContain('messages logged across all channels')
    expect(strip(PANEL)).not.toMatch(/Emails sent|emailsSent/)
    expect(strip(PAGE)).not.toMatch(/Emails sent|emailsSent/)
  })

  it('provider acceptance is never labelled delivery', () => {
    expect(PANEL).toContain('note="by provider"')
    expect(strip(USAGE)).toContain("where('status', '==', 'delivered')")
    // 'sent' and 'delivered' are read as separate statuses, never unioned under one label.
    expect(strip(USAGE)).not.toMatch(/'status',\s*'in',\s*\['sent',\s*'delivered'\]/)
  })

  it('every channel is named by the resolver, not by the component', () => {
    expect(PANEL).toContain('{channels.map(c => <ChannelRow key={c.id} channel={c} />)}')
    expect(PANEL).not.toMatch(/label="WhatsApp"|label="Email"|label="SMS"/)
  })
})

// ═══ 9 · accessibility ═══════════════════════════════════════════════════════

describe('every figure is text, and no meaning rests on colour', () => {
  it('a channel row speaks its whole sentence', () => {
    expect(PANEL).toContain('role="group"')
    expect(PANEL).toContain('aria-label={spoken}')
    expect(PANEL).toContain('${label}: ${n(count)} messages')
    expect(PANEL).toContain('${share.toFixed(1)} percent')
  })

  it('each of the three channel states has its own spoken form', () => {
    expect(PANEL).toContain('not available on this workspace')
    expect(PANEL).toContain('usage could not be loaded')
  })

  it('an outcome tile speaks its value and what the value means', () => {
    expect(PANEL).toContain('aria-label={value === null ? `${label}: unavailable` : `${label}: ${n(value)} — ${note}`}')
  })

  it('the segmented bar is decorative — every segment is written out beneath it', () => {
    expect(PANEL).toMatch(/style=\{\{ background: TRACK \}\} aria-hidden/)
    expect(PANEL).toContain('<ChannelBar channels={channels} total={loggedTotal} />')
  })

  it('the glyphs carry no unique meaning', () => {
    expect(PANEL).toMatch(/<Send className="size-3.5" \/>/)
    expect(PANEL).toMatch(/rounded-control', accent\('people'\)\.tile\)} aria-hidden/)
  })
})

// ═══ 10 · design system ══════════════════════════════════════════════════════

describe('the card belongs to the dashboard design system', () => {
  it('carries no inline colour — every value is a token', () => {
    expect(PANEL).not.toMatch(/#[0-9A-Fa-f]{6}/)
    for (const t of ['whatsapp', 'email', 'sms', 'campaign', 'delivered', 'accepted', 'failed']) {
      expect(TOKENS).toContain('--comm-' + t + '-fill:')
      expect((TOKENS.match(new RegExp('--comm-' + t + '-fill:', 'g')) ?? []).length).toBe(2) // light + dark
      expect((TOKENS.match(new RegExp('--comm-' + t + '-tint:', 'g')) ?? []).length).toBe(2)
      expect((TOKENS.match(new RegExp('--comm-' + t + '-ink:', 'g')) ?? []).length).toBe(2)
    }
    for (const kind of ['fill', 'tint', 'ink']) {
      expect(PANEL).toContain('var(--comm-${t}-' + kind + ')')
    }
  })

  it('WhatsApp keeps its conventional green and the brand gradient is spent on campaigns', () => {
    // Recolouring WhatsApp to match the brand would cost recognition and buy nothing.
    expect(TOKENS).toMatch(/--comm-whatsapp-fill:\s*linear-gradient\(90deg, #059669/)
    // 2026-09-29 owner decision: the product theme left magenta for the logo's indigo;
    // campaigns wear the brand violet, no longer violet → pink.
    expect(TOKENS).toMatch(/--comm-campaign-fill:\s*linear-gradient\(90deg, #7C3AED 0%, #A855F7/)
    // Delivered is teal, not a second green — a reader must not have to work out whether
    // green means WhatsApp or means delivered.
    expect(TOKENS).toMatch(/--comm-delivered-fill:\s*linear-gradient\(90deg, #0D9488/)
  })

  it('fills its grid track and pushes its footer to the bottom, with no fixed height', () => {
    expect(PANEL).toContain('className="h-full"')
    expect(PANEL).toContain('bodyClassName="flex flex-col"')
    expect(PANEL).toContain('flex flex-1 flex-col')
    expect(PANEL).toContain('mt-auto')
    expect(PANEL).not.toMatch(/(^|[^-])\bh-\[\d+px\]/)
  })

  it('brings no glow, shadow or blur', () => {
    expect(PANEL).not.toMatch(/shadow-|drop-shadow|blur-/)
  })

  it('reuses the existing card shell rather than a new one', () => {
    expect(PANEL).toContain("from '@/components/dashboard/SectionCard'")
  })
})

// ═══ 11 · safety ═════════════════════════════════════════════════════════════

describe('this card reads, and does nothing else', () => {
  const all = [USAGE, PANEL]

  it('performs no Firestore write', () => {
    for (const code of all) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bbatch\(\)|FieldValue/)
    }
  })

  it('carries no payment, refund, wallet or pricing logic', () => {
    for (const code of all) {
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      for (const forbidden of [
        /gatewayFee/, /platformFee/, /netSettlement/, /refundAmount/,
        /walletBalance/, /organizerPayable/, /\bpricing\b/i,
      ]) expect(code).not.toMatch(forbidden)
    }
  })

  it('the resolver is PURE — no I/O, no clock', () => {
    const body = USAGE.slice(USAGE.indexOf('export function resolveCommunicationUsage'))
      .slice(0, USAGE.slice(USAGE.indexOf('export function resolveCommunicationUsage')).indexOf('\n}'))
    expect(body).not.toMatch(/adminDb|await|fetch\(|Date\./)
  })

  it('hardcodes no workspace, event or total', () => {
    for (const code of [strip(USAGE), strip(PANEL)]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/15,?179|15,?072|10,?4\d\d|2,?328/)
    }
  })

  it('the billing figure stays out of the counts', () => {
    // Communication spend is a separate wallet and a separate concern. It travels beside
    // the usage object, never inside it.
    expect(USAGE).not.toContain('costPaise')
    expect(ROUTE).toMatch(/communications = \{[\s\S]{0,400}costPaise/)
  })
})
