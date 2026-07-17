import { emailShell, btn, metaRow } from './base'
import type { DonationReceiptEmailParams } from '../provider'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function donationReceiptTemplate(
  p: DonationReceiptEmailParams,
): { subject: string; html: string } {
  const subject = `Your donation receipt – ${p.campaignTitle}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Thank you for your donation!
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${esc(p.donorName)}</strong>, your donation to
      <strong style="color:#111827;">${esc(p.campaignTitle)}</strong> has been received.
      Your receipt is attached below.
    </p>

    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 4px;font-size:11px;color:#9a3412;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
        Amount Donated
      </p>
      <p style="margin:0;font-size:28px;font-weight:700;color:#ea580c;">
        INR ${esc(p.amountRupees.toLocaleString('en-IN'))}
      </p>
    </div>

    <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:0 0 22px;border:1px solid #f3f4f6;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Campaign',       p.campaignTitle)}
        ${metaRow('Organization',   p.organizerName)}
        ${metaRow('Donor Name',     p.donorName)}
        ${metaRow('Donor Email',    p.donorEmail)}
        ${metaRow('Receipt Number', p.receiptNumber)}
        ${metaRow('Date',           p.paidAt)}
        ${metaRow('Transaction ID', p.transactionId)}
        ${metaRow('Payment Method', 'Online (Razorpay)')}
      </table>
    </div>

    <div style="margin:0 0 6px;">
      ${btn('View Receipt', p.receiptUrl)}
      ${btn('Download PDF', p.downloadUrl, false)}
    </div>

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      Please keep this email as proof of your donation.
      The receipt number is <strong style="color:#374151;font-family:monospace;">${esc(p.receiptNumber)}</strong>.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}
