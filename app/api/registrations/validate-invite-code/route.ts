// POST /api/registrations/validate-invite-code
//
// Validates an invite code against the event's accessControl settings.
// Does NOT create any Firestore documents — read-only check.
// Used by the registration form to pre-validate before showing the form.
// The submit route independently re-validates on final submission.

import { NextRequest, NextResponse } from 'next/server'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'

export interface ValidateInviteCodeResponse {
  valid:   boolean
  error?:  string
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<ValidateInviteCodeResponse>> {
  // Rate limit: 30 attempts per 10 minutes per IP
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'validate-invite-code', 30, 10 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { valid: false, error: 'Too many attempts. Please try again later.' },
      { status: 429 },
    )
  }

  let body: unknown
  try { body = await req.json() } catch { body = null }

  const { slug, inviteCode } = (body as Record<string, unknown> | null) ?? {}
  if (typeof slug !== 'string' || !slug) {
    return NextResponse.json({ valid: false, error: 'slug is required' }, { status: 400 })
  }
  if (typeof inviteCode !== 'string' || !inviteCode.trim()) {
    return NextResponse.json({ valid: false, error: 'inviteCode is required' }, { status: 400 })
  }

  const event = await getEventBySlug(slug)
  if (!event) {
    return NextResponse.json({ valid: false, error: 'Event not found' }, { status: 404 })
  }

  const result = validateInviteCode(event.accessControl, inviteCode.trim())
  if (!result.valid) {
    return NextResponse.json({ valid: false, error: result.error }, { status: 200 })
  }

  return NextResponse.json({ valid: true })
}

// ─── Shared validation logic ──────────────────────────────────────────────────
// Exported so the submit route can reuse it without duplicating the logic.

interface InviteCodeConfig {
  code:             string
  caseSensitive:    boolean
  expiresAt?:       string   // ISO date string or ''
  expireAfterStart?: boolean
}

interface AccessControl {
  type?:       string
  inviteCode?: InviteCodeConfig | null
}

export function validateInviteCode(
  accessControl: unknown,
  providedCode:  string,
): { valid: true } | { valid: false; error: string } {
  const ac = accessControl as AccessControl | null | undefined
  if (!ac || ac.type !== 'invite_code') {
    // No invite code required — always valid
    return { valid: true }
  }

  const cfg = ac.inviteCode
  if (!cfg?.code) {
    // Configured as invite_code but no code stored — block registration
    return { valid: false, error: 'This event is not accepting registrations.' }
  }

  const storedCode  = cfg.caseSensitive ? cfg.code : cfg.code.toLowerCase()
  const submittedCode = cfg.caseSensitive ? providedCode : providedCode.toLowerCase()

  if (storedCode !== submittedCode) {
    return { valid: false, error: 'Invalid invite code. Please check and try again.' }
  }

  // Expiry check
  if (cfg.expiresAt) {
    const expiry = new Date(cfg.expiresAt)
    if (!isNaN(expiry.getTime()) && new Date() > expiry) {
      return { valid: false, error: 'This invite code has expired.' }
    }
  }

  return { valid: true }
}
