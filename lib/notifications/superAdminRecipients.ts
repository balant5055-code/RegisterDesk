// lib/notifications/superAdminRecipients.ts
// The Super Admin email recipients, in a dependency-light module (moved out of servicePurchase so the
// notification outbox can use it without importing the licensing stack). Server-only.

import { adminAuth } from '@/lib/firebase/admin'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { uniqueMailboxes } from './mailbox'

// Re-exported for callers that already import them from here.
export { canonicalMailbox, uniqueMailboxes } from './mailbox'

/**
 * The Super Admin email recipients: the platform support inbox (branding.supportEmail) plus the
 * account email of every uid in ADMIN_UIDS (the Super Admin list — never the legacy admin:true claim).
 * De-duplicated by MAILBOX (canonicalMailbox); an address that cannot be resolved is skipped, never
 * guessed. A support inbox that FORWARDS to an admin's address is a mail-server setting this code
 * cannot see: that still delivers two copies, by configuration, not by a repeated send.
 */
export async function superAdminRecipients(): Promise<string[]> {
  const found: string[] = []
  const support = (await getBrandingConfig().catch(() => null))?.supportEmail
  if (typeof support === 'string') found.push(support)
  const uids = [...new Set((process.env.ADMIN_UIDS ?? '').split(',').map(u => u.trim()).filter(Boolean))].slice(0, 100)
  if (uids.length) {
    const res = await adminAuth.getUsers(uids.map(uid => ({ uid }))).catch(() => null)
    for (const u of res?.users ?? []) if (!u.disabled && u.email) found.push(u.email)
  }
  return uniqueMailboxes(found)
}
