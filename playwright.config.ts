// RD-EVENT-14 · Playwright config — DEV TOOLING ONLY.
//
// This config exists to profile the Event Builder, not to run a functional test suite. Its
// defaults are chosen for MEASUREMENT VALIDITY rather than throughput:
//
//   • workers: 1        — parallel pages compete for CPU and corrupt commit durations
//   • retries: 0        — a retried profiling run is a different run, not a recovered one
//   • no webServer      — the app must be started separately with `next build --profile`,
//                         which this config cannot enforce (see docs)
//
// It deliberately does NOT start the dev server. A development build double-invokes render
// bodies under StrictMode and reports inflated durations; the harness detects and rejects
// that, but it is better not to make it easy to do by accident.

import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: 'e2e',
  // Profiling scenarios include real Firestore writes and a 1s autosave debounce.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['json', { outputFile: 'e2e/.results/last-run.json' }]],
  use: {
    baseURL: BASE_URL,
    // Headless is the default: a visible window adds compositing work to every commit.
    headless: process.env.RD_PROFILE_HEADED !== 'true',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    // A fixed viewport keeps layout — and therefore render cost — comparable across runs.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'profile',
      testMatch: /.*\.profile\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/organizer.json',
      },
    },
  ],
})
