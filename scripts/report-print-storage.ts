// RD-PRINT-P0 · READ-ONLY report of print output stored before on-demand rendering.
//
//   npx tsx scripts/report-print-storage.ts            # report only — WRITES NOTHING
//   npx tsx scripts/report-print-storage.ts --json     # same, machine-readable
//
// Lists `printAssets/` and `printPackages/` objects (names + metadata only — no object is
// downloaded) and counts the Firestore print records that still reference them or still
// carry a legacy attendee copy. Prints COUNTS and BYTES only: no paths, no URLs, no
// download tokens, no attendee data. It never deletes or rewrites anything; deletion is a
// separate, reviewed step (see the RD-PRINT-P0 cleanup plan).
//
// Production use requires explicit, separate approval of this read-only run.

import { inventoryLegacyPrintOutputs } from '@/lib/printAssets/legacyInventory'

const JSON_OUT = process.argv.includes('--json')

async function main() {
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator:${process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'}`
    : (() => {
        try {
          const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY ?? '', 'base64').toString('utf-8')) as { project_id?: string }
          return sa.project_id ?? 'unknown'
        } catch { return 'unknown' }
      })()
  const report = { target, ...(await inventoryLegacyPrintOutputs()) }
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return }
  console.log('Legacy print output inventory (READ-ONLY — nothing was written or deleted)')
  console.log(JSON.stringify(report, null, 2))
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
