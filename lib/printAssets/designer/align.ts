// PA-9 S3 alignment — now backed by the SHARED Designer Core (GA-6 S2). This file is
// a thin re-export kept for backward compatibility with existing importers; the real
// (generalized) implementation lives in lib/designer/align.ts and is shared with the
// Certificate Builder. No behaviour change for print templates.

import type { PrintElement } from '@/lib/printAssets/types'
export { alignPatches, type AlignOp } from '@/lib/designer/align'

/** Back-compat alias — the print designer applies patches as Partial<PrintElement>. */
export interface ElPatch { id: string; patch: Partial<PrintElement> }
