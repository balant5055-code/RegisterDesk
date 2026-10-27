// RD-BCAST-DUP-01 · Broadcast duplicate protection — defaults, copy and the toggle rule.
// CLIENT-SAFE and PURE.
//
// The composer's two settings map to the campaign flags the server already honours end to end:
//   email    → `dedupeEmails`  (one email per normalized address — lib/broadcasts/dedupeRecipients)
//   whatsapp → `dedupePhones`  (one message per canonical number — the same normalisation Meta gets)
// Count preview, campaign creation (and its billing count), and dispatch — immediate or scheduled,
// resolved later from the stored campaign — all read the SAME flag; this module only decides what
// the composer starts with and how an organizer turns protection off.
//
// New broadcasts start PROTECTED. Turning protection off needs an explicit confirmation; turning it
// back on never does. A stored campaign is never rewritten — the composer only creates campaigns.

export type DuplicateChannel = 'email' | 'whatsapp'

export const DEFAULT_DUPLICATE_PROTECTION: Readonly<Record<DuplicateChannel, boolean>> = { email: true, whatsapp: true }

export const DUPLICATE_PROTECTION_COPY: Readonly<Record<DuplicateChannel, {
  label: string; description: string; confirmTitle: string; confirmMessage: string
}>> = {
  whatsapp: {
    label: 'Prevent duplicate WhatsApp messages',
    description: 'Send at most one WhatsApp message per phone number, even if it appears on several registrations.',
    confirmTitle: 'Disable duplicate WhatsApp protection?',
    confirmMessage: 'Multiple registrations may share the same phone number. Disabling this protection can send multiple WhatsApp messages to the same number and consume more of your purchased WhatsApp message allowance.',
  },
  email: {
    label: 'Prevent duplicate emails',
    description: 'Send at most one email per email address, even if it appears on several registrations.',
    confirmTitle: 'Disable duplicate email protection?',
    confirmMessage: 'Multiple registrations may share the same email address. Disabling this protection can send duplicate emails and increase your email usage.',
  },
}

export const KEEP_PROTECTION_LABEL = 'Keep protection enabled'
export const DISABLE_PROTECTION_LABEL = 'Disable protection'

export interface ConfirmRequest {
  title: string; message: string; confirmLabel: string; cancelLabel: string
  tone: 'danger'; confirmOnEnter: false
}

/** The confirmation shown before protection is turned off for one channel. */
export function disableProtectionRequest(channel: DuplicateChannel): ConfirmRequest {
  const c = DUPLICATE_PROTECTION_COPY[channel]
  return {
    title: c.confirmTitle, message: c.confirmMessage,
    confirmLabel: DISABLE_PROTECTION_LABEL, cancelLabel: KEEP_PROTECTION_LABEL,
    tone: 'danger', confirmOnEnter: false,
  }
}

/**
 * The value a setting should take after the organizer asks for `requested`. Enabling is immediate;
 * disabling asks first and only proceeds on an explicit confirmation (cancel, Escape, a closed
 * dialog or an error all keep protection ON).
 */
export async function resolveDuplicateToggle(
  channel: DuplicateChannel, current: boolean, requested: boolean,
  confirm: (req: ConfirmRequest) => Promise<boolean>,
): Promise<boolean> {
  if (requested === current) return current
  if (requested) return true
  try {
    return (await confirm(disableProtectionRequest(channel))) === true ? false : true
  } catch {
    return true
  }
}
