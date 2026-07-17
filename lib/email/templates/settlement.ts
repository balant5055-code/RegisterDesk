import { emailShell, metaRow, escHtml } from './base'
import type {
  SettlementApprovedEmailParams,
  SettlementRejectedEmailParams,
  SettlementPaidEmailParams,
} from '../provider'

function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

export function settlementApprovedTemplate(
  p: SettlementApprovedEmailParams,
): { subject: string; html: string } {
  const amountFmt = fmtINR(p.amountPaise)
  const subject   = `Settlement Request Approved — ${amountFmt}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Settlement Approved
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escHtml(p.organizerName)}</strong>, your settlement request has been reviewed and approved.
    </p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#15803d;">
        Settlement details
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Amount',         amountFmt)}
        ${metaRow('Requested on',   fmtDate(p.requestedAt))}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      Your payment will be processed and transferred to your registered bank account shortly.
      You will receive another email once the payment is completed.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

export function settlementRejectedTemplate(
  p: SettlementRejectedEmailParams,
): { subject: string; html: string } {
  const amountFmt = fmtINR(p.amountPaise)
  const subject   = `Settlement Request Update — ${amountFmt}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Settlement Request Not Approved
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escHtml(p.organizerName)}</strong>, unfortunately your settlement request could not be approved at this time.
    </p>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#dc2626;">
        Request details
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Amount requested', amountFmt)}
        ${p.adminNote ? metaRow('Reason',           p.adminNote) : ''}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      If you have questions, please contact our support team. You may submit a new settlement
      request once any outstanding issues have been resolved.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

export function settlementPaidTemplate(
  p: SettlementPaidEmailParams,
): { subject: string; html: string } {
  const amountFmt = fmtINR(p.amountPaise)
  const subject   = `Settlement Payment Completed — ${amountFmt}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Payment Completed
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escHtml(p.organizerName)}</strong>, your settlement payment has been transferred to your registered bank account.
    </p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#15803d;">
        Payment details
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Amount',         amountFmt)}
        ${metaRow('UTR Number',     p.utrNumber)}
        ${p.bankReference ? metaRow('Bank Reference', p.bankReference) : ''}
        ${metaRow('Payment Date',   fmtDate(p.paidAt))}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      Please allow 1&ndash;2 business days for the funds to reflect in your account. Keep the
      UTR number for your records when following up with your bank.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}
