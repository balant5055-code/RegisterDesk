// Unit verification for the Organizer Notification Center (Phase H.4.3).
//
// Covers the pure, security-critical piece: the metadata catalog and its
// permission-aware visibility gating (which the feed API and mark-all rely on).
// The write path, feed API, hook and UI import the Firebase Admin/client SDKs
// and are validated by tsc/eslint/next build + manual QA, not this pure harness.
//
// Run: npx tsx scripts/verify-notification-center.ts   (exits non-zero on failure)

import {
  NOTIFICATION_CATEGORIES, categoryMeta, isNotificationCategory,
  canSeeCategory, visibleCategories,
} from '@/lib/notifications/inbox/catalog'
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@/lib/team/types'
import type { NotificationCategory, NotificationSeverity } from '@/lib/notifications/inbox/types'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

const EXPECTED: NotificationCategory[] = [
  'approval', 'payment', 'wallet', 'registration', 'certificate',
  'broadcast', 'settlement', 'system', 'alert',
]
const SEVERITIES: NotificationSeverity[] = ['info', 'success', 'warning', 'error']
const PERM_SET = new Set<string>(ALL_PERMISSIONS)

console.log('── catalog: completeness ──')
check('all 9 categories are supported', NOTIFICATION_CATEGORIES.length === EXPECTED.length)
for (const c of EXPECTED) check(`category '${c}' present`, isNotificationCategory(c))
check('unknown category rejected', !isNotificationCategory('nope'))

console.log('── catalog: every meta is valid & metadata-driven ──')
for (const c of NOTIFICATION_CATEGORIES) {
  const m = categoryMeta(c)
  check(`'${c}' has an iconKey`,          typeof m.iconKey === 'string' && m.iconKey.length > 0)
  check(`'${c}' has a label`,            typeof m.label === 'string' && m.label.length > 0)
  check(`'${c}' severity valid`,          SEVERITIES.includes(m.defaultSeverity))
  check(`'${c}' visibility valid`,        m.visibility === null || PERM_SET.has(m.visibility))
}

console.log('── permission gating: owner sees everything ──')
const ownerPerms = [...ROLE_PERMISSIONS.owner]
check('owner sees all categories', visibleCategories(ownerPerms).length === EXPECTED.length)
for (const c of EXPECTED) check(`owner sees '${c}'`, canSeeCategory(c, ownerPerms))

console.log('── permission gating: finance member is scoped ──')
const financePerms = [...ROLE_PERMISSIONS.finance]   // wallet, settlements, transactions
check('finance sees wallet',        canSeeCategory('wallet', financePerms))
check('finance sees settlement',    canSeeCategory('settlement', financePerms))
check('finance sees system (open)', canSeeCategory('system', financePerms))
check('finance sees alert (open)',  canSeeCategory('alert', financePerms))
check('finance does NOT see approval',     !canSeeCategory('approval', financePerms))
check('finance does NOT see registration', !canSeeCategory('registration', financePerms))
check('finance does NOT see payment',      !canSeeCategory('payment', financePerms))
check('finance does NOT see certificate',  !canSeeCategory('certificate', financePerms))
check('finance does NOT see broadcast',    !canSeeCategory('broadcast', financePerms))

console.log('── permission gating: check-in staff sees only open categories ──')
const checkinPerms = [...ROLE_PERMISSIONS.checkin_staff]  // checkin, participants
const checkinVisible = visibleCategories(checkinPerms).sort()
check('check-in staff sees exactly [alert, system]', checkinVisible.join(',') === 'alert,system')

console.log('── permission gating: manager sees ops categories, not finance ──')
const managerPerms = [...ROLE_PERMISSIONS.manager]  // events, registrations, checkin, participants
check('manager sees approval',       canSeeCategory('approval', managerPerms))
check('manager sees registration',   canSeeCategory('registration', managerPerms))
check('manager sees payment',        canSeeCategory('payment', managerPerms))
check('manager does NOT see wallet',      !canSeeCategory('wallet', managerPerms))
check('manager does NOT see settlement',  !canSeeCategory('settlement', managerPerms))

console.log('')
if (failures > 0) { console.error(`❌ ${failures} assertion(s) FAILED`); process.exit(1) }
console.log('✅ All Notification Center catalog assertions passed')
