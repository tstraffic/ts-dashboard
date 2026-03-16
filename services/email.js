const nodemailer = require('nodemailer');

let _transporter = null;
let _lastConfigHash = null;

/**
 * Get SMTP config — env vars take priority, then falls back to Settings page (system_config DB).
 * This means you can configure SMTP either way and everything works.
 */
function getSmtpConfig() {
  // 1. Check environment variables first
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      host: process.env.SMTP_HOST || 'smtp.resend.com',
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== 'false', // default true for Resend
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromName: process.env.SMTP_FROM_NAME || 'T&S Traffic Control',
      fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    };
  }

  // 2. Fall back to system_config table (Settings page)
  try {
    const { getConfig } = require('../middleware/settings');
    const host = getConfig('smtp_host', '');
    const user = getConfig('smtp_user', '');
    const pass = getConfig('smtp_pass', '');
    if (host && user && pass) {
      const port = parseInt(getConfig('smtp_port', '465'), 10);
      return {
        host,
        port,
        secure: port === 465,
        user,
        pass,
        fromName: 'T&S Traffic Control',
        fromEmail: getConfig('smtp_from', user),
      };
    }
  } catch (e) {
    // settings module not ready yet (startup)
  }

  return null; // not configured
}

function getTransporter() {
  const config = getSmtpConfig();
  if (!config) return null;

  // Rebuild transporter if config changed
  const configHash = `${config.host}:${config.port}:${config.user}`;
  if (_transporter && _lastConfigHash === configHash) return _transporter;

  _transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    connectionTimeout: 10000,
    socketTimeout: 10000,
  });
  _lastConfigHash = configHash;
  return _transporter;
}

/**
 * Check if SMTP is configured (either via env vars or Settings page)
 */
function isConfigured() {
  return getSmtpConfig() !== null;
}

async function sendEmail(to, subject, html) {
  const config = getSmtpConfig();
  if (!config) {
    console.warn('[Email] SMTP not configured — skipping:', subject);
    return null;
  }
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to,
      subject,
      html,
    });
    console.log('[Email] Sent:', subject, '→', to);
    return info;
  } catch (err) {
    console.error('[Email] Send error:', err.message);
    return null;
  }
}

async function testConnection() {
  const transporter = getTransporter();
  if (!transporter) throw new Error('SMTP not configured');
  return transporter.verify();
}

module.exports = { sendEmail, testConnection, isConfigured };
