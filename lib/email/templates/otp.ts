// Premium OTP email template.
// White base, large monospace code display, Outlook + Gmail safe inline styles.

export interface OtpEmailParams {
  to:   string
  name: string    // first name or full name for salutation
  code: string    // 6-digit code (plain text — only sent to the intended recipient)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Split "628419" into three digit-pairs for visual grouping: "62 · 84 · 19"
function groupCode(code: string): string {
  return `${code.slice(0,2)}&thinsp;·&thinsp;${code.slice(2,4)}&thinsp;·&thinsp;${code.slice(4,6)}`
}

// ─── Template ─────────────────────────────────────────────────────────────────

export function otpTemplate(p: OtpEmailParams): { subject: string; html: string } {
  const firstName = esc(p.name.split(' ')[0] ?? p.name)
  const subject   = 'Your RegisterDesk verification code'
  const preheader = `Verification code: ${p.code} — valid for 10 minutes`

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>${esc(subject)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .email-bg   { background-color: #0f0f0f !important; }
    .email-card { background-color: #1a1a1a !important; border-color: #2d2d2d !important; }
    .email-footer { background-color: #111 !important; border-color: #2d2d2d !important; }
    .text-main  { color: #f0f0f0 !important; }
    .text-muted { color: #9ca3af !important; }
    .code-box   { background-color: #0d0d1a !important; border-color: #3730a3 !important; }
    .code-text  { color: #a5b4fc !important; }
  }
  @media only screen and (max-width: 600px) {
    .email-card { padding: 28px 20px !important; }
    .code-text  { font-size: 38px !important; letter-spacing: 0.14em !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;" class="email-bg">

<!-- Preheader (hidden) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f1f5f9;">
  ${esc(preheader)}
  &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
</div>

<!-- Outer wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
  style="background:#f1f5f9;padding:40px 16px;" class="email-bg">
  <tr>
    <td align="center">

      <!-- Container (max 600px) -->
      <table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation"
        style="max-width:600px;width:100%;">

        <!-- ── Brand bar ── -->
        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);
                     border-radius:16px 16px 0 0;padding:18px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td>
                  <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
                               font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.08em;">
                    REGISTERDESK
                  </span>
                </td>
                <td align="right">
                  <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
                               font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:0.04em;">
                    Email Verification
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── Card body ── -->
        <tr>
          <td style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;
                     border-radius:0;padding:40px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"
              class="email-card">

            <!-- Icon -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td align="center" style="padding-bottom:24px;">
                  <div style="display:inline-block;background:#ede9fe;border-radius:50%;
                              width:64px;height:64px;line-height:64px;text-align:center;">
                    <span style="font-size:28px;line-height:64px;">✉️</span>
                  </div>
                </td>
              </tr>

              <!-- Heading -->
              <tr>
                <td align="center" style="padding-bottom:8px;">
                  <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;
                             letter-spacing:-0.02em;line-height:1.2;" class="text-main">
                    Verify your email
                  </h1>
                </td>
              </tr>

              <!-- Subtext -->
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <p style="margin:0;font-size:14px;color:#64748b;line-height:1.6;
                            max-width:380px;" class="text-muted">
                    Hi ${firstName}, enter the code below inside RegisterDesk to verify
                    your email address and activate your account.
                  </p>
                </td>
              </tr>

              <!-- ── OTP Code box ── -->
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <table cellpadding="0" cellspacing="0" border="0" role="presentation"
                    style="background:#f0f0ff;border:2px solid #c7d2fe;border-radius:12px;">
                    <tr>
                      <td style="padding:20px 36px;" class="code-box">
                        <div style="font-family:'Courier New',Courier,'Lucida Console',monospace;
                                    font-size:46px;font-weight:700;color:#312e81;
                                    letter-spacing:0.12em;line-height:1;text-align:center;
                                    white-space:nowrap;"
                             class="code-text">
                          ${groupCode(esc(p.code))}
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Expiry note -->
              <tr>
                <td align="center" style="padding-bottom:28px;">
                  <table cellpadding="0" cellspacing="0" border="0" role="presentation">
                    <tr>
                      <td style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;
                                 padding:10px 20px;">
                        <p style="margin:0;font-size:12.5px;color:#854d0e;font-weight:500;
                                  text-align:center;">
                          ⏱ This code expires in <strong>10 minutes</strong>
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Security notice -->
              <tr>
                <td align="center">
                  <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;
                            max-width:360px;" class="text-muted">
                    If you didn&apos;t create a RegisterDesk account, you can safely ignore
                    this email. No action is required.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <!-- ── Footer ── -->
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;
                     border-radius:0 0 16px 16px;padding:16px 32px;" class="email-footer">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td align="center">
                  <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.6;" class="text-muted">
                    Sent by&nbsp;<a href="https://registerdesk.in"
                      style="color:#6366f1;text-decoration:none;font-weight:500;">RegisterDesk</a>
                    &nbsp;·&nbsp;
                    <a href="https://registerdesk.in/privacy"
                      style="color:#94a3b8;text-decoration:underline;">Privacy Policy</a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  return { subject, html }
}
