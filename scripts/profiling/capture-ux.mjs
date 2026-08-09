/* RD-EVENT-18 — captures Event Builder screenshots for UX audit. DEV TOOL ONLY.
 *
 *   npm run emu:shots
 *
 * Emulator-only. Writes PNGs to e2e/.shots/<viewport>/<step>.png.
 *
 * Clearing `rd_event_draft_snapshot` matters: a stale crash-recovery snapshot from an
 * earlier run conflicts with the freshly re-seeded draft (whose updatedAt is a fixed past
 * date), which makes the wizard render DraftRecoveryPrompt instead of the step. That is a
 * real product behaviour, not a bug — but it is not what we are auditing.
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// Each viewport must start from step 0. Advancing the wizard autosaves `currentStep`, so
// without this reset the second viewport resumes where the first stopped — and a step that
// does not render the "Step N of M" marker then hangs the initial wait.
initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk' })
const adminDb = getFirestore()
const DRAFT_DOC = 'users/profiling-organizer-uid/eventDrafts/profiling-draft-event'
const resetStep = () => adminDb.doc(DRAFT_DOC).update({ currentStep: 0 })

const BASE = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'
const EMAIL = process.env.RD_PROFILE_EMAIL
const PASSWORD = process.env.RD_PROFILE_PASSWORD

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
]

const STEPS = ['event-type', 'visibility', 'access', 'pricing', 'form', 'details', 'license', 'review']

const INIT = `
try {
  localStorage.setItem('rd_event_draft_id', 'profiling-draft-event')
  localStorage.removeItem('rd_event_draft_snapshot')
} catch {}
`

const stepIndex = page => page.evaluate(() => {
  const m = document.body.innerText.match(/Step (\d+) of (\d+)/)
  return m ? Number(m[1]) - 1 : -1
})

async function run() {
  const browser = await chromium.launch()
  for (const vp of VIEWPORTS) {
   try {
    await resetStep()
    const dir = `e2e/.shots/${vp.name}`
    mkdirSync(dir, { recursive: true })
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    await page.addInitScript(INIT)

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.locator('#login-email').fill(EMAIL)
    await page.locator('#login-password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in to dashboard/i }).click()
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 })

    await page.goto(`${BASE}/dashboard/events/new`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => /Step \d+ of \d+/.test(document.body.innerText), undefined, { timeout: 30_000 })

    for (let i = 0; i < STEPS.length; i++) {
      const at = await stepIndex(page)
      // Capture regardless: a step that no longer reports its index is exactly the kind of
      // thing this audit needs to see, not a reason to stop.
      if (at !== i) console.log(`  ${vp.name}: step marker says ${at}, expected ${i} — capturing anyway`)
      // Scroll to top first: the wizard restores scroll position between steps, and a
      // fullPage capture of a scrolled page stitches sticky chrome into the middle of the
      // image — which reads as a layout bug that is not there.
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#main-content')?.scrollTo(0, 0) })
      await page.waitForTimeout(700)   // let entry animation settle
      // Viewport-sized: this is what the organizer actually sees on arriving at the step.
      await page.screenshot({ path: `${dir}/${i}-${STEPS[i]}.png` })
      await page.screenshot({ path: `${dir}/${i}-${STEPS[i]}-full.png`, fullPage: true })
      console.log(`  ${vp.name}/${i}-${STEPS[i]}.png`)

      if (i === STEPS.length - 1) break
      const next = page.getByRole('button', { name: /continue|next|save & continue/i }).last()
      if (!(await next.isEnabled().catch(() => false))) { console.log(`  ${vp.name}: Continue disabled at ${i}`); break }
      await next.click()
      await page.waitForFunction(n => {
        const m = document.body.innerText.match(/Step (\d+) of (\d+)/)
        return m ? Number(m[1]) - 1 !== n : false
      }, i, { timeout: 30_000 }).catch(() => {})
    }
    await ctx.close()
   } catch (e) { console.log(`  ${vp.name}: aborted — ${e.message.split(String.fromCharCode(10))[0]}`) }
  }
  await browser.close()
}

if (!EMAIL || !PASSWORD) { console.error('RD_PROFILE_EMAIL / RD_PROFILE_PASSWORD required'); process.exit(2) }
run().catch(e => { console.error(e.message); process.exit(1) })
