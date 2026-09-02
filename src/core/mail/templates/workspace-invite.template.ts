export interface WorkspaceInviteEmailData {
  inviterName: string;
  workspaceName: string;
  role: string;
  inviteUrl: string;
  expiresInDays?: number;
  recipientEmail: string;
}

export function renderWorkspaceInviteEmail(
  data: WorkspaceInviteEmailData,
): { subject: string; html: string; text: string } {
  const {
    inviterName,
    workspaceName,
    role,
    inviteUrl,
    expiresInDays = 7,
    recipientEmail,
  } = data;

  const subject = `You've been invited to join ${workspaceName} on Flux`;

  const text = `
Hello,

${inviterName} has invited you to collaborate on the "${workspaceName}" workspace on Flux as a ${role}.

To accept this invitation and join the workspace, please visit the following link:
${inviteUrl}

This invitation link is intended for ${recipientEmail} and will expire in ${expiresInDays} days.

If you were not expecting this invitation, you can safely ignore this email.

Best regards,
The Flux Team
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0B0F19; color: #F3F4F6; }
    .btn:hover { background-color: #4338CA !important; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #0B0F19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed;">
    <tr>
      <td align="center" style="padding: 40px 15px 60px 15px;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 540px; background-color: #111827; border: 1px solid #1F2937; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
          
          <!-- Header / Brand -->
          <tr>
            <td align="center" style="padding: 36px 40px 20px 40px; border-bottom: 1px solid #1F2937;">
              <div style="display: inline-flex; align-items: center; gap: 8px;">
                <span style="font-size: 20px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.5px;">FLUX</span>
              </div>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td style="padding: 36px 40px 28px 40px; text-align: left;">
              
              <!-- Badge -->
              <div style="display: inline-block; padding: 4px 12px; background-color: #1E1B4B; border: 1px solid #3730A3; border-radius: 9999px; font-size: 11px; font-weight: 600; color: #A5B4FC; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 20px;">
                Workspace Invitation
              </div>

              <!-- Title -->
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #FFFFFF; line-height: 1.3;">
                Join <span style="color: #818CF8;">${workspaceName}</span>
              </h1>

              <!-- Message -->
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #9CA3AF;">
                <strong style="color: #F3F4F6;">${inviterName}</strong> has invited you to collaborate on the <strong style="color: #F3F4F6;">${workspaceName}</strong> workspace on Flux as a <strong style="color: #818CF8; text-transform: capitalize;">${role}</strong>.
              </p>

              <!-- Workspace Info Box -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #1F2937; border-radius: 12px; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <div style="font-size: 13px; font-weight: 600; color: #F3F4F6;">
                      Workspace: <span style="color: #FFFFFF;">${workspaceName}</span>
                    </div>
                    <div style="font-size: 12px; color: #9CA3AF; margin-top: 4px;">
                      Role assigned: <span style="color: #A5B4FC; text-transform: capitalize; font-weight: 500;">${role}</span>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Call to Action Button -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${inviteUrl}" target="_blank" class="btn" style="display: inline-block; width: 100%; box-sizing: border-box; background-color: #4F46E5; color: #FFFFFF; text-align: center; padding: 14px 24px; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.4);">
                      Accept Invitation & Join
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Fallback Link -->
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #6B7280; word-break: break-all;">
                Or copy and paste this link in your browser:<br>
                <a href="${inviteUrl}" target="_blank" style="color: #818CF8; text-decoration: underline;">${inviteUrl}</a>
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background-color: #0F172A; border-top: 1px solid #1F2937; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 11px; color: #6B7280;">
                This invitation was sent to <strong style="color: #9CA3AF;">${recipientEmail}</strong> and will expire in ${expiresInDays} days.
              </p>
              <p style="margin: 0; font-size: 11px; color: #4B5563;">
                If you were not expecting this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

  return { subject, html, text };
}
