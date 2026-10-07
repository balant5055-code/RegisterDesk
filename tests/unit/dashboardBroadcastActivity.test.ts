// RD-DASH-09 · Recent broadcasts — the model, the scope, and the words the card may use.
//
// ═══ THE AUDIT THIS SUITE ENCODES ════════════════════════════════════════════
// The dashboard knew exactly one thing about broadcasts: "Campaigns sent 8 · 6,678 reached".
// The campaigns themselves — name, channel, audience size, outcome, when — were all on the
// documents and none of it reached the organizer.
//
// Two findings shape everything below:
//
//   1. `successCount` IS NOT DELIVERED. Traced finalizeBroadcast → the job kernel, whose
//      contract states it: "succeeded — the provider was called and accepted. Nothing else."
//      The platform's own word is SENT. This card must never say delivered.
//   2. `createdAt` IS NOT THE SEND TIME. On the audited workspace the createdAt-desc and
//      sentAt-desc orderings differ at position ONE, and the largest gap between the two
//      instants is 7.8 hours. Ordering by creation would head the list with the wrong
//      broadcast.
//
// The shaping and ordering rules are exercised through the PURE module; the query and
// rendering rules are asserted at source level. Nothing here encodes a real campaign.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  toBroadcastRow, rankBroadcasts, resolveInstant, TIME_KIND_LABEL,
  BROADCAST_ROWS_SHOWN, EMPTY_BROADCAST_ACTIVITY,
  type RawBroadcast,
} from '@/lib/dashboard/broadcastActivity'
import { BROADCAST_STATUS_LABELS } from '@/lib/broadcasts/types'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments carry the audit's prose, including the words the CODE must not use. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PURE     = read('lib/dashboard/broadcastActivity.ts')
const ADMIN    = read('lib/dashboard/broadcastActivityAdmin.ts')
const PANEL    = read('components/dashboard/BroadcastPanel.tsx')
const ROUTE    = read('app/api/organizer/dashboard/route.ts')
const PAGE     = read('app/(dashboard)/dashboard/page.tsx')
const TYPES    = read('lib/broadcasts/types.ts')
const FINALIZE = read('lib/broadcasts/finalize.ts')
const TOKENS   = read('styles/tokens.css')
const SECTIONS = read('lib/dashboard/sections.ts')
const INDEXES  = JSON.parse(read('firestore.indexes.json')) as {
  indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[]
}

/** A complete campaign. Each test perturbs only its own subject. */
const raw = (over: Partial<RawBroadcast> = {}): RawBroadcast => ({
  id: 'c1', subject: 'Some Broadcast', channel: 'whatsapp', status: 'sent',
  recipientCount: 100, successCount: 100, failCount: 0,
  sentAt: '2026-08-21T14:12:00.000Z', scheduledFor: null, createdAt: '2026-08-21T14:11:00.000Z',
  eventName: 'Some Event', eventSlug: 'some-event', ...over,
})

// ═══ 1 · successCount is never "delivered" ═══════════════════════════════════

describe('the card refuses the word "delivered"', () => {
  it('the field is carried as `sent`, matching the platform', () => {
    expect(toBroadcastRow(raw({ successCount: 87 })).sent).toBe(87)
    // The product's own term: finalize reports it to the inbox as `sent`.
    expect(FINALIZE).toMatch(/sent:\s*successCount/)
    expect(BROADCAST_STATUS_LABELS.sent).toBe('Sent')
  })

  it('neither the module nor the card ever says delivered', () => {
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      expect(code).not.toMatch(/deliver/i)
    }
  })

  it('the kernel contract that settles it is still worded that way', () => {
    // If this ever changes to mean real delivery, this test fails and the wording is revisited
    // deliberately rather than drifting.
    expect(read('lib/certificates/emailJobs.ts'))
      .toContain('succeeded — the provider was called and accepted. Nothing else.')
  })

  it('"all sent" is claimed only when every recipient succeeded', () => {
    expect(PANEL).toContain('row.recipients > 0 && row.sent === row.recipients')
    expect(PANEL).toContain("? ['all sent']")
  })
})

// ═══ 2 · the timestamp ═══════════════════════════════════════════════════════

describe('a row shows the right instant, and names which one it is', () => {
  it('a sent campaign is described by its sentAt', () => {
    expect(resolveInstant(raw(), 'sent')).toEqual({ at: '2026-08-21T14:12:00.000Z', kind: 'sent' })
    expect(resolveInstant(raw(), 'partial').kind).toBe('sent')
  })

  it('a FAILED or CANCELLED campaign carries sentAt too — and it is not a send time', () => {
    // The field is written at TERMINATION, not only at success: the job's terminal path sets
    // it for failed and cancelled as well. Captioning a cancelled campaign "Sent 19 Aug" says
    // the opposite of what happened, so the same instant is named for what it is.
    expect(resolveInstant(raw(), 'cancelled').kind).toBe('ended')
    expect(resolveInstant(raw(), 'failed').kind).toBe('ended')
    expect(TIME_KIND_LABEL.ended).toBe('Ended')
    expect(toBroadcastRow(raw({ status: 'cancelled' })).atKind).toBe('ended')
    // …and the terminal-status list is derived from the writers, not guessed.
    const emailJob = read('lib/broadcasts/emailJob.ts')
    expect(emailJob).toContain("status:       status === 'cancelled' ? 'cancelled' : 'failed',")
    expect(emailJob).toContain('sentAt:       FieldValue.serverTimestamp(),')
  })

  it('a scheduled campaign falls back to its scheduled time, labelled as such', () => {
    const r = raw({ sentAt: null, scheduledFor: '2026-09-01T04:00:00.000Z', status: 'scheduled' })
    expect(resolveInstant(r)).toEqual({ at: '2026-09-01T04:00:00.000Z', kind: 'scheduled' })
    expect(TIME_KIND_LABEL.scheduled).toBe('Scheduled for')
    // A future instant must never be readable as a send time.
    expect(TIME_KIND_LABEL.sent).not.toBe(TIME_KIND_LABEL.scheduled)
  })

  it('a draft falls back to createdAt, labelled as created', () => {
    const r = raw({ sentAt: null, scheduledFor: null, status: 'draft' })
    expect(resolveInstant(r)).toEqual({ at: '2026-08-21T14:11:00.000Z', kind: 'created' })
  })

  it('no instant at all is reported honestly, never manufactured', () => {
    const r = raw({ sentAt: null, scheduledFor: null, createdAt: null })
    expect(resolveInstant(r)).toEqual({ at: null, kind: 'none' })
    expect(toBroadcastRow(r).at).toBeNull()
    expect(PANEL).toContain('No timestamp')
    // Nothing derives a fallback instant from the clock.
    expect(strip(PURE)).not.toMatch(/Date\.now|new Date\(\)/)
  })

  it('the card reuses the dashboard\'s ONE timestamp formatter', () => {
    // A second implementation would give this card a different idea of "today" from the
    // activity feed sitting above it.
    expect(PANEL).toContain("from '@/lib/dashboard/activityTime'")
    expect(PANEL).toContain('formatActivityInstant(row.at, now)')
    expect(PANEL).toContain('<time dateTime={when.iso}>')
  })

  it('one clock serves every row, established once', () => {
    expect(PANEL).toContain('const [now] = useState(() => Date.now())')
    // Not read inside the row, which would give each one a different "now".
    const rowBlock = PANEL.slice(PANEL.indexOf('function Row('), PANEL.indexOf('// ─── The card'))
    expect(rowBlock).not.toMatch(/Date\.now/)
  })
})

// ═══ 3 · ordering ════════════════════════════════════════════════════════════

describe('newest first, deterministically', () => {
  it('ranks by the instant each row is described by', () => {
    const rows = [
      toBroadcastRow(raw({ id: 'a', sentAt: '2026-08-01T00:00:00.000Z' })),
      toBroadcastRow(raw({ id: 'b', sentAt: '2026-08-03T00:00:00.000Z' })),
      toBroadcastRow(raw({ id: 'c', sentAt: '2026-08-02T00:00:00.000Z' })),
    ]
    expect(rankBroadcasts(rows).map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('a missing instant sorts LAST rather than unpredictably', () => {
    const rows = [
      toBroadcastRow(raw({ id: 'none', sentAt: null, scheduledFor: null, createdAt: null })),
      toBroadcastRow(raw({ id: 'has',  sentAt: '2026-08-01T00:00:00.000Z' })),
    ]
    expect(rankBroadcasts(rows).map(r => r.id)).toEqual(['has', 'none'])
  })

  it('an unparseable instant is treated as missing, never as NaN order', () => {
    const rows = [
      toBroadcastRow(raw({ id: 'bad', sentAt: 'not-a-date' })),
      toBroadcastRow(raw({ id: 'ok',  sentAt: '2026-08-01T00:00:00.000Z' })),
    ]
    expect(rankBroadcasts(rows).map(r => r.id)).toEqual(['ok', 'bad'])
  })

  it('ties break on the document id, so the same input always gives the same order', () => {
    const at = '2026-08-05T00:00:00.000Z'
    const rows = [toBroadcastRow(raw({ id: 'z', sentAt: at })), toBroadcastRow(raw({ id: 'a', sentAt: at }))]
    expect(rankBroadcasts(rows).map(r => r.id)).toEqual(['a', 'z'])
    expect(rankBroadcasts([...rows].reverse()).map(r => r.id)).toEqual(['a', 'z'])
  })

  it('the QUERY orders by sentAt, not createdAt', () => {
    // The two orderings differ at position one on real data, with gaps up to 7.8 hours.
    expect(ADMIN).toContain("orderBy('sentAt', 'desc')")
  })

  it('the createdAt fallback is DISCLOSED, never silent', () => {
    // The sentAt indexes are declared and not deployed. Falling back keeps the card working;
    // pretending the order is by send time would not.
    expect(ADMIN).toContain("orderBy('createdAt', 'desc')")
    expect(ADMIN).toContain('shape(await base().orderBy(\'createdAt\', \'desc\').limit(take).get(), true)')
    expect(PANEL).toContain("orderedByCreation ? 'Newest created first' : 'Newest sent first'")
  })

  it('the component never re-sorts — one ordering rule, in one place', () => {
    expect(strip(PANEL)).not.toMatch(/\.sort\(/)
    expect(ADMIN).toContain('rankBroadcasts(all)')
  })
})

// ═══ 4 · scope and ownership ═════════════════════════════════════════════════

describe('scope is enforced on the server, never on the client', () => {
  it('organizerUid is on every query', () => {
    expect(ADMIN).toContain("where('organizerUid', '==', uid)")
    // …and there is exactly one query builder, so a variant cannot forget it.
    expect((ADMIN.match(/collection\('broadcastCampaigns'\)/g) ?? []).length).toBe(1)
  })

  it('a selected event narrows the query itself', () => {
    expect(ADMIN).toContain("slug ? q.where('eventSlug', '==', slug) : q")
    expect(ROUTE).toContain('readBroadcastActivity(uid, { scoped, slug: selectedSlug })')
  })

  it('a scoped event with NO slug reads nothing rather than the workspace', () => {
    // An event can be selected while unpublished, and an unpublished event has no slug.
    // A campaign cannot exist without an eventSlug, so this is a proven empty.
    expect(ADMIN).toContain('if (scoped && !slug) {')
    const guard = ADMIN.indexOf('if (scoped && !slug)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(ADMIN.indexOf("collection('broadcastCampaigns')"))
  })

  it('nothing is filtered after the read', () => {
    // A client-side narrowing would mean another organizer's campaigns had already crossed
    // the wire.
    // (Both files do call `.filter(Boolean)` when assembling a spoken sentence — that is text
    // assembly, not scope, so the guard names the row collections instead.)
    expect(strip(PANEL)).not.toMatch(/\brows\b[^\n]*\.filter\(/)
    expect(strip(ADMIN)).not.toMatch(/\b(rows|ranked|all|docs)\b[^\n]*\.filter\(/)
    expect(strip(PANEL)).not.toMatch(/organizerUid/)
  })
})

// ═══ 5 · read cost ═══════════════════════════════════════════════════════════

describe('the read is bounded', () => {
  it('one query, limited to what the card shows plus one', () => {
    expect(BROADCAST_ROWS_SHOWN).toBe(5)
    expect(ADMIN).toContain('const take = BROADCAST_ROWS_SHOWN + 1')
    expect(ADMIN).toContain('.limit(take)')
    // Six documents to render five and know a sixth exists — never a count() of the whole set.
    expect(strip(ADMIN)).not.toMatch(/\.count\(\)|aggregate\(/)
  })

  it('hasMore comes from the extra row, not from a fabricated total', () => {
    expect(ADMIN).toContain('hasMore: ranked.length > BROADCAST_ROWS_SHOWN')
    expect(PANEL).toContain("{hasMore && ' · more available'}")
    // No exact remaining count is claimed anywhere.
    expect(strip(PANEL)).not.toMatch(/of \$\{.*\} broadcast/)
  })

  it('the indexes it needs are declared, in both scopes', () => {
    const shapes = INDEXES.indexes
      .filter(i => i.collectionGroup === 'broadcastCampaigns')
      .map(i => i.fields.map(f => f.fieldPath + ':' + (f.order ?? '')).join(','))
    expect(shapes).toContain('organizerUid:ASCENDING,sentAt:DESCENDING')
    expect(shapes).toContain('organizerUid:ASCENDING,eventSlug:ASCENDING,sentAt:DESCENDING')
    // …and the fallback path's event-scoped index too, or the fallback would fail as well.
    expect(shapes).toContain('organizerUid:ASCENDING,eventSlug:ASCENDING,createdAt:DESCENDING')
  })
})

// ═══ 6 · states ══════════════════════════════════════════════════════════════

describe('empty, unavailable and populated are all distinct', () => {
  it('a failed read is never an empty list', () => {
    expect(EMPTY_BROADCAST_ACTIVITY.unavailable).toBe(false)
    expect(ADMIN).toContain('unavailable: true')
    expect(PANEL).toContain('Broadcast activity unavailable')
    expect(PANEL).toContain('nothing here is shown as')
  })

  it('the empty state is an absence, and offers an EXISTING route', () => {
    expect(PANEL).toContain('No broadcasts yet')
    expect(PANEL).toContain("const BROADCASTS_HREF = '/dashboard/communications/broadcasts'")
    // That page really exists — the product's own name for this surface.
    expect(read('lib/navigation/breadcrumbs.ts'))
      .toContain("'/dashboard/communications/broadcasts':      'Broadcasts'")
  })

  it('every href on the card is that one route', () => {
    const hrefs = [...PANEL.matchAll(/href=\{?(['"])([^'"]+)\1/g)].map(m => m[2])
    for (const h of hrefs) expect(h).toBe('/dashboard/communications/broadcasts')
  })

  it('a zero-recipient campaign still renders, and claims nothing', () => {
    const r = toBroadcastRow(raw({ recipientCount: 0, successCount: 0, failCount: 0 }))
    expect(r.recipients).toBe(0)
    expect(r.sent).toBe(0)
    // "all sent" must not fire on an empty audience.
    expect(PANEL).toContain('row.recipients > 0 && row.sent === row.recipients')
  })

  it('a missing or malformed count degrades to zero, never NaN', () => {
    for (const over of [{ recipientCount: undefined }, { successCount: 'x' }, { failCount: -4 }]) {
      const r = toBroadcastRow(raw(over as Partial<RawBroadcast>))
      for (const v of [r.recipients, r.sent, r.failed]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('the shell still provides the loading state', () => {
    // SectionCard renders a skeleton, so the card never shows "0 broadcasts" while loading.
    expect(PANEL).toContain("from '@/components/dashboard/SectionCard'")
    expect(read('components/dashboard/SectionCard.tsx')).toContain('animate-pulse')
  })
})

// ═══ 7 · status and channel vocabularies ═════════════════════════════════════

describe('no status or channel wording is invented', () => {
  it('labels come from the model, not from the card', () => {
    expect(toBroadcastRow(raw({ status: 'partial' })).statusLabel).toBe(BROADCAST_STATUS_LABELS.partial)
    expect(PANEL).toContain('{row.statusLabel}')
    // The brief's example words are NOT in the model, so they must not appear.
    expect(strip(PANEL)).not.toMatch(/Completed|Partially sent|In progress/)
  })

  it('every one of the model\'s seven statuses has a tone', () => {
    for (const s of Object.keys(BROADCAST_STATUS_LABELS)) {
      expect(PANEL).toMatch(new RegExp('\\b' + s + ':'))
    }
  })

  it('an unrecognised status or channel falls back rather than throwing', () => {
    const r = toBroadcastRow(raw({ status: 'nonsense', channel: 'carrier-pigeon' }))
    expect(r.status).toBe('draft')
    expect(r.channel).toBe('email')
    expect(r.statusLabel).toBe(BROADCAST_STATUS_LABELS.draft)
  })

  it('the channel list comes from the model\'s own union', () => {
    expect(TYPES).toContain("export type BroadcastChannel = 'email' | 'sms' | 'whatsapp'")
    for (const c of ['email', 'sms', 'whatsapp']) expect(PANEL).toMatch(new RegExp(c + ':'))
  })

  it('outcome colour is a SEPARATE axis from channel colour', () => {
    // A WhatsApp campaign that failed must not read as green because WhatsApp is green.
    expect(PANEL).toContain('type StatusTone')
    expect(PANEL).toContain('var(--bcast-${t}-tint)')
    expect(PANEL).toContain('var(--comm-${c}-fill)')
  })

  it('channel colour is REUSED from RD-DASH-06, not redefined', () => {
    // One channel, one colour, on both communication cards.
    expect(TOKENS).not.toMatch(/--bcast-(whatsapp|email|sms)-/)
    for (const c of ['whatsapp', 'email', 'sms']) {
      expect((TOKENS.match(new RegExp('--comm-' + c + '-fill:', 'g')) ?? []).length).toBe(2)
    }
  })
})

// ═══ 8 · it does not duplicate Communication Usage ═══════════════════════════

describe('the two communication cards answer different questions', () => {
  it('this card carries no volume total, channel split or delivery breakdown', () => {
    for (const w of [/loggedTotal/, /channels/, /accepted/, /whatsapp:\s*CommCount/, /messages logged/]) {
      expect(strip(PANEL)).not.toMatch(w)
    }
  })

  it('the usage card gains nothing about individual campaigns', () => {
    const usage = read('components/dashboard/CommunicationPanel.tsx')
    expect(strip(usage)).not.toMatch(/subject|BroadcastRow|campaignName/)
    // Its one-line campaign summary stays exactly as RD-DASH-06 left it.
    expect(usage).toContain('Campaigns sent')
  })

  it('the split is stated so a later phase does not re-merge them', () => {
    expect(ROUTE).toContain('that field answers HOW MUCH was sent')
    expect(PANEL).toContain('This card answers the other question')
  })

  it('it is its own toggleable section, beside the usage card', () => {
    expect(SECTIONS).toContain("{ id: 'broadcasts',     label: 'Recent broadcasts' },")
    expect(SECTIONS).toContain("| 'broadcasts'")
    expect(PAGE).toContain('{visible.broadcasts && (')
    expect(PAGE).toContain('Number(visible.communications) + Number(visible.broadcasts)')
  })
})

// ═══ 9 · accessibility ═══════════════════════════════════════════════════════

describe('every fact is text, and none of it rests on colour', () => {
  it('a row speaks its whole sentence, and only facts that exist', () => {
    expect(PANEL).toContain('role="group"')
    expect(PANEL).toContain('aria-label={spoken}')
    expect(PANEL).toContain('${CHANNEL_LABEL[row.channel]} broadcast ${row.name}')
    // Only facts that exist reach the sentence — a blank one is dropped, not spoken as empty.
    expect(PANEL).toContain('.filter(Boolean).join')
  })

  it('the channel is written out, not carried by the glyph alone', () => {
    expect(PANEL).toContain('{CHANNEL_LABEL[row.channel]}')
    expect(PANEL).toMatch(/backgroundImage: channelFill\(row\.channel\) \}\}\s*\n\s*aria-hidden/)
  })

  it('the status is a word, not a colour', () => {
    expect(PANEL).toContain('>{row.statusLabel}</span>')
  })

  it('the empty-state action is keyboard reachable with a visible focus ring', () => {
    expect(PANEL).toContain('<Link')
    expect(PANEL).toContain('focus-visible:ring-2')
  })
})

// ═══ 10 · design system ══════════════════════════════════════════════════════

describe('the card belongs to the dashboard design system', () => {
  it('carries no inline colour — every value is a token, in both themes', () => {
    expect(PANEL).not.toMatch(/#[0-9A-Fa-f]{6}/)
    for (const t of ['sent', 'partial', 'failed', 'idle']) {
      for (const kind of ['tint', 'ink']) {
        expect((TOKENS.match(new RegExp('--bcast-' + t + '-' + kind + ':', 'g')) ?? []).length).toBe(2)
      }
    }
  })

  it('fills its grid track and pushes its footer to the bottom, with no fixed height', () => {
    expect(PANEL).toContain('className="h-full"')
    expect(PANEL).toContain('bodyClassName="flex flex-col"')
    expect(PANEL).toContain('flex flex-1 flex-col')
    expect(PANEL).toContain('mt-auto')
    expect(PANEL).not.toMatch(/(^|[^-])\bh-\[\d+px\]/)
  })

  it('long names wrap rather than truncating', () => {
    // A clipped campaign name cannot be told from its neighbour.
    expect(PANEL).toContain('break-words text-fs-sm font-semibold')
    expect(strip(PANEL)).not.toMatch(/truncate[^\n]*row\.name/)
  })

  it('brings no glow, shadow or blur', () => {
    expect(PANEL).not.toMatch(/shadow-|drop-shadow|blur-/)
  })
})

// ═══ 11 · safety ═════════════════════════════════════════════════════════════

describe('this card reads, and does nothing else', () => {
  const all = [PURE, ADMIN, PANEL]

  it('performs no Firestore write', () => {
    for (const code of all) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bbatch\(\)|FieldValue/)
    }
  })

  it('changes no SENDING logic — it only reads what sending recorded', () => {
    for (const code of all) {
      // strip(): the modules' headers cite finalizeBroadcast as the SOURCE of the audit. That
      // provenance is the record; what must not exist is a call or an import.
      expect(strip(code)).not.toMatch(/finalizeBroadcast|deliverWhatsAppCampaign|processEmailBroadcastChunk/)
      expect(code).not.toMatch(/from '@\/lib\/broadcasts\/(send|finalize|emailJob|whatsappJob)'/)
    }
    // Only the shared TYPES cross over.
    const imports = (PURE + PANEL).match(/^import .*lib\/broadcasts.*$/gm) ?? []
    for (const i of imports) expect(i).toMatch(/\/types'$/)
  })

  it('imports no Razorpay client and carries no money', () => {
    for (const code of all) {
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      for (const w of [/Paise/, /gatewayFee/, /walletBalance/, /₹/]) expect(code).not.toMatch(w)
    }
  })

  it('the shaping module is PURE — no I/O, no clock', () => {
    expect(strip(PURE)).not.toMatch(/adminDb|fetch\(|await|Date\.now/)
  })

  it('hardcodes no workspace, event or campaign', () => {
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/6,?678|15,?072/)
    }
  })
})
