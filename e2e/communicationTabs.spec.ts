// ─── Communication Center tabs, from an event-scoped URL ─────────────────────
//
// RD-COMMS-TABS-01 · production bug 2026-10-27: on /dashboard/communications?eventId=… no tab
// could be switched. The tabs are the URL (?tab=, router.replace); the Overview's links back
// into this same page were PREFETCHED, and in Next 16.2.7 that prefetch — on a page hard-loaded
// WITH a query string — made the router drop every later same-route navigation. A bare URL does
// NOT reproduce it, so every scenario here starts from ?eventId=<seeded event>. The fix is
// prefetch={false} on those links (tests/unit/communicationSamePageLinks.test.ts pins it).
//
// The message-status links ("Review failed", "Investigate", "View queue") only render when the
// organizer has failed / unknown / queued messages, so the spec seeds four emailLogs rows on the
// EMULATOR (refused otherwise) and removes them afterwards.
//
// Run against a production server on the emulator (the app is not started for you):
//   npm run emu:start            # 8080 / 9099 / 9199
//   npm run emu:seed
//   npm run emu:build && npm run emu:serve      # :3187
//   npx dotenv -e .env.emulator -- playwright test --project=comm-tabs

import { test, expect, type Page } from '@playwright/test'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { readCredentials } from './profiling/auth'

const ORGANIZER_UID = 'profiling-organizer-uid'
const EVENT_ID = process.env.RD_COMM_TABS_EVENT_ID ?? 'profiling-draft-event'
const START = `/dashboard/communications?eventId=${EVENT_ID}`

const TABS = [
  { label: 'Messages', tab: 'messages' }, { label: 'Broadcasts', tab: 'broadcasts' },
  { label: 'Reminders', tab: 'reminders' }, { label: 'Templates', tab: 'templates' },
  { label: 'Analytics', tab: 'analytics' }, { label: 'Usage', tab: 'usage' },
  { label: 'Opt-outs', tab: 'optouts' }, { label: 'Overview', tab: null },
] as const

const LOGS = [
  { id: 'e2e-comm-tabs-failed',  status: 'failed' },
  { id: 'e2e-comm-tabs-unknown', status: 'failed', deliveryUnknown: true },
  { id: 'e2e-comm-tabs-queued',  status: 'queued' },
  { id: 'e2e-comm-tabs-sent',    status: 'sent' },
] as const

function emulatorDb() {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  const project = process.env.GCLOUD_PROJECT ?? ''
  if (!host || !project.startsWith('demo-')) {
    throw new Error('comm-tabs seeds Firestore and runs ONLY against the emulator (FIRESTORE_EMULATOR_HOST + a demo- project). Load .env.emulator.')
  }
  return getFirestore(getApps()[0] ?? initializeApp({ projectId: project }))
}

test.beforeAll(async () => {
  const db = emulatorDb()
  const now = Timestamp.now()
  await Promise.all(LOGS.map(({ id, ...row }) => db.doc(`emailLogs/${id}`).set({
    organizerUid: ORGANIZER_UID, eventId: EVENT_ID, eventSlug: '', eventName: 'Comm tabs fixture',
    templateKey: 'registration_confirmation', recipientEmail: 'fixture@registerdesk.test', recipientName: 'Fixture',
    subject: 'Fixture', provider: 'resend', channel: 'email', ...row, createdAt: now, updatedAt: now,
  })))
})

test.afterAll(async () => {
  const db = emulatorDb()
  await Promise.all(LOGS.map(({ id }) => db.doc(`emailLogs/${id}`).delete()))
})

const tabBar = (page: Page) => page.locator('div.border-b').filter({ has: page.getByRole('button', { name: 'Opt-outs', exact: true }) })
const tabButton = (page: Page, label: string) => tabBar(page).getByRole('button', { name: label, exact: true })

async function activeTab(page: Page): Promise<string[]> {
  return tabBar(page).getByRole('button').evaluateAll(bs => bs.filter(b => b.className.includes('border-primary')).map(b => b.textContent ?? ''))
}

/** Hard-loads the event-scoped URL and waits until the same-page links (the bug's trigger) are on screen. */
async function openEventScoped(page: Page) {
  await page.goto(START, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Communication Center' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('a[href="/dashboard/communications?tab=usage"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: /Review failed/ })).toBeVisible({ timeout: 30_000 })
  // Give any viewport prefetch time to run — the failure only appeared after it had.
  await page.waitForTimeout(2_000)
}

async function expectTab(page: Page, label: string, tab: string | null) {
  await expect.poll(() => new URL(page.url()).searchParams.get('tab'), { message: `?tab= after ${label}` }).toBe(tab)
  expect(new URL(page.url()).searchParams.get('eventId'), 'the event scope is kept').toBe(EVENT_ID)
  await expect.poll(() => activeTab(page), { message: `active tab after ${label}` }).toEqual([label])
}

// The sign-in button has no stable accessible name, so submit the form once the email field has
// hydrated (a click before hydration is a plain HTML submit that never signs in).
test.beforeEach(async ({ page }) => {
  const { email, password } = readCredentials()
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Object.keys(document.querySelector('#login-email') ?? {}).some(k => k.startsWith('__react')), undefined, { timeout: 60_000 })
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  await page.locator('form button[type=submit]').first().click()
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 })
})

test('every tab switches from an event-scoped URL', async ({ page }) => {
  await openEventScoped(page)
  expect(await activeTab(page)).toEqual(['Overview'])
  for (const { label, tab } of TABS) {
    await tabButton(page, label).click()
    await expectTab(page, label, tab)
  }
})

for (const { link, status } of [
  { link: /Review failed/, status: 'failed' },
  { link: /Investigate/,   status: 'unknown' },
  { link: /View queue/,    status: 'queued' },
] as const) {
  test(`"${link.source}" opens Messages filtered by ${status}, and the tabs keep working`, async ({ page }) => {
    await openEventScoped(page)
    await page.getByRole('link', { name: link }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('msgStatus')).toBe(status)
    await expect.poll(() => activeTab(page)).toEqual(['Messages'])
    await tabButton(page, 'Broadcasts').click()
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('broadcasts')
    await expect.poll(() => activeTab(page)).toEqual(['Broadcasts'])
  })
}
