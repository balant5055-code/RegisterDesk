// Run work AFTER the HTTP response, without losing it. SERVER-ONLY.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// A `void someAsyncSend()` started inside a route is NOT guaranteed to finish on Vercel: once the
// response is returned the function instance can be frozen, and the detached promise only resumes
// if a LATER request happens to reuse that instance — or never. Production evidence (2026-10-26):
// an attendee WhatsApp confirmation reached Meta 2.5 minutes late inside an unrelated request, and
// two others never ran at all (no hold, no status, no log), although capacity was available.
//
// Next's `after()` registers the work with the request lifecycle (Vercel `waitUntil`), so the
// platform keeps the function alive until it completes — and the response is not delayed.
//
// ═══ OUTSIDE A REQUEST ═══════════════════════════════════════════════════════
// `after()` throws when there is no request scope (scripts, tests, direct calls). Detaching there
// would recreate the bug, so the work is AWAITED inline instead: the caller's own lifetime then
// covers it.
//
// The task must never throw into the caller (registration/settlement already succeeded): any
// error is caught and logged by label only — never with a payload, phone number or token.

import { after } from 'next/server'

export type AfterResponseMode = 'scheduled' | 'inline'

async function runSafely(label: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
  } catch (err) {
    console.error(`[after-response] ${label} failed:`, err instanceof Error ? err.message : 'error')
  }
}

/**
 * Schedule `task` to run after the response (inside a request), or run it to completion now
 * (outside one). Resolves when the task is safely scheduled or has finished; never rejects.
 */
export async function runAfterResponse(label: string, task: () => Promise<unknown>): Promise<AfterResponseMode> {
  try {
    after(() => runSafely(label, task))
    return 'scheduled'
  } catch {
    // No request scope — keep the work attached to the caller.
    await runSafely(label, task)
    return 'inline'
  }
}
