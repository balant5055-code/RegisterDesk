// RD-DASH-08 · Workspace health — the checks, the verdict, and the card that shows them.
//
// ═══ THE AUDIT THIS SUITE ENCODES ════════════════════════════════════════════
// The card rendered `round(doneCount / 6 * 100)` as "N% setup complete". Three defects:
//
//   1. A MANUFACTURED SCORE. RegisterDesk has no authoritative health-scoring model, so the
//      six equal weights were invented — a missing certificate signature counted exactly as
//      much as having no published event at all.
//   2. IT WAS ONBOARDING, NOT HEALTH. The audited workspace scored 33% while running an
//      event with 2,329 registrations.
//   3. ONE ITEM WAS WRONG. `communications.sendRegistrationConfirmation ?? false`, while the
//      settings API — the authoritative reader — uses `?? true`. On the audited workspace the
//      `communications` key is absent ENTIRELY and 4,707 emails have been sent, so the card
//      reported a working feature as switched off.
//
// The rules are exercised through the PURE builder; the rendering rules are asserted at
// source level. Nothing here encodes a real workspace, event or figure.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildWorkspaceHealth, DEFAULT_SEND_CONFIRMATION, SEVERITY_RANK,
  type WorkspaceHealthInput,
} from '@/lib/dashboard/workspaceHealth'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments carry the audit's prose, including what the CODE must no longer do. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const HEALTH   = read('lib/dashboard/workspaceHealth.ts')
const PANEL    = read('components/dashboard/WorkspaceHealthPanel.tsx')
const ROUTE    = read('app/api/organizer/dashboard/route.ts')
const PAGE     = read('app/(dashboard)/dashboard/page.tsx')
const WELCOME  = read('app/(auth)/welcome/page.tsx')
const SETTINGS = read('app/api/organizer/settings/route.ts')
const TOKENS   = read('styles/tokens.css')

/** A fully configured workspace with nothing wrong. Each test perturbs only its own subject. */
const input = (over: Partial<WorkspaceHealthInput> = {}): WorkspaceHealthInput => ({
  profile: {
    organizationName: 'Some Organization',
    supportEmail:     'help@example.test',
    logoUrl:          'https://example.test/logo.png',
    certSignatureUrl: 'https://example.test/sig.png',
    sendRegistrationConfirmation: true,
  },
  events: { publishedCount: 2, gaps: [] },
  ...over,
})

// ═══ 1 · the verdict is earned, never scored ═════════════════════════════════

describe('the card reports a STATE, not a percentage', () => {
  it('a fully configured workspace with clean events is healthy', () => {
    const h = buildWorkspaceHealth(input())
    expect(h.state).toBe('healthy')
    expect(h.issues).toHaveLength(0)
  })

  it('no percentage is computed anywhere', () => {
    // The exact expression that shipped: round(done / 6 * 100).
    expect(strip(HEALTH)).not.toMatch(/\/\s*\w*[Tt]otal\s*\)\s*\*\s*100/)
    expect(strip(HEALTH)).not.toMatch(/Math\.round\([^)]*\*\s*100/)
    expect(strip(PANEL)).not.toMatch(/%/)
    expect(strip(PANEL)).not.toMatch(/score/i)
  })

  it('the old score is gone from the payload and every consumer', () => {
    // strip(): the route's own doc comment records what the field replaced, which is the
    // record of the audit. What must be gone is the FIELD.
    expect(strip(ROUTE)).not.toMatch(/healthScore/)
    expect(strip(PAGE)).not.toMatch(/healthScore/)
    expect(strip(WELCOME)).not.toMatch(/healthScore/)
    expect(ROUTE).toContain('workspaceHealth: WorkspaceHealth')
  })

  it('setup is reported as a literal tally', () => {
    const h = buildWorkspaceHealth(input({ profile: { ...input().profile!, logoUrl: null } }))
    expect(h.setup).toMatchObject({ done: 5, total: 6, unavailable: false })
    expect(PANEL).toContain('${setup.done} of ${setup.total}')
  })
})

// ═══ 2 · the confirmation-email default ══════════════════════════════════════

describe('an ABSENT setting is the default, not a disabled feature', () => {
  it('undefined means the platform default, which is on', () => {
    const h = buildWorkspaceHealth(input({
      profile: { ...input().profile!, sendRegistrationConfirmation: undefined },
    }))
    expect(DEFAULT_SEND_CONFIRMATION).toBe(true)
    expect(h.checks.find(c => c.id === 'send_confirmation')?.done).toBe(true)
    expect(h.state).toBe('healthy')
  })

  it('an explicit false is still reported as off', () => {
    // The mirror: a genuinely disabled feature must not be excused by the default.
    const h = buildWorkspaceHealth(input({
      profile: { ...input().profile!, sendRegistrationConfirmation: false },
    }))
    expect(h.checks.find(c => c.id === 'send_confirmation')?.done).toBe(false)
  })

  it('the default matches the SETTINGS API — pinned, so the two cannot drift', () => {
    // The settings route is the authoritative reader. When it said `?? true` and this card
    // said `?? false`, Settings showed the toggle ON and the dashboard called it not done.
    expect(SETTINGS).toMatch(/sendRegistrationConfirmation\s*\?\?\s*true/)
    expect(HEALTH).toContain('export const DEFAULT_SEND_CONFIRMATION = true')
    expect(strip(HEALTH)).not.toMatch(/sendRegistrationConfirmation\s*\?\?\s*false/)
    expect(strip(ROUTE)).not.toMatch(/sendRegistrationConfirmation\s*\?\?\s*false/)
  })

  it('it is the one setup gap treated as ACTION rather than attention', () => {
    // With it off, every attendee registers and hears nothing back — an operational
    // consequence, not a cosmetic one.
    const h = buildWorkspaceHealth(input({
      profile: { ...input().profile!, sendRegistrationConfirmation: false },
    }))
    expect(h.state).toBe('action')
    expect(h.issues.find(i => i.id === 'setup:send_confirmation')?.severity).toBe('action')
  })
})

// ═══ 3 · event configuration comes from the platform's own evaluator ═════════

describe('event severity is not decided here', () => {
  it('a published event failing a REQUIRED setting is action required', () => {
    const h = buildWorkspaceHealth(input({
      events: { publishedCount: 3, gaps: [{ draftId: 'd1', name: 'Some Event', critical: 2, warning: 1 }] },
    }))
    expect(h.state).toBe('action')
    expect(h.events.criticalEvents).toBe(1)
    expect(h.issues[0].severity).toBe('action')
    expect(h.issues[0].detail).toContain('2 required settings are missing')
  })

  it('one missing required setting is worded in the singular', () => {
    const h = buildWorkspaceHealth(input({
      events: { publishedCount: 1, gaps: [{ draftId: 'd1', name: 'E', critical: 1, warning: 0 }] },
    }))
    expect(h.issues[0].detail).toContain('1 required setting is missing')
  })

  it('warning-level gaps are INFORMATIONAL, because the platform does not block on them', () => {
    const h = buildWorkspaceHealth(input({
      events: { publishedCount: 2, gaps: [{ draftId: 'd1', name: 'E', critical: 0, warning: 3 }] },
    }))
    expect(h.events.warningEvents).toBe(1)
    expect(h.issues.find(i => i.id === 'event_warnings')?.severity).toBe('info')
    // Info alone never drags the verdict below healthy.
    expect(h.state).toBe('healthy')
  })

  it('the route runs the SAME evaluator the publish flow runs', () => {
    // So a gap this card calls "required" is exactly one the platform would block on. No
    // threshold, no heuristic, no inference from volume is invented here.
    expect(ROUTE).toContain("from '@/lib/events/publishRequirements'")
    expect(ROUTE).toContain('evaluatePublishRequirements({')
    expect(ROUTE).toContain("severityOf(r) === 'critical'")
    expect(strip(HEALTH)).not.toMatch(/registered|capacity|revenue|>\s*\d{2,}/)
  })

  it('it is applied to PUBLISHED events only', () => {
    // A draft with unfinished configuration is a draft, not a defect.
    expect(ROUTE).toContain('const publishedGaps = publishedDrafts.map(d => {')
  })

  it('no published event means the check has nothing to say and the setup item fails', () => {
    const h = buildWorkspaceHealth(input({ events: { publishedCount: 0, gaps: [] } }))
    expect(h.checks.find(c => c.id === 'published_event')?.done).toBe(false)
    expect(h.state).toBe('attention')
  })
})

// ═══ 4 · unknown is never healthy ════════════════════════════════════════════

describe('an unrunnable check is never an all-clear', () => {
  it('both sources unreadable ⇒ unavailable', () => {
    const h = buildWorkspaceHealth({ profile: null, events: null })
    expect(h.state).toBe('unavailable')
    expect(h.setup.unavailable).toBe(true)
    expect(h.events.unavailable).toBe(true)
    // Crucially: not healthy, and not a tally of zero out of six passing.
    expect(h.state).not.toBe('healthy')
  })

  it('an unreadable profile produces no checks rather than six failing ones', () => {
    const h = buildWorkspaceHealth({ profile: null, events: { publishedCount: 1, gaps: [] } })
    expect(h.checks).toHaveLength(0)
    expect(h.setup).toMatchObject({ done: 0, total: 0, unavailable: true })
    // Six invented failures would read as a badly-configured workspace, which is a claim.
    expect(h.issues.filter(i => i.id.startsWith('setup:'))).toHaveLength(0)
  })

  it('the card renders the unmeasured signals as Unavailable, never as zero', () => {
    expect(PANEL).toContain("setup.unavailable ? 'Unavailable'")
    expect(PANEL).toContain("events.unavailable ? 'Unavailable'")
    expect(PANEL).toContain('could not be run, so nothing here is reported as healthy')
  })

  it('an unavailable card reports no ISSUE COUNT either', () => {
    // Measured in the browser: "Unavailable" above a footer reading "0 to look at" reads as
    // an all-clear. It computed no issues, so it claims none.
    expect(PANEL).toContain("state === 'unavailable' ? 'not checked'")
  })

  it('the events note agrees in number with the count beside it', () => {
    expect(PANEL).toContain("events.criticalEvents === 1 ? 'is' : 'are'")
  })

  it('with nothing published, the events note does not claim a vacuous pass', () => {
    // "all pass required checks" over zero events is true and useless.
    expect(PANEL).toContain("events.published === 0 ? 'nothing published yet'")
  })

  it('every state has exactly one label and one icon', () => {
    for (const s of ['healthy', 'attention', 'action', 'unavailable']) {
      expect(PANEL).toContain(s + ':')
    }
    expect(PANEL).toContain("healthy:     'Healthy'")
    expect(PANEL).toContain("unavailable: 'Unavailable'")
  })
})

// ═══ 5 · prioritisation ══════════════════════════════════════════════════════

describe('issues are ranked by severity', () => {
  it('action outranks attention outranks info', () => {
    expect(SEVERITY_RANK.action).toBeLessThan(SEVERITY_RANK.attention)
    expect(SEVERITY_RANK.attention).toBeLessThan(SEVERITY_RANK.info)
  })

  it('a mixed workspace lists the most severe first', () => {
    const h = buildWorkspaceHealth({
      profile: {
        organizationName: null, supportEmail: null, logoUrl: null,
        certSignatureUrl: null, sendRegistrationConfirmation: undefined,
      },
      events: {
        publishedCount: 4,
        gaps: [
          { draftId: 'd1', name: 'Broken Event', critical: 1, warning: 0 },
          { draftId: 'd2', name: 'Thin Event', critical: 0, warning: 2 },
        ],
      },
    })
    expect(h.state).toBe('action')
    const severities = h.issues.map(i => i.severity)
    expect(severities).toEqual([...severities].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]))
    expect(h.issues[0].id).toBe('event_critical:d1')
    expect(h.issues[h.issues.length - 1].id).toBe('event_warnings')
  })

  it('the component caps the list and admits it', () => {
    expect(PANEL).toContain('issues.slice(0, HEALTH_ISSUES_SHOWN)')
    expect(PANEL).toContain('Top ${shown.length} by severity')
    expect(PANEL).toContain('of ${issues.length} to look at')
    // …and never re-ranks. One ordering rule, in the pure module.
    expect(strip(PANEL)).not.toMatch(/issues[^\n]*\.sort\(/)
    expect(HEALTH).toContain('issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])')
  })

  it('the verdict agrees with the issues it was derived from', () => {
    for (const h of [
      buildWorkspaceHealth(input()),
      buildWorkspaceHealth(input({ profile: { ...input().profile!, logoUrl: null } })),
      buildWorkspaceHealth(input({ profile: { ...input().profile!, sendRegistrationConfirmation: false } })),
    ]) {
      if (h.state === 'healthy')   expect(h.issues.every(i => i.severity === 'info')).toBe(true)
      if (h.state === 'attention') expect(h.issues.some(i => i.severity === 'attention')).toBe(true)
      if (h.state === 'action')    expect(h.issues.some(i => i.severity === 'action')).toBe(true)
    }
  })
})

// ═══ 6 · actionability ═══════════════════════════════════════════════════════

describe('an issue says what, why, and where to fix it', () => {
  it('every issue carries a reason, not just a name', () => {
    const h = buildWorkspaceHealth({
      profile: {
        organizationName: null, supportEmail: null, logoUrl: null,
        certSignatureUrl: null, sendRegistrationConfirmation: false,
      },
      events: { publishedCount: 1, gaps: [] },
    })
    for (const i of h.issues) {
      expect(i.title.length).toBeGreaterThan(0)
      expect(i.detail.length).toBeGreaterThan(0)
      expect(i.detail).not.toBe(i.title)
    }
  })

  it('every destination is an EXISTING route, never invented', () => {
    const h = buildWorkspaceHealth({
      profile: {
        organizationName: null, supportEmail: null, logoUrl: null,
        certSignatureUrl: null, sendRegistrationConfirmation: false,
      },
      events: { publishedCount: 1, gaps: [{ draftId: 'd1', name: 'E', critical: 1, warning: 0 }] },
    })
    const known = ['/dashboard/settings', '/dashboard/settings/branding', '/dashboard/events']
    for (const i of h.issues) {
      if (!i.href) continue
      expect(known.some(k => i.href === k) || i.href.startsWith('/dashboard/events/')).toBe(true)
    }
  })

  it('a row is a link only when there is somewhere useful to go', () => {
    expect(PANEL).toContain('return href ? (')
    expect(PANEL).toContain('{href && actionLabel && (')
  })

  it('a linked row is keyboard reachable and focus-visible', () => {
    expect(PANEL).toContain('<Link')
    expect(PANEL).toContain('focus-visible:ring-2')
  })
})

// ═══ 7 · scope ═══════════════════════════════════════════════════════════════

describe('the card is workspace-wide and says so', () => {
  it('the scope pill is the SERVER\'s decision, forwarded — not hardcoded', () => {
    // `scope.workspaceOnly` is server-owned so a section that becomes genuinely scopeable
    // loses its pill by itself. Communication Usage did exactly that in RD-DASH-06.
    expect(PANEL).toContain('scopeNote={scopeNote}')
    expect(strip(PANEL)).not.toMatch(/scopeNote="/)
    expect(PAGE).toContain("scopeNote={wsNote('health')}")
    expect(strip(ROUTE)).toMatch(/workspaceOnly[\s\S]{0,200}'health'/)
  })

  it('nothing here is event-scoped', () => {
    // Setup, branding and publish configuration are properties of the workspace. The builder
    // takes no event selection and no slug.
    expect(strip(HEALTH)).not.toMatch(/selectedSlug|eventSlug|scoped/)
  })
})

// ═══ 8 · no duplication of the cards beside it ═══════════════════════════════

describe('this card does not restate what four other cards already answer', () => {
  it('carries no capacity, closing-date, pace or review signal', () => {
    // Those are the Attention Center's, from lib/dashboard/insights.
    for (const code of [strip(HEALTH), strip(PANEL)]) {
      for (const w of [/nearly_full/, /closing/i, /\bpace\b/, /reviewStatus/, /changes_requested/]) {
        expect(code).not.toMatch(w)
      }
    }
  })

  it('carries no message, coupon or money figure', () => {
    for (const code of [strip(HEALTH), strip(PANEL)]) {
      for (const w of [/whatsapp/i, /emailLogs/, /campaign/i, /coupon/i, /Paise/, /revenue/i, /₹/]) {
        expect(code).not.toMatch(w)
      }
    }
  })

  it('the split is stated so a later phase does not re-merge them', () => {
    expect(PANEL).toContain('the Attention Center above already answers')
    expect(HEALTH).toContain('URGENCY vs READINESS')
  })
})

// ═══ 9 · accessibility ═══════════════════════════════════════════════════════

describe('nothing rests on colour alone', () => {
  it('the verdict is text, and announced as a status', () => {
    expect(PANEL).toContain('role="status"')
    expect(PANEL).toContain('{STATE_LABEL[state]}')
  })

  it('an issue speaks its severity in words', () => {
    expect(PANEL).toContain("severity === 'action' ? 'Action required'")
    expect(PANEL).toContain('aria-label={spoken}')
  })

  it('a signal speaks its label, value and note', () => {
    expect(PANEL).toContain('aria-label={`${label}: ${value}. ${note}`}')
  })

  it('the glyphs and the severity dot are decorative', () => {
    expect((PANEL.match(/aria-hidden/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

// ═══ 10 · design system ══════════════════════════════════════════════════════

describe('the card belongs to the dashboard design system', () => {
  it('carries no inline colour — every value is a token, in both themes', () => {
    expect(PANEL).not.toMatch(/#[0-9A-Fa-f]{6}/)
    for (const t of ['healthy', 'attention', 'action', 'unknown']) {
      for (const kind of ['tint', 'ink']) {
        expect((TOKENS.match(new RegExp('--health-' + t + '-' + kind + ':', 'g')) ?? []).length).toBe(2)
      }
    }
    for (const kind of ['tint', 'ink']) {
      expect(PANEL).toContain('var(--health-${t}-' + kind + ')')
    }
  })

  it('only the healthy state carries a gradient', () => {
    expect((TOKENS.match(/--health-healthy-fill:/g) ?? []).length).toBe(2)
    expect(TOKENS).not.toMatch(/--health-(attention|action|unknown)-fill:/)
    expect(PANEL).toContain("state === 'healthy'")
    expect(PANEL).toContain("backgroundImage: 'var(--health-healthy-fill)'")
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
})

// ═══ 11 · the welcome screen, which shares these checks ══════════════════════

describe('the onboarding screen reads the checks by ID, not by label', () => {
  it('a reworded label can no longer silently reset a step', () => {
    // It keyed on `'Event published'` and friends with `?? false`, so renaming a label made
    // every step report incomplete — and the breakage looked exactly like a new workspace.
    expect(WELCOME).toContain("done.get('published_event')")
    expect(WELCOME).toContain("done.get('org_name')")
    expect(WELCOME).not.toMatch(/done\.get\('[A-Z]/)
  })

  it('those ids really exist on the checks', () => {
    const ids = buildWorkspaceHealth(input()).checks.map(c => c.id)
    for (const id of ['published_event', 'org_name', 'logo', 'support_email']) {
      expect(ids).toContain(id)
    }
  })

  it('its progress bar is a completion TALLY, not a health score', () => {
    // Legitimate on an onboarding screen: "3 of 6 steps done" expressed as a percentage is a
    // literal ratio. What it must not do is call that ratio health.
    expect(WELCOME).toContain('Math.round((setup.done / setup.total) * 100)')
    expect(WELCOME).toContain('Workspace setup')
  })
})

// ═══ 12 · safety and cost ════════════════════════════════════════════════════

describe('this card reads nothing of its own, and writes nothing', () => {
  it('the builder is PURE — no I/O, no clock, no React', () => {
    expect(strip(HEALTH)).not.toMatch(/adminDb|fetch\(|await|Date\.|import .*react/i)
  })

  it('costs no extra Firestore round trip', () => {
    // The profile document and every draft are already loaded by the route;
    // evaluatePublishRequirements is pure computation over them.
    expect(ROUTE).toContain('Costs NOTHING extra')
    const block = ROUTE.slice(ROUTE.indexOf('// ── Workspace health'), ROUTE.indexOf('// ── License entitlement'))
    expect(block).not.toMatch(/\.get\(\)|\.count\(\)|aggregate\(/)
  })

  it('performs no Firestore write and touches no money path', () => {
    for (const code of [HEALTH, PANEL]) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bbatch\(\)|FieldValue/)
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      for (const w of [/gatewayFee/, /platformFee/, /refundAmount/, /walletBalance/]) {
        expect(code).not.toMatch(w)
      }
    }
  })

  it('hardcodes no workspace, organization or event', () => {
    for (const code of [strip(HEALTH), strip(PANEL)]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/2,?329|4,?707/)
    }
  })
})
