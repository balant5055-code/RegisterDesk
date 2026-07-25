// RD-ATTENDEE-01 Phase 1 (A) — the canonical registration URL.
//
// Pins the ONE builder every registration entry point uses, so the 4 templates that
// previously linked to the non-existent /e/[slug]/register?pass= (a hard 404) and the
// Sports ?pass= param mismatch can never regress: always /events/[slug]/register?passId=.

import { describe, it, expect } from 'vitest'
import { buildRegisterHref } from '@/lib/events/registerHref'

describe('buildRegisterHref — canonical registration URL', () => {
  it('builds /events/[slug]/register?passId= when a pass is given', () => {
    expect(buildRegisterHref('my-event', 'pass_1')).toBe('/events/my-event/register?passId=pass_1')
  })

  it('omits the query when there is no passId', () => {
    expect(buildRegisterHref('my-event')).toBe('/events/my-event/register')
    expect(buildRegisterHref('my-event', null)).toBe('/events/my-event/register')
    expect(buildRegisterHref('my-event', '')).toBe('/events/my-event/register')
  })

  it('URL-encodes the passId', () => {
    expect(buildRegisterHref('e', 'a b&c')).toBe('/events/e/register?passId=a%20b%26c')
  })

  it('never emits the broken /e/[slug] route or the ?pass= param', () => {
    const href = buildRegisterHref('my-event', 'p')
    expect(href.startsWith('/events/')).toBe(true)
    expect(href.startsWith('/e/')).toBe(false)   // the old broken route was /e/[slug]/register
    expect(href).toContain('passId=')
    expect(href).not.toMatch(/[?&]pass=/)
  })
})
