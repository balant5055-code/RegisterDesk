// RD-EVENT-14 · Drives the RD-EVENT-07 console harness from Playwright. DEV TOOLING ONLY.
//
// The harness at `scripts/profiling/event-builder-profiler.js` is the SINGLE source of the
// measurement logic. It is read from disk and evaluated in the page rather than
// reimplemented here, so a manual console session and an automated run always compute the
// same numbers. Duplicating it would let the two silently diverge.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'

export const HARNESS_PATH = 'scripts/profiling/event-builder-profiler.js'

/** The six scenarios RD-EVENT-06 defined; the harness rejects unknown labels. */
export const SCENARIOS = [
  'basic-info-typing',
  'event-type-selection',
  'pricing-edits',
  'registration-form-edits',
  'branding-changes',
  'step-navigation',
] as const

export type ScenarioName = typeof SCENARIOS[number]

/** One captured run — the shape `__rd.stop()` returns. */
export interface ProfileResult {
  label: string
  capturedAt: string
  mode: 'development' | 'production' | 'unknown'
  durationMs: number
  commits: number
  keystrokes: number
  commitsPerKeystroke: number | null
  componentsRendered: number
  totalComponentRenders: number
  renderMs: Stat
  stringify: Stat & { kb: number }
  localStorage: Stat & { kb: number }
  autosave: { cycles: number; settleMs: Stat; keystrokeToSavingMs: Stat }
  contributors: { component: string; renders: number; selfMs: number }[]
}

export interface Stat { n: number; total: number; avg: number; max: number }

/** Evaluates the harness in the page. Call once per page, after navigation. */
export async function installHarness(page: Page): Promise<void> {
  const source = readFileSync(resolve(process.cwd(), HARNESS_PATH), 'utf8')
  await page.evaluate(source)
  const ready = await page.evaluate(() => typeof (window as unknown as { __rd?: unknown }).__rd !== 'undefined')
  if (!ready) {
    throw new Error(
      'Harness failed to install. The most common cause is a missing DevTools hook — it must ' +
      'be added with addInitScript BEFORE any app script runs. See e2e/profiling/devtools-hook.ts.',
    )
  }
}

/**
 * Runs one scenario end to end.
 *
 * `act` performs the interaction. Everything inside it is measured, so it should contain the
 * interaction and nothing else — no navigation, no waiting for unrelated state.
 */
export async function capture(
  page: Page,
  label: ScenarioName,
  act: () => Promise<void>,
): Promise<ProfileResult> {
  await page.evaluate(l => (window as unknown as { __rd: { start(l: string): void } }).__rd.start(l), label)
  await act()
  // Autosave settles on a 1,000 ms debounce. Without this the capture ends before the write,
  // and `autosave.cycles` reads 0 — an artefact of stopping early, not of the application.
  await page.waitForTimeout(2_000)
  return page.evaluate(() => (window as unknown as { __rd: { stop(): ProfileResult } }).__rd.stop())
}

/** Types one character at a time so each keystroke is a separate React commit. */
export async function typeSteadily(page: Page, selector: string, text: string): Promise<void> {
  const field = page.locator(selector).first()
  await field.click()
  // `delay` matters: typing with no delay batches updates and understates commit counts.
  await field.pressSequentially(text, { delay: 60 })
}

/**
 * Fails a run whose numbers cannot be compared to a baseline.
 *
 * A development capture is the trap this guards: React double-invokes render bodies under
 * StrictMode and inflates every duration, so the run looks meaningful but is not.
 */
export function assertComparable(result: ProfileResult): void {
  if (result.mode !== 'production') {
    throw new Error(
      `Captured in "${result.mode}" mode — not a valid baseline.\n` +
      '  Run: npm run profile:build && npm run profile:serve',
    )
  }
}
