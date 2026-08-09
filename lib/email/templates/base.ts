// Shared HTML primitives used by all email templates.
// Inline styles are required — most email clients strip <style> blocks.

// White-label branding applied to the email shell. All fields optional; absent
// fields fall back to RegisterDesk defaults so existing callers are unchanged.
export interface EmailBranding {
  companyName?:              string | null
  primaryColor?:             string | null   // hex; tints the header bar
  hideRegisterDeskBranding?: boolean         // hides the "Powered by RegisterDesk" footer
  // RD-PRODUCT-01C — extended white-label fields (all optional, all with fallbacks).
  logoUrl?:                  string | null   // organization / event logo shown in the header
  secondaryColor?:           string | null   // hex; used for footer accents
  website?:                  string | null   // absolute URL, shown in the footer
  supportEmail?:             string | null
  supportPhone?:             string | null
  copyright?:                string | null   // e.g. "© 2026 Acme Events"
  footerText?:               string | null   // free-text line above the copyright
}

import { OWNERSHIP_SHORT } from '@/lib/marketing/ownership'

const HEX = /^#[0-9a-fA-F]{6}$/
const isHex = (v?: string | null): v is string => !!v && HEX.test(v)
const isHttp = (v?: string | null): v is string => !!v && /^https?:\/\//i.test(v)

/**
 * Wraps `bodyHtml` in the standard RegisterDesk email shell.
 *
 * @param unsubscribeUrl — when provided (broadcast emails only), an
 *   "Unsubscribe" link is appended to the footer. Omit for transactional
 *   emails which must always reach the recipient.
 * @param branding — optional white-label overrides (header color, header label,
 *   hide "Powered by"). Omit for default RegisterDesk branding.
 */
export function emailShell(subject: string, bodyHtml: string, unsubscribeUrl?: string, branding?: EmailBranding): string {
  const unsubscribeFooter = unsubscribeUrl
    ? `\n            <br>\n            <span style="font-size:11px;color:#9ca3af;display:block;margin-top:6px;">\n              Don&apos;t want these emails?\n              <a href="${escAttr(unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>\n            </span>`
    : ''

  const headerColor = isHex(branding?.primaryColor) ? branding!.primaryColor! : '#e5277e'
  const headerLabel = branding?.companyName?.trim() || 'RegisterDesk'
  // Header: prefer the organization/event logo; fall back to the uppercase label.
  const headerInner = isHttp(branding?.logoUrl)
    ? `<img src="${escAttr(branding!.logoUrl!)}" alt="${escAttr(headerLabel)}" height="28" style="height:28px;max-height:28px;width:auto;display:block;border:0;" />`
    : `<span style="font-size:11px;font-weight:700;color:#fff;letter-spacing:0.14em;text-transform:uppercase;opacity:0.9;">${escHtml(headerLabel)}</span>`

  const accent = isHex(branding?.secondaryColor) ? branding!.secondaryColor! : '#9ca3af'
  // Organizer footer lines (company / free text / contact / copyright) — each rendered
  // only when supplied, so the default (no branding) footer is unchanged.
  const contactBits = [
    isHttp(branding?.website) ? `<a href="${escAttr(branding!.website!)}" style="color:${accent};text-decoration:none;">${escHtml(branding!.website!.replace(/^https?:\/\//, ''))}</a>` : '',
    branding?.supportEmail ? `<a href="mailto:${escAttr(branding.supportEmail)}" style="color:${accent};text-decoration:none;">${escHtml(branding.supportEmail)}</a>` : '',
    branding?.supportPhone ? `<span style="color:${accent};">${escHtml(branding.supportPhone)}</span>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ')
  const orgFooter = [
    branding?.footerText ? `<div style="font-size:11.5px;color:#6b7280;margin-bottom:4px;">${escHtml(branding.footerText)}</div>` : '',
    contactBits ? `<div style="font-size:11.5px;margin-bottom:4px;">${contactBits}</div>` : '',
    branding?.copyright ? `<div style="font-size:11px;color:#9ca3af;margin-bottom:4px;">${escHtml(branding.copyright)}</div>` : '',
  ].filter(Boolean).join('')

  // RD-LAUNCH-03: the operating entity rides WITH the RegisterDesk mark — so it appears
  // wherever our branding appears, and is hidden wherever an organiser has white-labelled.
  // An organiser presenting their own brand must not carry our legal footer.
  const poweredBy   = branding?.hideRegisterDeskBranding
    ? ''
    : `\n            <span style="font-size:11.5px;color:#9ca3af;">\n              Powered by <a href="https://registerdesk.in" style="color:#9ca3af;text-decoration:none;">RegisterDesk</a>\n            </span>\n            <span style="font-size:10.5px;color:#b0b6c0;display:block;margin-top:3px;">\n              ${OWNERSHIP_SHORT}\n            </span>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;width:100%;">

        <!-- ── Header ── -->
        <tr>
          <td style="background:${headerColor};border-radius:12px 12px 0 0;padding:20px 28px;">
            ${headerInner}
          </td>
        </tr>

        <!-- ── Body ── -->
        <tr>
          <td style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:32px 28px 28px;">
            ${bodyHtml}
          </td>
        </tr>

        <!-- ── Footer ── -->
        <tr>
          <td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:14px 28px;text-align:center;">${orgFooter}${poweredBy}${unsubscribeFooter}
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

/** Renders a primary or secondary CTA button. */
export function btn(label: string, url: string, primary = true): string {
  const bg = primary ? '#e5277e' : '#f3f4f6'
  const fg = primary ? '#ffffff' : '#374151'
  const border = primary ? 'none' : '1px solid #d1d5db'
  return `<a href="${escAttr(url)}" style="display:inline-block;background:${bg};color:${fg};text-decoration:none;font-size:13.5px;font-weight:600;padding:11px 22px;border-radius:8px;border:${border};margin:0 8px 8px 0;line-height:1.4;">${escHtml(label)}</a>`
}

/** Renders one row in the event-details info table. */
export function metaRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:7px 16px 7px 0;font-size:12px;color:#6b7280;vertical-align:top;white-space:nowrap;min-width:80px;">${escHtml(label)}</td>
    <td style="padding:7px 0;font-size:13px;color:#111827;font-weight:500;">${escHtml(value)}</td>
  </tr>`
}

// Centralized HTML escapers for transactional email templates.
// escHtml — for text content (between tags). escAttr — for attribute values
// (e.g. href). Exported so every template escapes user-controlled values the
// same way; `&` is replaced first to avoid double-encoding.
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}
