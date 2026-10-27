// lib/notifications/mailbox.ts
// RD-NOTIFY-DEDUP · which MAILBOX an address delivers to — for recipient de-duplication only (the
// address itself is what is sent to). PURE: no Firebase, no config, so the outbox and the recipient
// resolver share it without either depending on the other's I/O.

const GMAIL = new Set(['gmail.com', 'googlemail.com'])

/**
 * Case-insensitive; a `+tag` is dropped (plus-addressing delivers to the base mailbox at Gmail,
 * Google Workspace, Outlook and most providers); for Gmail, dots in the local part are ignored and
 * googlemail.com is gmail.com. So `Bala.NT5055+ops@googlemail.com` and `balant5055@gmail.com` are ONE
 * recipient — sending to both put two copies in one inbox.
 */
export function canonicalMailbox(email: string): string {
  const e = email.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  let local = e.slice(0, at)
  let domain = e.slice(at + 1)
  local = local.split('+')[0] || local
  if (GMAIL.has(domain)) { local = local.replace(/\./g, ''); domain = 'gmail.com' }
  return `${local}@${domain}`
}

/** One address per mailbox, first spelling wins, order kept; anything that is not an address is dropped. */
export function uniqueMailboxes(emails: string[]): string[] {
  const seen = new Map<string, string>()
  for (const e of emails) {
    if (typeof e !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(e.trim())) continue
    const key = canonicalMailbox(e)
    if (!seen.has(key)) seen.set(key, e.trim())
  }
  return [...seen.values()]
}
