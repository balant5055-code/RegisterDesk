// Premium welcome email — sent after successful OTP verification.
// Celebrates the moment, introduces 3 quick-start actions.

export interface WelcomeEmailParams {
  to:      string
  name:    string    // full name
  orgName: string
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function ctaBtn(label: string, url: string): string {
  return `<a href="${url}"
    style="display:inline-block;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);
           color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;
           padding:14px 32px;border-radius:10px;letter-spacing:0.01em;
           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    ${esc(label)}
  </a>`
}

function actionRow(icon: string, title: string, desc: string, href: string, cta: string): string {
  return `<tr>
    <td style="padding:0 0 16px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
        style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
        <tr>
          <td style="padding:16px 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td style="width:40px;vertical-align:top;padding-top:2px;">
                  <span style="font-size:22px;line-height:1;">${icon}</span>
                </td>
                <td style="padding-left:12px;vertical-align:top;">
                  <p style="margin:0 0 2px;font-size:13.5px;font-weight:600;color:#0f172a;
                            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                    ${esc(title)}
                  </p>
                  <p style="margin:0 0 10px;font-size:12.5px;color:#64748b;line-height:1.5;
                            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                    ${esc(desc)}
                  </p>
                  <a href="${href}"
                    style="font-size:12.5px;font-weight:600;color:#6366f1;text-decoration:none;
                           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                    ${esc(cta)} →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`
}

export function welcomeTemplate(p: WelcomeEmailParams): { subject: string; html: string } {
  const firstName = esc(p.name.split(' ')[0] ?? p.name)
  const appUrl    = 'https://registerdesk.in'
  const subject   = `Welcome to RegisterDesk, ${p.name.split(' ')[0]}!`
  const preheader = 'Your account is verified and ready. Start creating events today.'

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
    .email-bg    { background-color: #0f0f0f !important; }
    .email-card  { background-color: #1a1a1a !important; border-color: #2d2d2d !important; }
    .email-footer{ background-color: #111 !important; border-color: #2d2d2d !important; }
    .text-main   { color: #f0f0f0 !important; }
    .text-muted  { color: #9ca3af !important; }
    .action-card { background-color: #1e1e2e !important; border-color: #2d2d2d !important; }
  }
  @media only screen and (max-width: 600px) {
    .email-card { padding: 28px 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;" class="email-bg">

<!-- Preheader -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f1f5f9;">
  ${esc(preheader)}
  &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
</div>

<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
  style="background:#f1f5f9;padding:40px 16px;" class="email-bg">
  <tr>
    <td align="center">
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
                               font-size:11px;color:rgba(255,255,255,0.6);">
                    Welcome Email
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── Card body ── -->
        <tr>
          <td style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;
                     padding:40px 32px 32px;
                     font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"
              class="email-card">

            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">

              <!-- Hero emoji -->
              <tr>
                <td align="center" style="padding-bottom:20px;">
                  <div style="font-size:52px;line-height:1;">🎉</div>
                </td>
              </tr>

              <!-- Heading -->
              <tr>
                <td align="center" style="padding-bottom:6px;">
                  <h1 style="margin:0;font-size:24px;font-weight:700;color:#0f172a;
                             letter-spacing:-0.02em;line-height:1.2;" class="text-main">
                    Welcome, ${firstName}!
                  </h1>
                </td>
              </tr>

              <!-- Subtext -->
              <tr>
                <td align="center" style="padding-bottom:28px;">
                  <p style="margin:0;font-size:14px;color:#64748b;line-height:1.6;
                            max-width:400px;" class="text-muted">
                    Your RegisterDesk account is verified and ready.
                    You&apos;re all set to create and manage professional events.
                  </p>
                </td>
              </tr>

              <!-- Verification badge -->
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <table cellpadding="0" cellspacing="0" border="0" role="presentation">
                    <tr>
                      <td style="background:#f0fdf4;border:1px solid #bbf7d0;
                                 border-radius:100px;padding:8px 20px;">
                        <span style="font-size:13px;font-weight:600;color:#15803d;
                                     font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                          ✓&nbsp;&nbsp;Email Verified &amp; Account Activated
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Section label -->
              <tr>
                <td style="padding-bottom:12px;">
                  <p style="margin:0;font-size:11px;font-weight:700;color:#94a3b8;
                            letter-spacing:0.08em;text-transform:uppercase;" class="text-muted">
                    Get started
                  </p>
                </td>
              </tr>

              <!-- Action rows -->
              ${actionRow(
                '📅',
                'Create your first event',
                'Set up ticketing, registration, and check-in in minutes.',
                `${appUrl}/dashboard/events/new/visibility`,
                'Create an event',
              )}
              ${actionRow(
                '🏢',
                'Complete your organization profile',
                'Add your logo, brand color, and support email.',
                `${appUrl}/dashboard/settings`,
                'Go to settings',
              )}
              ${actionRow(
                '📊',
                'Explore your dashboard',
                'See registrations, analytics, and check-in tools.',
                `${appUrl}/dashboard`,
                'View dashboard',
              )}

              <!-- Primary CTA -->
              <tr>
                <td align="center" style="padding-top:8px;padding-bottom:4px;">
                  ${ctaBtn('Go to Dashboard', `${appUrl}/dashboard`)}
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
                    You received this because you created a RegisterDesk account.<br>
                    <a href="${appUrl}" style="color:#6366f1;text-decoration:none;font-weight:500;">RegisterDesk</a>
                    &nbsp;·&nbsp;
                    <a href="${appUrl}/privacy" style="color:#94a3b8;text-decoration:underline;">Privacy Policy</a>
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
