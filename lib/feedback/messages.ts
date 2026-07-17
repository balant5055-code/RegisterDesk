// Centralized user-facing message catalog (EA-4 S3). Client-safe, pure data.
// One source of truth for feedback wording — no hardcoded strings across modules,
// and a single place to add localization later. Call sites reference keys; a
// literal string is still accepted (msg passes it through), so migration is gradual.

export const MESSAGES = {
  // ── Events ──
  'event.publish.success':   'Event published.',
  'event.publish.pending':   'Event submitted for review.',
  'event.archive.success':   'Event archived.',
  'event.restore.success':   'Event restored.',
  'event.duplicate.success': 'Event duplicated.',
  'event.delete.success':    'Event deleted.',
  // ── Registrations ──
  'registration.created':    'Registration created.',
  'registration.checkedIn':  'Checked in.',
  'registration.cancelled':  'Registration cancelled.',
  'registration.restored':   'Registration restored.',
  // ── Payments / licensing / coupons ──
  'payment.success':         'Payment received.',
  'payment.failed':          'Payment failed. Please try again or contact support.',
  'license.purchased':       'License activated.',
  'license.expired':         'This license has expired.',
  'coupon.applied':          'Coupon applied.',
  'coupon.invalid':          'This coupon code is not valid.',
  'coupon.expired':          'This coupon has expired.',
  // ── Certificates / print / reports ──
  'certificate.generated':   'Certificates ready.',
  'print.completed':         'Print job completed.',
  'export.ready':            'Your export is ready to download.',
  'import.completed':        'Import completed.',
  'bulk.completed':          'Bulk operation completed.',
  // ── Wallet ──
  'wallet.recharged':        'Wallet recharged.',
  'wallet.low':              'Your wallet balance is low.',
  // ── Generic ──
  'saved':                   'Changes saved.',
  'deleted':                 'Deleted.',
  'copied':                  'Copied to clipboard.',
  // ── Errors ──
  'permission.denied':       'You do not have permission to do that.',
  'network.offline':         'You are offline. Some actions are paused.',
  'network.online':          'Back online.',
  'server.error':            'Something went wrong. Please try again.',
  'validation.required':     'Please fill in the required fields.',
} as const

export type MessageKey = keyof typeof MESSAGES

const TABLE = MESSAGES as Record<string, string>

/** Resolve a catalog key, or pass a literal string through unchanged. */
export function msg(key: MessageKey | (string & {})): string {
  return TABLE[key] ?? key
}

/** Map an API error (Error / code / string) to a human-friendly message. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return TABLE[err.message] ?? (err.message.length < 200 ? err.message : MESSAGES['server.error'])
  }
  if (typeof err === 'string' && err) return TABLE[err] ?? err
  return MESSAGES['server.error']
}
