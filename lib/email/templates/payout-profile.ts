import { emailShell, metaRow, escHtml } from './base'
import type {
  PayoutProfileVerifiedEmailParams,
  PayoutProfileRejectedEmailParams,
} from '../provider'

export function payoutProfileVerifiedTemplate(
  p: PayoutProfileVerifiedEmailParams,
): { subject: string; html: string } {
  const subject = 'Payout Profile Verified — RegisterDesk'

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Payout Profile Verified
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escHtml(p.organizerName)}</strong>, your payout profile has been reviewed and verified by our team.
    </p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#15803d;">
        Profile details
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Account holder', p.accountHolderName)}
        ${p.payoutMethod === 'bank'
          ? metaRow('Payout method', 'Bank transfer')
          : metaRow('Payout method', 'UPI')}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      Your payout profile is now active. Settlement payments will be transferred to your
      registered ${p.payoutMethod === 'bank' ? 'bank account' : 'UPI ID'} once approved.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

export function payoutProfileRejectedTemplate(
  p: PayoutProfileRejectedEmailParams,
): { subject: string; html: string } {
  const subject = 'Payout Profile Update — Action Required'

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Payout Profile Not Verified
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escHtml(p.organizerName)}</strong>, we were unable to verify your payout profile at this time.
    </p>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#dc2626;">
        Reason
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Account holder', p.accountHolderName)}
        ${p.rejectionNote ? metaRow('Note', p.rejectionNote) : ''}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      Please update your payout profile with the correct information and resubmit for review.
      If you have questions, contact our support team.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}
