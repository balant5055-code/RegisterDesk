// RD-EVENT-14 · The five profiling scenarios, automated. DEV TOOLING ONLY.
//
// Each test captures ONE scenario and writes a machine-readable JSON file to
// `e2e/.results/`. Those files are the baseline artefacts — `npm run profile:compare` diffs
// two directories of them.
//
// These are not assertions about correctness. They fail only when a run cannot produce
// VALID data: a development build, a missing harness, an unreachable step. A slow render is
// data, not a failure — thresholds belong in the comparison step, not here.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEVTOOLS_HOOK_INIT_SCRIPT } from './profiling/devtools-hook'
import { installHarness, capture, typeSteadily, assertComparable, type ProfileResult } from './profiling/harness'
import { ensureLoggedIn } from './profiling/auth'
import { openBuilder, advanceTo, clickContinue, describeDraft, STEP, SEED_DRAFT_INIT_SCRIPT } from './profiling/builder'

const OUT_DIR = process.env.RD_PROFILE_OUT ?? 'e2e/.results/current'

function save(result: ProfileResult, draft: Record<string, unknown>) {
  mkdirSync(resolve(process.cwd(), OUT_DIR), { recursive: true })
  const payload = { ...result, draft }
  writeFileSync(resolve(process.cwd(), OUT_DIR, `${result.label}.json`), JSON.stringify(payload, null, 2))
  console.log(
    `${result.label}: commits=${result.commits} perKeystroke=${result.commitsPerKeystroke} ` +
    `components=${result.componentsRendered} renderMs=${result.renderMs.total} ` +
    `stringify=${result.stringify.n} localStorage=${result.localStorage.n}`,
  )
}

// The DevTools hook MUST be installed before any application script — see devtools-hook.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(DEVTOOLS_HOOK_INIT_SCRIPT)
  // Point the app at the seeded draft; without it the builder creates a fresh empty one.
  await page.addInitScript(SEED_DRAFT_INIT_SCRIPT)
  await ensureLoggedIn(page)
})

test('basic-info-typing', async ({ page }) => {
  await openBuilder(page)
  await advanceTo(page, STEP.details)
  await installHarness(page)
  const result = await capture(page, 'basic-info-typing', async () => {
    await typeSteadily(page, 'input[name="name"], #event-name, input[placeholder*="name" i]', 'City Marathon 2026')
  })
  assertComparable(result)
  save(result, await describeDraft(page))
})

test('event-type-selection', async ({ page }) => {
  await openBuilder(page)
  await installHarness(page)
  const result = await capture(page, 'event-type-selection', async () => {
    // The control scenario: no autosave wiring on this step, so commits should track clicks.
    const options = page.getByRole('button').filter({ hasNotText: /continue|back|save/i })
    for (let i = 0; i < 3; i++) await options.nth(i).click({ timeout: 10_000 }).catch(() => {})
  })
  assertComparable(result)
  save(result, await describeDraft(page))
})

test('pricing-edits', async ({ page }) => {
  await openBuilder(page)
  await advanceTo(page, STEP.pricing)
  await installHarness(page)
  const result = await capture(page, 'pricing-edits', async () => {
    await typeSteadily(page, 'input[type="number"], input[inputmode="numeric"]', '1500')
  })
  assertComparable(result)
  save(result, await describeDraft(page))
})

test('registration-form-edits', async ({ page }) => {
  await openBuilder(page)
  await advanceTo(page, STEP.form)
  await installHarness(page)
  const result = await capture(page, 'registration-form-edits', async () => {
    await typeSteadily(page, 'input[type="text"]', 'Emergency contact')
  })
  assertComparable(result)
  save(result, await describeDraft(page))
})

test('step-navigation', async ({ page }) => {
  await openBuilder(page)
  await installHarness(page)
  const result = await capture(page, 'step-navigation', async () => {
    await clickContinue(page)
    await clickContinue(page)
    await page.getByRole('button', { name: /^back$/i }).last().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /^back$/i }).last().click()
  })
  assertComparable(result)
  save(result, await describeDraft(page))
})
