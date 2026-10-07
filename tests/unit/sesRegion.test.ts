// RD-PREPROD · production names the SES region explicitly — any valid region; production runs
// ap-south-1. See lib/email/sesRegion.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { sesRegionProblem, SES_REGION } from '@/lib/email/sesRegion'

const PROD = { VERCEL_ENV: 'production', SES_FROM_EMAIL: 'noreply@registerdesk.in' }

describe('the production SES region rule', () => {
  it('1 · production + AWS_REGION=ap-south-1 (the real production value) is allowed', () => {
    expect(sesRegionProblem({ ...PROD, AWS_REGION: 'ap-south-1' })).toBeNull()
  })

  it('2 · production + AWS_REGION=us-east-1 is allowed', () => {
    expect(sesRegionProblem({ ...PROD, AWS_REGION: 'us-east-1' })).toBeNull()
  })

  it('3 · production + AWS_REGION missing or blank is REJECTED — no silent default', () => {
    expect(sesRegionProblem({ ...PROD })).toMatch(/must be set explicitly/)
    expect(sesRegionProblem({ ...PROD, AWS_REGION: '  ' })).toMatch(/must be set explicitly/)
  })

  it('production + a malformed region is rejected', () => {
    for (const bad of ['ap-south', 'AP-SOUTH-1', 'mumbai', 'ap_south_1'])
      expect(sesRegionProblem({ ...PROD, AWS_REGION: bad }), bad).toMatch(/not a valid AWS region/)
  })

  it('accepts other well-formed regions — nothing is pinned', () => {
    for (const ok of ['eu-west-2', 'ap-southeast-1', 'us-gov-west-1', 'me-central-1'])
      expect(sesRegionProblem({ ...PROD, AWS_REGION: ok }), ok).toBeNull()
  })

  it('4 · development/test/preview with the region missing keep the existing behaviour (no error)', () => {
    expect(sesRegionProblem({ SES_FROM_EMAIL: 'x@y.z' })).toBeNull()
    expect(sesRegionProblem({ VERCEL_ENV: 'preview', SES_FROM_EMAIL: 'x@y.z' })).toBeNull()
    expect(sesRegionProblem({ VERCEL_ENV: 'development', SES_FROM_EMAIL: 'x@y.z' })).toBeNull()
    // ...where the local default is used.
    expect(SES_REGION).toBe('us-east-1')
  })

  it('does not apply when email is disabled', () => {
    expect(sesRegionProblem({ VERCEL_ENV: 'production' })).toBeNull()
  })

  it('is enforced at the email boundary, skipped during next build, and the client uses AWS_REGION', () => {
    const src = readFileSync('lib/email/index.ts', 'utf8')
    expect(src).toContain('sesRegionProblem(process.env)')
    expect(src).toMatch(/NEXT_PHASE !== 'phase-production-build'\) \{\s*const problem = sesRegionProblem/)
    // The configured region is what the SES client receives; the default applies only when unset.
    expect(src).toContain('region:      AWS_REGION || SES_REGION,')
    // No production code pins a region any more.
    expect(readFileSync('lib/email/sesRegion.ts', 'utf8')).not.toMatch(/region !== SES_REGION/)
  })
})
