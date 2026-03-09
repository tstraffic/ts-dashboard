const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.office365.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: { ciphers: 'SSLv3' },
    });
  }
  return _transporter;
}

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('Email not sent (SMTP not configured):', subject);
    return null;
  }
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'T&S Traffic Control'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    console.log('Email sent:', subject, '->', to);
    return info;
  } catch (err) {
    console.error('Email send error:', err.message);
    return null;
  }
}

async function testConnection() {
  const transporter = getTransporter();
  return transporter.verify();
}

module.exports = { sendEmail, testConnection };
