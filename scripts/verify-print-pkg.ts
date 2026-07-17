// PA-6 verification — ZIP writer round-trip, xlsx refactor parity, package filters.
// Run: npx --yes tsx scripts/verify-print-pkg.ts   (no Firebase needed)

import { buildStoredZip, crc32, type ZipEntry } from '../lib/zip/store'
import { tablesToXlsx } from '../lib/reports/xlsx'
import { selectPackageItems } from '../lib/printAssets/packageJob'
import type { PrintJobItem } from '../lib/printAssets/generationJob'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

// Minimal STORED-zip reader: walk local headers, extract data, verify CRC.
function readStoredZip(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = []
  let p = 0
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method  = buf.readUInt16LE(p + 8)
    const crc     = buf.readUInt32LE(p + 14)
    const size    = buf.readUInt32LE(p + 22)
    const nameLen = buf.readUInt16LE(p + 26)
    const extra   = buf.readUInt16LE(p + 28)
    const name    = buf.slice(p + 30, p + 30 + nameLen).toString('utf8')
    const dataAt  = p + 30 + nameLen + extra
    const data    = buf.slice(dataAt, dataAt + size)
    if (method !== 0) throw new Error('expected STORED method')
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`)
    out.push({ name, data })
    p = dataAt + size
  }
  return out
}

function item(p: Partial<PrintJobItem> & { registrationId: string }): PrintJobItem {
  return {
    registrationId: p.registrationId, name: '', email: '', phone: '', ticketCode: '',
    qrValue: '', company: '', designation: '', category: p.category ?? '',
    bibNumber: p.bibNumber ?? '',
    passId: p.passId ?? '', passName: p.passName ?? '', formResponses: {},
    output: p.output,
  }
}

function main() {
  // ── ZIP round-trip ──
  const a = Buffer.from('%PDF-1.4 fake badge A\n')
  const b = Buffer.from('%PDF-1.4 fake badge B — longer content here\n')
  const entries: ZipEntry[] = [{ name: 'badge-A.pdf', data: a }, { name: 'badge-B.pdf', data: b }]
  const zip = buildStoredZip(entries)
  check('ZIP starts with PK local header', zip.readUInt32LE(0) === 0x04034b50)
  check('ZIP has EOCD signature', zip.readUInt32LE(zip.length - 22) === 0x06054b50)
  check('ZIP EOCD entry count = 2', zip.readUInt16LE(zip.length - 22 + 10) === 2)
  const read = readStoredZip(zip)
  check('ZIP round-trips 2 entries with valid CRC', read.length === 2)
  check('entry A name + bytes preserved', read[0].name === 'badge-A.pdf' && read[0].data.equals(a))
  check('entry B name + bytes preserved', read[1].name === 'badge-B.pdf' && read[1].data.equals(b))

  // ── XLSX refactor parity (still a valid zip after extraction) ──
  const xlsx = tablesToXlsx([])
  check('xlsx still PK-prefixed (shared ZIP writer)', xlsx.readUInt32LE(0) === 0x04034b50)
  check('xlsx has EOCD', xlsx.readUInt32LE(xlsx.length - 22) === 0x06054b50)

  // ── Package filters (reuse of generation filters over source items) ──
  const items = [
    item({ registrationId: 'r1', passId: 'vip', category: 'A', passName: 'VIP' }),
    item({ registrationId: 'r2', passId: 'gen', category: 'B', passName: 'General' }),
    item({ registrationId: 'r3', passId: 'vip', category: 'B', passName: 'VIP' }),
  ]
  check('Entire event → all items', selectPackageItems(items, {}).length === 3)
  check('Pass filter → passId match', selectPackageItems(items, { pass: 'vip' }).map(i => i.registrationId).join(',') === 'r1,r3')
  check('Category filter → category match', selectPackageItems(items, { category: 'B' }).map(i => i.registrationId).join(',') === 'r2,r3')
  check('Selected filter → id subset', selectPackageItems(items, { registrationIds: ['r2'] }).map(i => i.registrationId).join(',') === 'r2')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
