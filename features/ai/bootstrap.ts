// RD-AI-01 · Assembly.
//
// THE ONE FILE where the generic pipeline meets a concrete capability.
//
// The dependency direction everywhere else is capability → pipeline. Here it inverts, on
// purpose and in isolation: this file knows every capability, and no other file in
// `features/ai` knows any of them. It is the same shape as `BUILT_IN_PROVIDERS` in
// `providers/registry.ts` — assembly at the edge, so the core stays ignorant.
//
// Every server entry point that can cause a result to be produced calls `bootstrapAI()`
// first. It is idempotent and free after the first call.

import { registerResultConsumer } from '@/features/ai/services/consumers'
import { BIB_DETECT_KIND } from '@/features/bib-detection/types'
import { consumeBibDetectionResult } from '@/features/bib-detection/services/detectionService'

let done = false

export function bootstrapAI(): void {
  if (done) return
  done = true

  // RD-BIB-01 — bib detection. The consumer returns an outcome the dispatcher ignores; the
  // registry's contract is `Promise<void>`, and the return value exists for direct callers
  // (`rematchAsset`) and for tests.
  registerResultConsumer(BIB_DETECT_KIND, async ctx => { await consumeBibDetectionResult(ctx) })
}
