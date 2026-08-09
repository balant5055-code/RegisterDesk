// RD-EVENT-14 · One real login, reused by every profiling run. DEV TOOLING ONLY.

import { test as setup } from '@playwright/test'
import { loginAsOrganizer, saveSession, STORAGE_STATE_PATH } from './profiling/auth'

setup('authenticate organizer', async ({ page, context }) => {
  await loginAsOrganizer(page)
  await saveSession(context)
  console.log(`session saved → ${STORAGE_STATE_PATH}`)
})
