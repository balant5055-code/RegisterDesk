import { emailShell, btn, metaRow } from './base'
import type { Donation80GEmailParams } from '../provider'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function donation80GTemplate(
  p: Donation80GEmailParams,
): { subject: string; html: string } {
  const subject = `80G Tax Receipt – ${p.campaignTitle}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      80G Tax Receipt Enclosed
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${esc(p.donorName)}</strong>, your donation to
      <strong style="color:#111827;">${esc(p.campaignTitle)}</strong> qualifies for a tax
      deduction under <strong style="color:#111827;">Section 80G</strong> of the Income Tax Act.
      Your official receipt is available below.
    </p>

    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;margin:0 0 18px;">
      <p style="margin:0 0 4px;font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
        80G Eligible Donation
      </p>
      <p style="margin:0;font-size:28px;font-weight:700;color:#15803d;">
        INR ${esc(p.amountRupees.toLocaleString('en-IN'))}
      </p>
    </div>

    <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:0 0 18px;border:1px solid #f3f4f6;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Campaign',       p.campaignTitle)}
        ${metaRow('Organization',   p.organizerName)}
        ${metaRow('Donor Name',     p.donorName)}
        ${metaRow('Donor Email',    p.donorEmail)}
        ${metaRow('Receipt Number', p.receiptNumber)}
        ${metaRow('Date',           p.paidAt)}
        ${metaRow('Transaction ID', p.transactionId)}
      </table>
    </div>

    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.06em;">
        80G Tax Exemption Details
      </p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('NGO / Org PAN',          p.organizerPan)}
        ${metaRow('80G Registration No.',   p.reg80GNumber)}
        ${metaRow('Certificate Valid Until', p.certValidUntil)}
      </table>
      <p style="margin:12px 0 0;font-size:11px;color:#065f46;line-height:1.6;">
        Under Section 80G of the Income Tax Act, 1961, you may be eligible to claim a deduction
        on this donation. The deduction percentage varies based on the applicable sub-section.
        Please consult your tax advisor and retain this receipt for your tax filing.
      </p>
    </div>

    <div style="margin:0 0 6px;">
      ${btn('View Receipt', p.receiptUrl)}
      ${btn('Download PDF Receipt', p.downloadUrl, false)}
    </div>

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      Receipt Number: <strong style="color:#374151;font-family:monospace;">${esc(p.receiptNumber)}</strong>.
      Keep this email for your tax records.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}
