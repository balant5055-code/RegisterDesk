// Unit verification for the Global Command Palette (Phase H.4.2).
//
// Covers the two pure, business-logic pieces: the fuzzy matcher and the command
// registry builders. The React component / hook are exercised manually (keyboard
// + network) and are out of scope for this pure-assertion harness.
//
// Run: npx tsx scripts/verify-command-palette.ts   (exits non-zero on any failure)

import { fuzzyScore, fuzzyMatches, rankBy } from '@/lib/commandPalette/fuzzy'
import {
  buildNavigationCommands, buildEventTabCommands, buildEventActionCommands,
  availableEventActions, commandStrings,
} from '@/lib/commandPalette/registry'
import { EVENT_TABS } from '@/lib/events/eventTabs'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

// ─── Fuzzy matcher ────────────────────────────────────────────────────────────

console.log('── fuzzy: exact / prefix / subsequence ordering ──')
check('exact match beats prefix',        fuzzyScore('registrations', 'Registrations')! > fuzzyScore('reg', 'Registrations')!)
check('empty query scores 0',            fuzzyScore('', 'anything') === 0)
check('no target → null',                fuzzyScore('x', '') === null)
check('non-subsequence → null',          fuzzyScore('zzz', 'Registrations') === null)
check('prefix matches',                  fuzzyMatches('reg', 'Registrations'))
check('scattered subsequence matches',   fuzzyMatches('rgs', 'Registrations'))
check('case-insensitive',                fuzzyMatches('REG', 'registrations'))

console.log('── fuzzy: word-boundary + tightness bonuses ──')
// "wallet" should rank the Wallet command above an incidental subsequence hit.
check('boundary hit outranks scattered', fuzzyScore('wal', 'Wallet · Usage')! > fuzzyScore('wal', 'Withdrawal appeal')!)
// shorter prefix target wins over a longer one
check('shorter prefix ranks higher',     fuzzyScore('re', 'Reports')! > fuzzyScore('re', 'Registrations settings')!)

console.log('── fuzzy: rankBy ──')
const items = [
  { t: ['Registrations'] }, { t: ['Reports'] }, { t: ['Wallet'] }, { t: ['Certificates'] },
]
const ranked = rankBy('reg', items, i => i.t)
check('rankBy drops non-matches',        ranked.length === 1 && ranked[0]!.t[0] === 'Registrations')
check('rankBy empty query keeps all',    rankBy('', items, i => i.t).length === items.length)
check('rankBy stable order on ties',     rankBy('', items, i => i.t)[0]!.t[0] === 'Registrations')

// ─── Navigation commands (derived from the existing IA) ───────────────────────

console.log('── registry: navigation commands ──')
const nav = buildNavigationCommands()
const navHrefs = new Set(nav.map(c => c.href))
check('every nav command is a navigate',   nav.every(c => c.kind === 'navigate' && !!c.href))
for (const href of [
  '/dashboard', '/dashboard/events', '/dashboard/registrations',
  '/dashboard/communications/certificates', '/dashboard/wallet', '/dashboard/reports',
  '/dashboard/communications', '/dashboard/settings', '/dashboard/check-in',
  '/dashboard/registrations?status=pending',
]) check(`nav includes ${href}`, navHrefs.has(href))
check('no duplicate (href+title) commands', new Set(nav.map(c => `${c.href}::${c.title}`)).size === nav.length)
check('support docs command opens new tab', nav.some(c => c.href === '/resources' && c.newTab === true))
check('nav commands are searchable',        nav.every(c => commandStrings(c).length > 0))
check('nav builder is cached (stable ref)', buildNavigationCommands() === nav)

// ─── Event tab commands (deep-link into ManageEventClient) ────────────────────

console.log('── registry: event-tab commands ──')
const genericTabs = buildEventTabCommands('evt_1', 'conference', 'My Conf')
// 18 total tabs minus the two gated ones (exhibition, nominations) = 16
check('generic event hides gated tabs',   genericTabs.length === EVENT_TABS.length - 2)
check('every tab command targets event',  genericTabs.every(c => c.kind === 'event-tab' && c.eventId === 'evt_1' && !!c.tab && !c.href))
check('exhibition tab only for exhibition', buildEventTabCommands('e', 'exhibition').some(c => c.tab === 'exhibition'))
check('awards event shows nominations',     buildEventTabCommands('e', 'awards').some(c => c.tab === 'nominations'))
check('conference hides nominations',       !genericTabs.some(c => c.tab === 'nominations'))
check('identifiers tab present (sports key)', genericTabs.some(c => c.tab === 'sports' && c.title.includes('Identifiers')))

// ─── Event action commands (reuse existing routes; server authoritative) ──────

console.log('── registry: event-action availability ──')
check('published → close/unpublish/complete/cancel/duplicate',
  ['close_registrations', 'unpublish', 'complete', 'cancel', 'duplicate']
    .every(a => availableEventActions('published').includes(a as never)))
check('published does NOT expose reopen',   !availableEventActions('published').includes('reopen_registrations' as never))
check('registration_closed → reopen+cancel', ['reopen_registrations', 'cancel', 'duplicate']
    .every(a => availableEventActions('registration_closed').includes(a as never)))
check('completed → archive+duplicate only',  availableEventActions('completed').sort().join(',') === 'archive,duplicate')
check('cancelled → archive+duplicate only',  availableEventActions('cancelled').sort().join(',') === 'archive,duplicate')
check('archived → duplicate only',           availableEventActions('archived').join(',') === 'duplicate')
check('draft → duplicate only',              availableEventActions('draft').join(',') === 'duplicate')

console.log('── registry: event-action command shape ──')
const pubActions = buildEventActionCommands('evt_1', 'published', 'My Event')
check('all actions require the events permission', pubActions.every(c => c.permission === 'events'))
check('all actions carry the eventId',             pubActions.every(c => c.eventId === 'evt_1' && c.kind === 'event-action'))
const byAction = new Map(pubActions.map(c => [c.action, c]))
check('reversible: unpublish not destructive',  byAction.get('unpublish')!.destructive !== true)
check('reversible: close not destructive',      byAction.get('close_registrations')!.destructive !== true)
check('reversible: duplicate not destructive',  byAction.get('duplicate')!.destructive !== true)
check('destructive: cancel is routed',          byAction.get('cancel')!.destructive === true)
check('destructive: complete is routed',        byAction.get('complete')!.destructive === true)
check('archived actions = duplicate only',      buildEventActionCommands('e', 'archived').map(c => c.action).join(',') === 'duplicate')

console.log('')
if (failures > 0) { console.error(`❌ ${failures} assertion(s) FAILED`); process.exit(1) }
console.log('✅ All Global Command Palette assertions passed')
