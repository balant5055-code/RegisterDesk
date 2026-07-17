// Template resolution for billing-lifecycle organizer emails (Phase G3.5).
//
// The engine owns the subject/HTML for LICENSE_PURCHASED and WALLET_RECHARGED so
// business code never sees email content — it passes only the business facts. Uses
// the shared emailShell, consistent with the event-review templates.

import { emailShell, escHtml } from '@/lib/email/templates/base'
import type { CustomEmailParams } from '@/lib/email/provider'
import type { LicensePurchasedEmailParams, WalletRechargedEmailParams } from '../catalog'

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
    `<p>Your wallet funds paid communication (WhatsApp/SMS) and event licenses.</p>`
  return { to: p.to, subject, html: emailShell(subject, body) }
}
