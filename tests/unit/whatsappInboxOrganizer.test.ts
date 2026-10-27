// WhatsApp Inbox (Phase 1b) — organizer navigation, search matching and route/UI contracts.
//
// The emulator suite proves the routes' behaviour against real Firestore; this file pins the
// wiring a later edit could quietly undo: every route passes through the ONE inbox gate,
// the organizer id only ever comes from that gate, the nav row mirrors the server's two
// gates, and the reply composer stays disabled.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WORKSPACE_NAV, WORKSPACE_NAV_ITEMS, navHrefEnabled, navItemForLocation } from '@/config/workspaceNav'
import { buildBreadcrumbs } from '@/lib/navigation/breadcrumbs'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { ROLE_PERMISSIONS } from '@/lib/team/types'
import { conversationMatches } from '@/lib/whatsapp-inbox/types'

const ROOT = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** Source without comments — contracts are about code, not about what a comment says. */
// Line comments first: a line comment can contain "/*" (e.g. a route glob), which would
// otherwise open a block-comment match and swallow real code.
const code = (p: string) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...routeFiles(rel))
    else if (name === 'route.ts') out.push(rel)
  }
  return out
}

describe('navigation', () => {
  const inbox = WORKSPACE_NAV_ITEMS.find(i => i.key === 'inbox')!

  it('is its own top-level section, not a Communications surface', () => {
    const section = WORKSPACE_NAV.find(s => s.items.some(i => i.key === 'inbox'))!
    expect(section.sectionLabel).toBe('Inbox')
    expect(section.items).toHaveLength(1)
    expect(WORKSPACE_NAV.find(s => s.sectionLabel === 'Communications')!.items.some(i => i.key === 'inbox')).toBe(false)
    expect(inbox).toMatchObject({ href: '/dashboard/inbox', scope: 'global', permission: 'broadcasts' })
  })

  it('is offered only to owner and admin (the broadcasts holders)', () => {
    const roles = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.includes(inbox.permission!)).map(([r]) => r).sort()
    expect(roles).toEqual(['admin', 'owner'])
  })

  it('stays in the nav whether or not the whatsappInbox flag is on — the flag (default off) gates DATA, not the row', () => {
    const flags = BUSINESS_CONFIG_DEFAULTS.featureFlags
    expect(flags.whatsappInbox).toBe(false)
    expect(navHrefEnabled('/dashboard/inbox', flags)).toBe(true)
    expect(navHrefEnabled('/dashboard/inbox', { ...flags, whatsappInbox: true })).toBe(true)
    // …while every Inbox API still refuses with the flag off (gate tests below), and the
    // sidebar does not poll the unread count unless the flag is on.
    expect(read('components/dashboard/Sidebar.tsx')).toContain('useInboxUnreadCount(inboxVisible && flags.whatsappInbox)')
  })

  it('is the active row on /dashboard/inbox and breadcrumbs read "Overview / Inbox"', () => {
    expect(navItemForLocation('/dashboard/inbox', null)?.key).toBe('inbox')
    const c = buildBreadcrumbs({ pathname: '/dashboard/inbox', selectedEventId: null, eventName: null, tab: null, leafLabel: null })
    expect(c.map(x => x.label)).toEqual(['Overview', 'Inbox'])
  })

  it('the command palette applies the same flag + permission gates to nav commands', () => {
    const src = read('components/dashboard/CommandPalette.tsx')
    expect(src).toContain('.filter(c => !c.href || navHrefEnabled(c.href, flags))')
    expect(src).toContain('.filter(c => !c.permission || perms.has(c.permission))')
  })
})

describe('conversationMatches', () => {
  const c = { attendeeName: 'Asha Rao', attendeePhone: '+919876543210', eventName: 'Coimbatore Marathon 2026' }
  it.each([
    ['', true], ['asha', true], ['RAO', true], ['marathon', true],
    ['98765', true], ['+91 98765', true], ['9876-543', true], ['12345', false], ['ravi', false],
  ])('%j → %s', (q, expected) => {
    expect(conversationMatches(c, q)).toBe(expected)
  })
  it('handles missing fields', () => {
    expect(conversationMatches({ attendeePhone: '' }, 'asha')).toBe(false)
  })
})

describe('the ONE inbox gate', () => {
  const authz = read('lib/whatsapp-inbox/authz.ts')

  it('authorizes with broadcasts, then the flag (404 when off)', () => {
    expect(authz).toContain("authorizeWorkspace(req, 'broadcasts')")
    expect(authz).toMatch(/whatsappInbox === true/)
    expect(authz).toMatch(/status: 404/)
    expect(authz.indexOf("authorizeWorkspace(req, 'broadcasts')")).toBeLessThan(authz.indexOf('getFeatureFlags()'))
  })

  const routes = routeFiles('app/api/organizer/whatsapp-inbox')
  it('covers exactly the four Phase 1b routes', () => {
    expect(routes.sort()).toEqual([
      'app/api/organizer/whatsapp-inbox/conversations/[conversationId]/read/route.ts',
      'app/api/organizer/whatsapp-inbox/conversations/[conversationId]/route.ts',
      'app/api/organizer/whatsapp-inbox/conversations/route.ts',
      'app/api/organizer/whatsapp-inbox/unread-count/route.ts',
    ])
  })

  it.each(routes)('%s gates first and takes the organizer only from the gate', r => {
    const src = code(r)
    const body = src.slice(src.search(/export async function (GET|POST)/))
    expect(body.indexOf('await authorizeInbox(req)')).toBeGreaterThan(0)
    expect(body.indexOf('if (!gate.ok) return gate.response')).toBeGreaterThan(body.indexOf('await authorizeInbox(req)'))
    expect(src).toContain('gate.authz.workspaceUid')
    expect(src).not.toMatch(/organizerUid|uid['"]\)|req\.json\(\)/)
  })

  it('reads check ownership and answer another organizer exactly like a missing doc', () => {
    const src = code('lib/whatsapp-inbox/read.ts')
    expect(src).toContain("snap.exists && snap.data()?.organizerUid === workspaceUid ? snap : null")
    expect(src).toContain("if (!snap.exists || snap.data()?.organizerUid !== workspaceUid) return 'not_found' as const")
    expect(src.match(/where\('organizerUid', '==', workspaceUid\)/g)?.length).toBe(2)
  })
})

describe('the page only asks for data it can show', () => {
  const ui = code('app/(dashboard)/dashboard/inbox/InboxClient.tsx')
  it('no Inbox request while the flag is off or the caller lacks broadcasts', () => {
    expect(ui).toContain("const inboxUsable = flags.whatsappInbox && !perms.loading && perms.has('broadcasts')")
    expect(ui).toContain('if (!inboxUsable) return')                              // list
    expect(ui).toContain('if (!selectedId || !inboxUsable) return')              // detail
    expect(ui).toContain("if (gate !== 'ok' || !inboxUsable) return")             // polling
  })
  it('permission is decided before the flag (matches the API: 403 before 404)', () => {
    expect(ui.indexOf("You don’t have access to the Inbox")).toBeLessThan(ui.indexOf('The Inbox isn’t switched on yet'))
  })
  it('the flag is not judged until the platform configuration has loaded (no "switched off" flash)', () => {
    // While BusinessConfigProvider is loading, useFeatureFlags() returns the CODE DEFAULTS
    // (whatsappInbox: false) — deciding then would show "not switched on" where it IS on.
    expect(ui).toContain('const configLoading = useBusinessConfig().loading')
    expect(ui.indexOf('if (configLoading)')).toBeGreaterThan(0)
    expect(ui.indexOf('if (configLoading)')).toBeLessThan(ui.indexOf('if (!flags.whatsappInbox || gate === \'disabled\')'))
  })
  it('the disabled state does not send organizers to a per-workspace setting that does not exist', () => {
    expect(read('app/(dashboard)/dashboard/inbox/InboxClient.tsx')).not.toContain('enabled for your workspace')
  })
})

describe('reply composer — Coming Soon, not implemented', () => {
  const ui = read('app/(dashboard)/dashboard/inbox/InboxClient.tsx')

  it('is rendered disabled and labelled Coming Soon', () => {
    // Phase 1c moved the composer into the shared parts module; the organizer page renders it.
    expect(ui).toContain('<ComingSoonComposer />')
    const parts = read('components/whatsapp-inbox/InboxParts.tsx')
    const composer = parts.slice(parts.indexOf('export function ComingSoonComposer'))
    expect(composer).toContain('Coming Soon')
    expect(composer.match(/\bdisabled\b/g)?.length).toBeGreaterThanOrEqual(2)
    expect(composer).not.toMatch(/onClick|onSubmit|onChange/)
  })

  it('the only write the page makes is mark-as-read', () => {
    const posts = ui.match(/method: '(POST|PUT|PATCH|DELETE)'/g) ?? []
    expect(posts).toEqual(["method: 'POST'"])
    expect(ui).toMatch(/whatsapp-inbox\/conversations\/\$\{encodeURIComponent\(id\)\}\/read`, \{ method: 'POST' \}/)
    expect(ui).not.toMatch(/\/messages['`]|sendText|sendTemplate/)
  })
})
