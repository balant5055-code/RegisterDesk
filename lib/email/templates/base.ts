// Shared HTML primitives used by all email templates.
// Inline styles are required — most email clients strip <style> blocks.

export function emailShell(subject: string, bodyHtml: string): string {
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
          <td style="background:#e5277e;border-radius:12px 12px 0 0;padding:20px 28px;">
            <span style="font-size:11px;font-weight:700;color:#fff;letter-spacing:0.14em;text-transform:uppercase;opacity:0.9;">RegisterDesk</span>
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
          <td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:14px 28px;text-align:center;">
            <span style="font-size:11.5px;color:#9ca3af;">
              Powered by <a href="https://registerdesk.in" style="color:#9ca3af;text-decoration:none;">RegisterDesk</a>
            </span>
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

// Minimal HTML escaping — prevents XSS if event/attendee names contain < > & " chars
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}
