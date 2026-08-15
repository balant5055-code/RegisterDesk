// RD-CERT-TPL-R2 — the presigned PUT the browser actually receives.
//
// WHY THIS EXISTS. Direct-to-storage upload has no server in the request path, so the ONLY
// artefact under our control is the signed URL itself. It broke in production for a reason
// no test could have caught: AWS SDK v3 defaults `requestChecksumCalculation` to
// WHEN_SUPPORTED, so presigning a PutObject checksums the request's body — which, for a
// presign, is EMPTY. The constant CRC32 of zero bytes (`AAAAAA==`) was signed into the query
// string, the browser then PUT real bytes, and R2 rejected every upload against a checksum
// that could never match. The browser saw only an opaque failure.
//
// So this asserts the URL's SHAPE, against the real provider:
//   1. No `x-amz-checksum-*` / `x-amz-sdk-checksum-algorithm` on a presigned PUT.
//   2. `content-type` is bound INTO the signature, so the URL is a capability to store one
//      declared type — not permission to store anything at that key.
//   3. The READ path is untouched: it is in production today.
//
// Credentials here are dummies and nothing is sent anywhere — signing is pure computation.

import { describe, it, expect, beforeAll } from 'vitest'

const KEY = 'events/evt-1/certificates/templates/uid-1/tpl-1/design.png'

let writeUrl: URL
let readUrl:  URL

beforeAll(async () => {
  process.env.R2_ACCOUNT_ID        = 'probe-account'
  process.env.R2_BUCKET            = 'probe-bucket'
  process.env.R2_ACCESS_KEY_ID     = 'PROBE_KEY'
  process.env.R2_SECRET_ACCESS_KEY = 'PROBE_SECRET'

  const { CloudflareR2Provider } = await import(
    '@/features/platform-storage/providers/cloudflare-r2/CloudflareR2Provider'
  )
  const provider = new CloudflareR2Provider()

  writeUrl = new URL(await provider.generateSignedUrl({
    path: KEY, operation: 'write', mimeType: 'image/png', expiresIn: 300,
  }))
  readUrl = new URL(await provider.generateSignedUrl({
    path: KEY, operation: 'read', expiresIn: 900,
  }))
})

describe('presigned PUT — R2 compatibility', () => {
  it('carries NO SDK checksum parameters', () => {
    const checksumParams = [...writeUrl.searchParams.keys()]
      .filter(k => /checksum/i.test(k))

    expect(checksumParams).toEqual([])
  })

  it('specifically does not sign in the CRC32 of an empty body', () => {
    // The exact value that broke production: CRC32("") base64-encoded.
    expect(writeUrl.searchParams.get('x-amz-checksum-crc32')).toBeNull()
    expect(writeUrl.toString()).not.toContain('AAAAAA%3D%3D')
  })

  it('binds content-type into the signature, not just host', () => {
    expect(writeUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
  })

  it('is a well-formed SigV4 URL with the requested lifetime', () => {
    expect(writeUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(writeUrl.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(writeUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(writeUrl.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request')
    expect(writeUrl.pathname).toContain(KEY)
  })

  it('does not leak the secret key into the URL', () => {
    expect(writeUrl.toString()).not.toContain('PROBE_SECRET')
  })
})

describe('presigned GET — unchanged', () => {
  it('keeps signing only host, as the production read path already does', () => {
    expect(readUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(readUrl.searchParams.get('X-Amz-Expires')).toBe('900')
  })
})
