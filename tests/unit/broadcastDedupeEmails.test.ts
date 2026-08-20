// RD-BROADCAST-DEDUPE — "Ignore duplicate email IDs".
//
// WHY THE FEATURE EXISTS. The audience query returns one row per REGISTRATION, and
// `limitPerEmail` defaults to false, so one person may legitimately hold several
// registrations — family or team sign-ups, multiple passes, a repeat entry. Broadcasting to
// that audience mails them once per registration. This is the organizer's opt-in to mail them
// once per address.
//
// WHY DEDUPE HAPPENS BEFORE THE SNAPSHOT. `createEmailBroadcastJob` writes the recipient list
// into `emailBroadcastJobs/{id}/recipients`, and that snapshot is what every retry replays:
// `send.ts` short-circuits on `emailJobId` (never re-resolving the audience) and the runner
// skips any row already marked `sent`. Collapsing duplicates before the snapshot therefore
// inherits both guarantees instead of needing new ones.
//
// THE RULE THAT IS EASIEST TO GET WRONG. A blank email normalises to '' — and '' is not an
// identity. Keying on it would merge every blank-email registration into one recipient and
// silently drop the rest of the audience. Blank rows pass through untouched.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dedupeRecipientsByEmail, countUniqueRecipients } from '@/lib/broadcasts/dedupeRecipients'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The audience row shape both resolvers build. */
const rec = (id: string, email: string | null | undefined, name = `N${id}`) => ({
  id,
  data: { attendee: { email, name }, ticketCode: `T${id}`, passName: 'General' },
})

// ─────────────────────────────────────────────────────────────────────────────
describe('A · the option is off — existing behaviour is untouched', () => {
  it('the helper is never consulted unless the flag is true (send path)', () => {
    const send = strip(read('lib/broadcasts/send.ts'))
    expect(send).toMatch(/c\.dedupeEmails\s*\n?\s*\? dedupeRecipientsByEmail\(suppressed\)\s*\n?\s*: suppressed/)
  })

  it('the create route only dedupes when the flag is true', () => {
    const route = strip(read('app/api/organizer/broadcasts/route.ts'))
    expect(route).toMatch(/recipients = dedupeEmails \? dedupeRecipientsByEmail\(suppressed\) : suppressed/)
  })

  it('the flag is strict === true, so absent/null/truthy-string all mean OFF', () => {
    const route = strip(read('app/api/organizer/broadcasts/route.ts'))
    const count = strip(read('app/api/organizer/broadcasts/count/route.ts'))
    expect(route).toMatch(/dedupeEmails = \(body as Record<string, unknown>\)\.dedupeEmails === true/)
    expect(count).toMatch(/dedupeEmails = dedupeRaw === true/)
  })
})

describe('B · the option is on — one email per address', () => {
  it('collapses the exact same address', () => {
    const out = dedupeRecipientsByEmail([rec('1', 'a@x.com'), rec('2', 'a@x.com')])
    expect(out.map(r => r.id)).toEqual(['1'])
  })

  it('collapses across CASE differences', () => {
    const out = dedupeRecipientsByEmail([
      rec('1', 'Bala@Example.com'), rec('2', 'bala@example.com'), rec('3', 'BALA@EXAMPLE.COM'),
    ])
    expect(out.map(r => r.id)).toEqual(['1'])
  })

  it('collapses across surrounding WHITESPACE', () => {
    const out = dedupeRecipientsByEmail([rec('1', 'a@x.com'), rec('2', '  a@x.com  '), rec('3', '\ta@x.com\n')])
    expect(out.map(r => r.id)).toEqual(['1'])
  })

  it('keeps DIFFERENT addresses separate', () => {
    const out = dedupeRecipientsByEmail([rec('1', 'a@x.com'), rec('2', 'b@x.com'), rec('3', 'c@x.com')])
    expect(out.map(r => r.id)).toEqual(['1', '2', '3'])
  })

  it('the worked example from the brief', () => {
    const out = dedupeRecipientsByEmail([
      rec('1', 'Bala@Example.com'), rec('2', 'bala@example.com'), rec('3', 'other@example.com'),
    ])
    expect(out).toHaveLength(2)
    expect(out.map(r => r.data.attendee.email)).toEqual(['Bala@Example.com', 'other@example.com'])
  })

  it('FIRST occurrence wins, in the caller’s order', () => {
    const out = dedupeRecipientsByEmail([rec('first', 'a@x.com', 'First'), rec('second', 'A@X.com', 'Second')])
    expect(out[0].id).toBe('first')
    expect(out[0].data.attendee.name).toBe('First')      // the name that will be rendered
  })

  it('preserves the winner’s full row — registrationId, name, ticketCode, passName', () => {
    const [winner] = dedupeRecipientsByEmail([rec('7', 'a@x.com'), rec('8', 'a@x.com')])
    expect(winner).toEqual(rec('7', 'a@x.com'))
  })

  it('does NOT mutate the input or rewrite the stored email', () => {
    const input = [rec('1', 'Bala@Example.com'), rec('2', 'bala@example.com')]
    const snapshot = JSON.stringify(input)
    const out = dedupeRecipientsByEmail(input)
    expect(JSON.stringify(input)).toBe(snapshot)          // untouched
    expect(out[0].data.attendee.email).toBe('Bala@Example.com')   // original casing preserved
  })

  it('is order-stable for a large audience', () => {
    const many = Array.from({ length: 500 }, (_, i) => rec(String(i), `u${i % 100}@x.com`))
    const out = dedupeRecipientsByEmail(many)
    expect(out).toHaveLength(100)
    expect(out.map(r => r.id)).toEqual(Array.from({ length: 100 }, (_, i) => String(i)))
  })
})

// ── THE RULE MOST EASILY GOT WRONG ──────────────────────────────────────────
describe('B · blank emails are NEVER collapsed', () => {
  it('several blank-email registrations all survive', () => {
    const out = dedupeRecipientsByEmail([rec('1', ''), rec('2', ''), rec('3', '   ')])
    expect(out.map(r => r.id)).toEqual(['1', '2', '3'])
  })

  it('missing and null emails survive too', () => {
    const out = dedupeRecipientsByEmail([rec('1', null), rec('2', undefined), rec('3', null)])
    expect(out.map(r => r.id)).toEqual(['1', '2', '3'])
  })

  it('blanks do not interfere with real duplicates around them', () => {
    const out = dedupeRecipientsByEmail([
      rec('1', 'a@x.com'), rec('2', ''), rec('3', 'A@X.com'), rec('4', null), rec('5', 'b@x.com'),
    ])
    expect(out.map(r => r.id)).toEqual(['1', '2', '4', '5'])
  })

  it('MUTATION: keying on the empty string would collapse them — and this test would catch it', () => {
    // The naive implementation is `new Set(emails.map(normalize))`, which maps every blank to
    // one key. Asserting the count proves blanks are counted individually.
    const blanks = [rec('1', ''), rec('2', '  '), rec('3', null)]
    expect(dedupeRecipientsByEmail(blanks)).toHaveLength(3)
    expect(new Set(blanks.map(() => '')).size).toBe(1)   // what the naive version would give
  })
})

describe('D · preview count matches what the send will do', () => {
  it('counts distinct addresses', () => {
    expect(countUniqueRecipients(['a@x.com', 'A@X.com', ' a@x.com ', 'b@x.com'])).toBe(2)
  })

  it('counts each blank SEPARATELY, exactly as the send treats them', () => {
    expect(countUniqueRecipients(['', '', null, undefined])).toBe(4)
  })

  it('mixes blanks and duplicates consistently with dedupeRecipientsByEmail', () => {
    const emails = ['a@x.com', '', 'A@X.com', null, 'b@x.com']
    const rows   = emails.map((e, i) => rec(String(i), e))
    expect(countUniqueRecipients(emails)).toBe(dedupeRecipientsByEmail(rows).length)
  })

  it('an empty audience is zero', () => {
    expect(countUniqueRecipients([])).toBe(0)
  })
})

// ── PIPELINE CONTRACTS ──────────────────────────────────────────────────────
describe('C+F · recipientCount and the job snapshot', () => {
  const route = strip(read('app/api/organizer/broadcasts/route.ts'))
  const send  = strip(read('lib/broadcasts/send.ts'))

  it('recipientCount is derived AFTER dedupe, so history records what was sent', () => {
    const dedupeAt = route.indexOf('recipients = dedupeEmails ?')
    const countAt  = route.indexOf('const recipientCount = recipients.length')
    expect(dedupeAt).toBeGreaterThan(-1)
    expect(countAt).toBeGreaterThan(dedupeAt)
  })

  it('dedupe happens BEFORE createEmailBroadcastJob — one snapshot row per address', () => {
    const dedupeAt = send.indexOf('dedupeRecipientsByEmail(suppressed)')
    const jobAt    = send.indexOf('createEmailBroadcastJob(campaignId, c, recipients)')
    expect(dedupeAt).toBeGreaterThan(-1)
    expect(jobAt).toBeGreaterThan(dedupeAt)
  })

  it('dedupe is applied AFTER suppression, in both resolvers', () => {
    expect(route).toMatch(/suppressionSet\.has[\s\S]{0,200}?recipients = dedupeEmails \?/)
    expect(send).toMatch(/suppression\.has[\s\S]{0,300}?c\.dedupeEmails/)
  })

  it('the existing cap gate is unchanged and still precedes everything', () => {
    expect(route).toMatch(/const audienceSize\s+= \(await regsQuery\.count\(\)\.get\(\)\)\.data\(\)\.count/)
    expect(route).toMatch(/if \(audienceSize > maxRecipients\)/)
    expect(route).toMatch(/BROADCAST_TOO_LARGE/)
    const capAt    = route.indexOf('BROADCAST_TOO_LARGE')
    const dedupeAt = route.indexOf('recipients = dedupeEmails ?')
    expect(capAt).toBeLessThan(dedupeAt)
  })
})

describe('E · scheduled broadcasts', () => {
  const route = strip(read('app/api/organizer/broadcasts/route.ts'))
  const send  = strip(read('lib/broadcasts/send.ts'))

  it('the flag is persisted on the campaign document', () => {
    expect(route).toMatch(/dedupeEmails && chosenChannel !== 'whatsapp' \? \{ dedupeEmails: true \} : \{\}/)
  })

  it('the send path reads it from the CAMPAIGN, not from a parameter', () => {
    // A scheduled campaign reaches deliverEmailCampaign from the cron with only the stored
    // document, so anything not persisted would be lost.
    expect(send).toMatch(/c\.dedupeEmails/)
    expect(send).not.toMatch(/function deliverEmailCampaign\([^)]*dedupe/)
  })

  it('CampaignData carries the field so the cron path type-checks', () => {
    expect(send).toMatch(/dedupeEmails\?:\s+boolean/)
  })
})

describe('G · retries cannot re-send a collapsed duplicate', () => {
  const send    = strip(read('lib/broadcasts/send.ts'))
  const emailJob = strip(read('lib/broadcasts/emailJob.ts'))

  it('an existing job is resumed, never re-resolved', () => {
    expect(send).toMatch(/if \(c\.emailJobId\) \{ await processEmailBroadcastChunk\(c\.emailJobId\); return \}/)
  })

  it('a recipient already sent is skipped', () => {
    expect(emailJob).toMatch(/if \(item\.sent\) return \{ ok: true \}/)
  })

  it('the job runner and its idempotency were not modified', () => {
    expect(emailJob).toMatch(/\.update\(\{ sent: true \}\)/)
  })
})

// ── ISOLATION ───────────────────────────────────────────────────────────────
describe('H+I · WhatsApp and registration confirmations are untouched', () => {
  const send  = strip(read('lib/broadcasts/send.ts'))
  const route = strip(read('app/api/organizer/broadcasts/route.ts'))

  it('deliverWhatsAppCampaign never consults the flag', () => {
    const wa = send.slice(send.indexOf('async function deliverWhatsAppCampaign'))
    expect(wa).not.toMatch(/dedupeEmails|dedupeRecipientsByEmail/)
  })

  it('the WhatsApp branch still filters on phone PRESENCE, and never on email', () => {
    // The presence rule is unchanged; only the local it binds to was renamed when the
    // WhatsApp-number dedupe was added on top of it (RD-WA-DEDUPE).
    expect(route).toContain("allRecipients.filter(({ data: reg }) => typeof reg.attendee.phone === 'string' && reg.attendee.phone.trim().length > 0)")
    // What must never happen: email dedupe leaking into the WhatsApp branch. Sliced to the
    // branch itself — a character-window regex would run past `} else {` and match the email
    // branch's own legitimate call.
    const waStart = route.indexOf("if (chosenChannel === 'whatsapp') {")
    const waEnd   = route.indexOf('} else {', waStart)
    expect(waStart).toBeGreaterThan(-1)
    expect(waEnd).toBeGreaterThan(waStart)
    expect(route.slice(waStart, waEnd)).not.toContain('dedupeRecipientsByEmail')
  })

  it('the flag is never persisted on a WhatsApp campaign', () => {
    expect(route).toMatch(/chosenChannel !== 'whatsapp'/)
  })

  // WHY THIS ASSERTION CHANGED. It used to read "no phone deduplication was introduced
  // anywhere" — correct while WhatsApp dedupe did not exist, and the honest way to state
  // "the email feature must not touch WhatsApp" at that time. Phone dedupe has since been
  // commissioned deliberately (RD-WA-DEDUPE), so the old wording now forbids a shipped
  // requirement rather than protecting one. What it was really guarding — that the two
  // channels cannot reach into each other — is what is asserted here instead, and that
  // guarantee is unchanged.
  it('the EMAIL dedupe never applies to WhatsApp, and vice versa', () => {
    const helper = strip(read('lib/broadcasts/dedupeRecipients.ts'))
    // Two separate functions, each keyed on its own identity — never one generic switch.
    expect(helper).toContain('export function dedupeRecipientsByEmail')
    expect(helper).toContain('export function dedupeRecipientsByPhone')
    // The email collapser keys on the address; the phone collapser on the number.
    expect(helper).toMatch(/const key = normalizeEmail\(r\.data\?\.attendee\?\.email\)/)
    expect(helper).toMatch(/const key = phoneKey\(r\.data\?\.attendee\?\.phone\)/)
    // And the campaign flags stay distinct, so one channel's option cannot drive the other.
    expect(send).toContain('c.dedupeEmails')
    expect(send).toContain('c.dedupePhones')
  })

  it('the helper is pure — no Firebase, no I/O', () => {
    const helper = strip(read('lib/broadcasts/dedupeRecipients.ts'))
    expect(helper).not.toMatch(/firebase|firestore|adminDb|fetch\(/i)
  })

  it('it reuses the existing normalizeEmail rather than redefining one', () => {
    const helper = read('lib/broadcasts/dedupeRecipients.ts')
    expect(helper).toMatch(/import \{ normalizeEmail \} from '@\/lib\/crm\/identity'/)
    expect(strip(helper)).not.toMatch(/function normalizeEmail/)
  })

  it('registration-confirmation senders are not referenced by the broadcast dedupe path', () => {
    for (const f of ['lib/broadcasts/dedupeRecipients.ts', 'lib/broadcasts/send.ts']) {
      expect(strip(read(f))).not.toMatch(/sendConfirmationEmail|sendApprovalEmail|resendTicketEmail|sendWhatsAppConfirmation/)
    }
  })
})

describe('preview count endpoint stays bounded', () => {
  const count = strip(read('app/api/organizer/broadcasts/count/route.ts'))

  it('reuses the existing projected, capped read — never the whole collection', () => {
    expect(count).toMatch(/\.select\('attendee'\)\.limit\(maxRecipients \+ 1\)\.get\(\)/)
  })

  it('falls back to the untouched count() aggregate when the flag is off', () => {
    expect(count).toMatch(/const agg = await query\.count\(\)\.get\(\)/)
    const dedupeAt = count.indexOf('if (dedupeEmails)')
    const aggAt    = count.indexOf('const agg = await query.count().get()')
    expect(dedupeAt).toBeLessThan(aggAt)
  })

  it('authorization is unchanged', () => {
    expect(count).toMatch(/authorizeWorkspace\(req, 'broadcasts'\)/)
    expect(count).toMatch(/\.where\('organizerUid', '==', uid\)/)
  })
})
