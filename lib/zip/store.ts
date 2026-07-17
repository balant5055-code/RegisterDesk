// Dependency-free STORED (uncompressed) ZIP writer. Node runtime (Buffer).
//
// Extracted verbatim from lib/reports/xlsx.ts so both the XLSX writer and the
// print-asset packager (PA-6) share ONE implementation instead of duplicating it.
// STORED (no deflate) is the right choice for already-compressed inputs (PDFs,
// OOXML parts): zero CPU, and PDFs don't shrink under deflate anyway.
//
// Constraints: 32-bit sizes/offsets (no ZIP64) and a 16-bit entry count — so an
// archive must stay under 4 GiB total and 65 535 entries. Callers that can exceed
// those must cap upstream.

export interface ZipEntry {
  name: string    // in-archive path (UTF-8), e.g. "badge-TCK-1234.pdf"
  data: Buffer
}

// ─── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ─── Byte layout helpers (shared by the buffered + streaming writers) ───────────
const DOS_DATE = 0x0021 // 1980-01-01

function localHeader(nameBuf: Buffer, crc: number, size: number): Buffer {
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)        // version needed
  local.writeUInt16LE(0, 6)         // flags
  local.writeUInt16LE(0, 8)         // method: stored
  local.writeUInt16LE(0, 10)        // mod time
  local.writeUInt16LE(DOS_DATE, 12) // mod date
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(size, 18)     // compressed size
  local.writeUInt32LE(size, 22)     // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)        // extra len
  return local
}

function centralHeader(nameBuf: Buffer, crc: number, size: number, offset: number): Buffer {
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)      // version made by
  central.writeUInt16LE(20, 6)      // version needed
  central.writeUInt16LE(0, 8)       // flags
  central.writeUInt16LE(0, 10)      // method
  central.writeUInt16LE(0, 12)      // mod time
  central.writeUInt16LE(DOS_DATE, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(size, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)      // extra len
  central.writeUInt16LE(0, 32)      // comment len
  central.writeUInt16LE(0, 34)      // disk number
  central.writeUInt16LE(0, 36)      // internal attrs
  central.writeUInt32LE(0, 38)      // external attrs
  central.writeUInt32LE(offset, 42) // local header offset
  return central
}

function eocdRecord(count: number, centralLen: number, centralStart: number): Buffer {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralLen, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  return eocd
}

/**
 * GA-7C P1-2: streaming STORED ZIP writer. Consumes entries lazily from an async
 * iterable and emits archive bytes as a Web ReadableStream, holding only the CURRENT
 * entry's bytes plus the (small) central-directory records in memory — never the
 * whole archive. Byte-for-byte identical output to buildStoredZip. STORED needs no
 * back-patching (CRC + sizes are known before each local header), so it streams
 * cleanly. Same 32-bit / 65 535-entry constraints as buildStoredZip.
 */
export function streamStoredZip(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const centrals: Buffer[] = []
  let offset = 0
  let count = 0
  const iterator = entries[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) {
        const centralBuf = Buffer.concat(centrals)
        controller.enqueue(centralBuf)
        controller.enqueue(eocdRecord(count, centralBuf.length, offset))
        controller.close()
        return
      }
      const e = next.value
      const nameBuf = Buffer.from(e.name, 'utf8')
      const crc = crc32(e.data)
      const size = e.data.length
      controller.enqueue(localHeader(nameBuf, crc, size))
      controller.enqueue(nameBuf)
      controller.enqueue(e.data)
      centrals.push(centralHeader(nameBuf, crc, size, offset), nameBuf)
      offset += 30 + nameBuf.length + size
      count++
    },
  })
}

/** Build a STORED (uncompressed) ZIP archive from entries. */
export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const DOS_DATE = 0x0021 // 1980-01-01

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const size = e.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)        // version needed
    local.writeUInt16LE(0, 6)         // flags
    local.writeUInt16LE(0, 8)         // method: stored
    local.writeUInt16LE(0, 10)        // mod time
    local.writeUInt16LE(DOS_DATE, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)     // compressed size
    local.writeUInt32LE(size, 22)     // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)        // extra len
    locals.push(local, nameBuf, e.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)      // version made by
    central.writeUInt16LE(20, 6)      // version needed
    central.writeUInt16LE(0, 8)       // flags
    central.writeUInt16LE(0, 10)      // method
    central.writeUInt16LE(0, 12)      // mod time
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)      // extra len
    central.writeUInt16LE(0, 32)      // comment len
    central.writeUInt16LE(0, 34)      // disk number
    central.writeUInt16LE(0, 36)      // internal attrs
    central.writeUInt32LE(0, 38)      // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + e.data.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}
