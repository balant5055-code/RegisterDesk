// Shared HTML primitives used by all email templates.
// Inline styles are required — most email clients strip <style> blocks.

// White-label branding applied to the email shell. All fields optional; absent
// fields fall back to RegisterDesk defaults so existing callers are unchanged.
export interface EmailBranding {
  companyName?:              string | null
  primaryColor?:             string | null   // hex; tints the header bar
  hideRegisterDeskBranding?: boolean         // hides the "Powered by RegisterDesk" footer
}

const HEX = /^#[0-9a-fA-F]{6}$/

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

  const headerColor = branding?.primaryColor && HEX.test(branding.primaryColor) ? branding.primaryColor : '#e5277e'
  const headerLabel = branding?.companyName?.trim() || 'RegisterDesk'
  const poweredBy   = branding?.hideRegisterDeskBranding
    ? ''
    : `\n            <span style="font-size:11.5px;color:#9ca3af;">\n              Powered by <a href="https://registerdesk.in" style="color:#9ca3af;text-decoration:none;">RegisterDesk</a>\n            </span>`

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
            <span style="font-size:11px;font-weight:700;color:#fff;letter-spacing:0.14em;text-transform:uppercase;opacity:0.9;">${escHtml(headerLabel)}</span>
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
          <td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:14px 28px;text-align:center;">${poweredBy}${unsubscribeFooter}
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
