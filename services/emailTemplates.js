const APP_URL = () => process.env.APP_BASE_URL || 'http://localhost:3000';

function baseTemplate(title, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <!-- Header -->
        <tr><td style="background:#1D6AE5;padding:20px 24px;border-radius:12px 12px 0 0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#ffffff;font-size:18px;font-weight:700;">T&S Traffic Control</td>
              <td align="right" style="color:#BFDBFE;font-size:13px;">Operations Dashboard</td>
            </tr>
          </table>
        </td></tr>
        <!-- Body -->
        <tr><td style="background:#ffffff;padding:32px 24px;border:1px solid #E5E7EB;border-top:none;">
          <h2 style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:600;">${title}</h2>
          ${bodyContent}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 24px;text-align:center;border-radius:0 0 12px 12px;">
          <p style="margin:0;color:#9CA3AF;font-size:12px;">&copy; T&S Traffic Control. This is an automated message.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buttonHtml(text, url) {
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td style="background:#1D6AE5;border-radius:8px;padding:12px 28px;">
      <a href="${url}" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">${text}</a>
    </td></tr>
  </table>`;
}

function adminInviteEmail(fullName, inviteUrl, expiresHours) {
  return baseTemplate('You\'ve Been Invited', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">You've been invited to the <strong>T&S Operations Dashboard</strong>. Click the button below to set your password and activate your account.</p>
    ${buttonHtml('Set Your Password', inviteUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. If you didn't expect this invitation, you can safely ignore this email.</p>
  `);
}

function workerInviteEmail(fullName, setupUrl, expiresHours) {
  return baseTemplate('Set Up Your Worker Portal PIN', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">You've been set up on the <strong>T&S Worker Portal</strong>. Tap the button below to create your sign-in PIN.</p>
    ${buttonHtml('Set Your PIN', setupUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. You'll use your Employee ID and PIN to sign in on your phone.</p>
  `);
}

function passwordResetEmail(fullName, resetUrl, expiresHours) {
  return baseTemplate('Reset Your Password', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">We received a request to reset your password. Click the button below to choose a new password.</p>
    ${buttonHtml('Reset Password', resetUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. If you didn't request this, you can safely ignore this email.</p>
  `);
}

function pinResetEmail(fullName, resetUrl, expiresHours) {
  return baseTemplate('Reset Your Worker Portal PIN', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">We received a request to reset your Worker Portal PIN. Tap the button below to set a new PIN.</p>
    ${buttonHtml('Reset PIN', resetUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. If you didn't request this, you can safely ignore this email.</p>
  `);
}

function notificationEmail(fullName, title, message, link) {
  const fullLink = link ? (link.startsWith('http') ? link : APP_URL() + link) : '';
  return baseTemplate(title, `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">${message}</p>
    ${fullLink ? buttonHtml('View Details', fullLink) : ''}
  `);
}

function dailyDigestEmail(fullName, notifications) {
  const items = notifications.map(n =>
    `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #F3F4F6;">
        <p style="margin:0;font-size:14px;color:#111827;font-weight:500;">${n.title}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#6B7280;">${n.message}</p>
      </td>
    </tr>`
  ).join('');

  return baseTemplate('Daily Notification Summary', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${fullName}, here's your daily summary of ${notifications.length} notification${notifications.length === 1 ? '' : 's'}:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${items}</table>
    ${buttonHtml('Open Dashboard', APP_URL() + '/notifications')}
  `);
}

module.exports = {
  adminInviteEmail,
  workerInviteEmail,
  passwordResetEmail,
  pinResetEmail,
  notificationEmail,
  dailyDigestEmail,
};
