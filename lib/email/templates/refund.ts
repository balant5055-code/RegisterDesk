import { emailShell, metaRow } from './base'
import type { RefundConfirmationEmailParams } from '../provider'

function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function refundConfirmationTemplate(
  p: RefundConfirmationEmailParams,
): { subject: string; html: string } {
  const subject  = `Refund confirmed for ${p.eventName}`
  const amountFmt = fmtINR(p.refundAmount)

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Refund confirmed
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${esc(p.attendeeName)}</strong>, your refund for
      <strong style="color:#111827;">${esc(p.eventName)}</strong> has been processed.
    </p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#15803d;">
        Refund details
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Refund amount', amountFmt)}
        ${metaRow('Event',         p.eventName)}
        ${metaRow('Pass',          p.passName)}
        ${metaRow('Ticket',        p.ticketCode)}
        ${metaRow('Reference',     p.refundId)}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      Please allow 5&ndash;10 business days for <strong>${amountFmt}</strong> to appear in your
      account, depending on your bank or payment method. If you have any questions, please contact
      the event organiser.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
