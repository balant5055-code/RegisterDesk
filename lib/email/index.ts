// Email provider factory — server-only.
//
// Environment variables:
//   EMAIL_PROVIDER   resend | ses   (omit or leave blank to disable email)
//   EMAIL_FROM       Verified sender, e.g. "RegisterDesk <noreply@mail.registerdesk.in>"
//   RESEND_API_KEY   Secret — server-side only, never exposed to the client
//
// Calling code pattern:
//   const provider = getEmailProvider()
//   if (!provider) return  // email not configured — skip silently
//   const result = await provider.sendRegistrationEmail({...})
//
// Email failures must NEVER break registration, check-in, or ticket generation.
// Always wrap provider calls in try/catch at the call site.

import type { EmailProvider } from './provider'
import { ResendProvider }     from './resend'
import { SESProvider }        from './ses'

// Module-level cache — safe in Lambda/Edge since env vars are stable within a
// cold-start lifecycle.  null means "email disabled", undefined means "not yet resolved".
let _cache: EmailProvider | null | undefined = undefined

export function getEmailProvider(): EmailProvider | null {
  if (_cache !== undefined) return _cache

  const name = (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase()

  if (!name) {
    _cache = null
    return null
  }

  if (name === 'resend') {
    const apiKey = process.env.RESEND_API_KEY?.trim()
    const from   = process.env.EMAIL_FROM?.trim()

    if (!apiKey || !from) {
      console.warn(
        '[email] EMAIL_PROVIDER=resend but RESEND_API_KEY or EMAIL_FROM is missing. ' +
        'Email is disabled until both are set.',
      )
      _cache = null
      return null
    }

    _cache = new ResendProvider(apiKey, from)
    return _cache
  }

  if (name === 'ses') {
    _cache = new SESProvider()
    return _cache
  }

  console.warn(`[email] Unknown EMAIL_PROVIDER "${name}". Supported: resend, ses. Email is disabled.`)
  _cache = null
  return null
}

/** Format a stored YYYY-MM-DD date string for use in email copy. */
export function fmtEmailDate(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}
