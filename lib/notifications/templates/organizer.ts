// Template resolution for billing-lifecycle organizer emails (Phase G3.5).
//
// The engine owns the subject/HTML for LICENSE_PURCHASED and WALLET_RECHARGED so
// business code never sees email content — it passes only the business facts. Uses
// the shared emailShell, consistent with the event-review templates.

import { emailShell, escHtml } from '@/lib/email/templates/base'
import type { CustomEmailParams } from '@/lib/email/provider'
import type {
  LicensePurchasedEmailParams,
  OrganizerRegisteredEmailParams,
  CapacityThresholdEmailParams,
  WalletRechargedEmailParams,
  ServicePurchasedEmailParams,
  ServicePurchaseAdminEmailParams,
  ServicePurchaseLine,
} from '../catalog'

const rupees = (paise: number): string => `₹${(Math.round(paise) / 100).toLocaleString('en-IN')}`

export function renderLicensePurchasedEmail(p: LicensePurchasedEmailParams): CustomEmailParams {
  const subject = `Your ${p.tierName} license for “${p.eventName}” is active`
  const body =
    `<p>Hi ${escHtml(p.organizerName || 'there')},</p>` +
    `<p>Your <strong>${escHtml(p.tierName)}</strong> event license for <strong>${escHtml(p.eventName)}</strong> ` +
    `has been activated.</p>` +
    `<p><strong>Amount paid:</strong> ${rupees(p.amountPaise)}</p>` +
    `<p>You can now publish and manage your event from your dashboard.</p>`
  return { to: p.to, subject, html: emailShell(subject, body) }
}

export function renderWalletRechargedEmail(p: WalletRechargedEmailParams): CustomEmailParams {
  const subject = `Wallet recharged — ${rupees(p.amountPaise)} added`
  const body =
    `<p>Hi ${escHtml(p.organizerName || 'there')},</p>` +
    `<p>Your RegisterDesk wallet has been recharged successfully.</p>` +
    `<p><strong>Amount added:</strong> ${rupees(p.amountPaise)}<br/>` +
    `<strong>New balance:</strong> ${rupees(p.newBalancePaise)}</p>` +
    `<p>Your communication balance pays for WhatsApp and SMS messages. Event licenses and services are bought per event.</p>`
  return { to: p.to, subject, html: emailShell(subject, body) }
}

/**
 * RD-ORGANIZER-NOTIFY-03 · "a new organizer finished signing up".
 *
 * Operational, not promotional: an admin reads this to know a workspace now exists and
 * who owns it. It carries exactly the four facts needed to find that account again —
 * organization, person, email, uid — plus when it happened.
 *
 * ═══ EVERY ORGANIZER-SUPPLIED VALUE IS ESCAPED ══════════════════════════════
 * Name, organization and email are typed by whoever signed up. They are rendered into
 * HTML that lands in the platform's own inbox, so each one goes through escHtml: a
 * signup calling itself `<img onerror=...>` produces text, not markup. `to` is NOT a
 * parameter the caller chooses — the route resolves it from the branding config — and
 * nothing here echoes an OTP, a token or a password, because none of them is passed in.
 */

/**
 * RD-CAPACITY-01 · "your event is N% full".
 *
 * The 100% message is the only one that asks for an action, because at 100% registrations
 * are actually being refused — every lower threshold is information, not a problem. So the
 * copy diverges at 100 rather than escalating adjectives at every step.
 *
 * Every organizer-supplied value goes through escHtml. The event name is theirs, and this
 * email is addressed to them, but an unescaped name would still break the markup around it.
 */
export function renderCapacityThresholdEmail(p: CapacityThresholdEmailParams): CustomEmailParams {
  const cap  = p.capacity.toLocaleString('en-IN')
  const used = p.registrations.toLocaleString('en-IN')
  const full = p.threshold >= 100

  const subject = full
    ? `Registration capacity reached for “${p.eventName}”`
    : `“${p.eventName}” is ${p.threshold}% full`

  const headline = full
    ? '<p><strong>Your registration capacity has been reached.</strong> New registrations are no longer being accepted.</p>'
    : `<p>Your event has used <strong>${p.threshold}%</strong> of its registration capacity.</p>`

  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;">${escHtml(label)}</td>` +
    `<td style="padding:4px 0;"><strong>${escHtml(value)}</strong></td></tr>`

  const body =
    `<p>Hi ${escHtml(p.organizerName || 'there')},</p>` +
    headline +
    `<table style="border-collapse:collapse;font-size:14px;">` +
      row('Event', p.eventName) +
      row('Registrations', used) +
      row('Capacity', cap) +
    `</table>` +
    (full
      ? '<p>Increase your capacity to continue accepting registrations. You pay only for the additional capacity you add.</p>'
      : '<p style="color:#6b7280;font-size:13px;">You can increase your capacity at any time — you pay only for what you add.</p>')

  return { to: p.to, subject, html: emailShell(subject, body) }
}
export function renderOrganizerRegisteredEmail(p: OrganizerRegisteredEmailParams): CustomEmailParams {
  const org     = p.organizationName.trim()
  const person  = p.organizerName.trim()
  const subject = `New organizer registered — ${org || person || p.organizerEmail}`
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;">${escHtml(label)}</td>` +
    `<td style="padding:4px 0;"><strong>${escHtml(value)}</strong></td></tr>`
  const body =
    `<p>A new organizer has completed registration and verified their email address.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;">` +
      row('Organization', org || '—') +
      row('Organizer', person || '—') +
      row('Email', p.organizerEmail) +
      row('Account', p.uid) +
      row('Registered', p.registeredAt) +
      row('Status', 'Verified · Active') +
    `</table>` +
    `<p style="color:#6b7280;font-size:13px;">Open the admin organizer list to review this account.</p>`
  return { to: p.to, subject, html: emailShell(subject, body) }
}

// ── Wallet-02 · event-service purchases ──────────────────────────────────────────────────────────
const paise2 = (p: number | null) => (p === null ? '—' : `₹${(Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const qtyStr = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-IN'))
const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;'

function linesTable(lines: ServicePurchaseLine[]): string {
  return `<table style="border-collapse:collapse;font-size:14px;width:100%;">` +
    `<tr><th align="left" style="${cell}">Service</th><th align="right" style="${cell}">Qty</th><th align="right" style="${cell}">Amount</th><th align="right" style="${cell}">GST</th><th align="right" style="${cell}">Total</th></tr>` +
    lines.map(l => `<tr><td style="${cell}">${escHtml(l.label)}</td><td align="right" style="${cell}">${qtyStr(l.quantity)}</td>` +
      `<td align="right" style="${cell}">${paise2(l.basePaise)}</td><td align="right" style="${cell}">${paise2(l.gstPaise)}</td>` +
      `<td align="right" style="${cell}"><strong>${paise2(l.totalPaise)}</strong></td></tr>`).join('') +
    `</table>`
}
const kv = (label: string, value: string) =>
  `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;">${escHtml(label)}</td><td style="padding:4px 0;"><strong>${escHtml(value)}</strong></td></tr>`

export function renderServicePurchasedEmail(p: ServicePurchasedEmailParams): CustomEmailParams {
  const subject = `Purchase confirmed for “${p.eventName}”`
  const balances = p.balances.length
    ? `<p style="margin-top:18px;"><strong>Your balances for this event</strong></p>` +
      `<table style="border-collapse:collapse;font-size:14px;width:100%;">` +
      `<tr><th align="left" style="${cell}">Service</th><th align="right" style="${cell}">Purchased</th><th align="right" style="${cell}">Used</th><th align="right" style="${cell}">Remaining</th></tr>` +
      p.balances.map(b => `<tr><td style="${cell}">${escHtml(b.label)}</td><td align="right" style="${cell}">${qtyStr(b.purchased)}</td><td align="right" style="${cell}">${qtyStr(b.used)}</td><td align="right" style="${cell}">${qtyStr(b.remaining)}</td></tr>`).join('') +
      `</table>`
    : ''
  const body =
    `<p>Hi ${escHtml(p.organizerName || 'there')},</p>` +
    `<p>Your payment was verified and the purchase has been added to <strong>${escHtml(p.eventName)}</strong>.</p>` +
    linesTable(p.lines) +
    `<table style="border-collapse:collapse;font-size:14px;margin-top:12px;">` +
      (p.discountPaise ? kv('Activation discount', `− ${paise2(p.discountPaise)}`) : '') +
      (p.gstPaise !== null ? kv('GST included', paise2(p.gstPaise)) : '') +
      kv('Amount paid', paise2(p.amountPaise)) +
      kv('Order reference', p.orderId) +
      (p.paymentId ? kv('Payment reference', p.paymentId) : '') +
      kv('Purchased', p.purchasedAt) +
    `</table>` +
    balances +
    `<p style="margin-top:18px;"><a href="${escHtml(p.walletUrl)}">View this event in your Wallet</a></p>`
  return { to: p.to, subject, html: emailShell(subject, body) }
}

export function renderServicePurchaseAdminEmail(p: ServicePurchaseAdminEmailParams): CustomEmailParams {
  const subject = `Event services purchased — ${p.eventName} (${paise2(p.amountPaise)})`
  const body =
    `<p>A verified event-service purchase was applied.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;">` +
      kv('Event', p.eventName) + kv('Organizer', p.organizerName || '—') + kv('Organizer email', p.organizerEmail || '—') +
      kv('Account', p.organizerUid) + kv('Amount paid', paise2(p.amountPaise)) + kv('Order reference', p.orderId) +
      (p.paymentId ? kv('Payment reference', p.paymentId) : '') + kv('Purchased', p.purchasedAt) +
    `</table>` + linesTable(p.lines)
  return { to: p.to, subject, html: emailShell(subject, body) }
}
