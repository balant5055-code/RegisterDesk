// RD-EVENT-14 · Navigating the Event Builder for profiling. DEV TOOLING ONLY.
//
// Every helper drives the real UI. Nothing here seeds Firestore directly or manipulates a
// draft behind the application's back — a draft created by a side channel may not match what
// the builder produces, and profiling it would measure a state users never reach.
//
// ═══ WHY DRAFT SIZE IS A PARAMETER ═══════════════════════════════════════════
// `writeSnapshot` serialises the WHOLE draft, so a baseline captured on an empty draft does
// not compare to one captured on a full event. `describeDraft` records the shape so a
// baseline carries its own context.

import type { Page } from '@playwright/test'

export const BUILDER_PATH = '/dashboard/events/new'

/** The seeded draft, from scripts/emulator/seed.mjs. */
export const SEEDED_DRAFT_ID = 'profiling-draft-event'

/**
 * localStorage key `useDraft` reads to find the active draft (`lib/hooks/useDraft.ts`).
 *
 * Without this, a fresh browser context has no draft id and the builder CREATES a new empty
 * draft instead of loading the seeded one — every Continue gate is then unsatisfied and the
 * wizard cannot be advanced. Seeding Firestore is necessary but not sufficient; the browser
 * has to be told which draft is active.
 */
export const DRAFT_ID_KEY = 'rd_event_draft_id'

/** Init script that points the app at the seeded draft. MUST run before any app script. */
export const SEED_DRAFT_INIT_SCRIPT =
  `try { localStorage.setItem('${DRAFT_ID_KEY}', '${SEEDED_DRAFT_ID}') } catch {}`

/** Step indices for the standard (non-fundraising) flow — see lib/events/builder/stepRegistry.ts. */
export const STEP = {
  eventType: 0, visibility: 1, access: 2, pricing: 3, form: 4, details: 5, license: 6, review: 7,
} as const

/** Opens the builder and waits for hydration to finish. */
export async function openBuilder(page: Page): Promise<void> {
  await page.goto(BUILDER_PATH, { waitUntil: 'domcontentloaded' })
  // The wizard renders a loading skeleton with aria-busy while the draft is fetched.
  // Waiting for it to disappear avoids measuring hydration as if it were interaction.
  await page.waitForSelector('[aria-busy="true"]', { state: 'detached', timeout: 30_000 })
    .catch(() => { /* already hydrated before the check ran */ })
  // Read from document text rather than a locator. `getByText(...).waitFor({state:'visible'})`
  // hangs here: several elements match, and the first one Playwright resolves is not the
  // visible footer line. Body text is unambiguous and is what actually proves the wizard
  // rendered.
  await page.waitForFunction(
    () => /Step \d+ of \d+/.test(document.body.innerText),
    undefined,
    { timeout: 30_000 },
  )
}

/** Reads the current step from the footer's "Step N of M" context line. */
export async function currentStep(page: Page): Promise<number> {
  const n = await page.evaluate(() => {
    const m = document.body.innerText.match(/Step (\d+) of (\d+)/)
    return m ? Number(m[1]) - 1 : -1
  })
  return n
}

/** Advances one step via the footer's primary action, waiting for the step to actually change. */
export async function clickContinue(page: Page): Promise<void> {
  const before = await currentStep(page)
  await page.getByRole('button', { name: /continue|next|save & continue/i }).last().click()
  await page.waitForFunction(
    n => {
      const m = document.body.innerText.match(/Step (\d+) of (\d+)/)
      return m ? Number(m[1]) - 1 !== n : false
    },
    before,
    { timeout: 30_000 },
  )
}

/** Walks forward to a target step, filling only what each gate requires. */
export async function advanceTo(page: Page, target: number): Promise<void> {
  let guard = 0
  while ((await currentStep(page)) < target) {
    if (guard++ > 12) throw new Error(`Stuck advancing to step ${target} — a gate is unsatisfied.`)
    await satisfyCurrentStep(page)
    await clickContinue(page)
  }
}

/**
 * Makes the minimum selection the current step's Continue gate demands.
 *
 * The rules mirror `lib/events/builder/stepValidation.ts` — this does not reimplement them,
 * it performs the cheapest UI action that satisfies each one.
 */
async function satisfyCurrentStep(page: Page): Promise<void> {
  // The seeded draft (scripts/emulator/seed.mjs) already satisfies every Continue gate, so
  // the correct action is almost always NO action.
  //
  // An earlier version clicked "the first option that isn't Continue/Back/Save" on every
  // step. That actively BROKE the gates: on Event Type it replaced the seeded
  // sports/marathon pair with a different category that has no subtype, so `hasValidSubtype`
  // went false and Continue became permanently disabled. Never disturb valid state.
  if (await continueEnabled(page)) return

  // Only if the gate is genuinely unsatisfied, pick an option from the step's content area.
  // Scoped to `main` so sidebar and top-bar controls can never be mistaken for step options.
  const option = page.locator('main').getByRole('button')
    .filter({ hasNotText: /continue|back|save|skip|cancel/i }).first()
  await option.click({ timeout: 5_000 }).catch(() => { /* nothing selectable — let the caller fail */ })
}

/** Whether the footer's primary action is currently clickable. */
async function continueEnabled(page: Page): Promise<boolean> {
  const btn = page.getByRole('button', { name: /continue|next|save & continue/i }).last()
  return btn.isEnabled({ timeout: 5_000 }).catch(() => false)
}

/** Records the draft's shape, so a baseline states what it was measured against. */
export async function describeDraft(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('rd_event_draft_snapshot')
      if (!raw) return { available: false }
      const snap = JSON.parse(raw) as { draft?: Record<string, unknown> }
      const d = snap.draft ?? {}
      const pricing = d.pricing as { passes?: unknown[] } | null
      const form = d.registrationForm as { fields?: unknown[] } | null
      return {
        available: true,
        passes: pricing?.passes?.length ?? 0,
        fields: form?.fields?.length ?? 0,
        snapshotBytes: raw.length,
      }
    } catch { return { available: false } }
  })
}
