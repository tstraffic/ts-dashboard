// SMS via ClickSend's HTTP API. Same contract as services/email.js: config
// comes from env vars and the whole channel no-ops (returns null) until they
// exist, so callers can fire unconditionally — nothing breaks on a deploy
// where SMS isn't set up yet. Configure on Railway with:
//   CLICKSEND_USERNAME  — ClickSend account username (the login email)
//   CLICKSEND_API_KEY   — dashboard.clicksend.com → Developers → API Credentials
//   CLICKSEND_SENDER_ID — optional alphanumeric sender shown on the phone
//                         (default "TS Traffic"; ClickSend caps it at 11 chars;
//                         recipients can't reply to an alphanumeric ID)

function getConfig() {
  const username = process.env.CLICKSEND_USERNAME;
  const apiKey = process.env.CLICKSEND_API_KEY;
  if (!username || !apiKey) return null;
  return {
    username,
    apiKey,
    senderId: (process.env.CLICKSEND_SENDER_ID || 'TS Traffic').slice(0, 11),
  };
}

function isConfigured() {
  return getConfig() !== null;
}

// Normalise an Australian mobile to E.164 (+614xxxxxxxx). Returns null for
// anything that isn't recognisably an AU mobile — landlines and malformed
// numbers would burn SMS credit on a guaranteed non-delivery, so they're
// rejected up front and the caller can report "no mobile" instead of "failed".
function normalizeAuMobile(raw) {
  if (!raw) return null;
  let m = String(raw).replace(/[^\d+]/g, '');
  if (m.startsWith('+61')) m = '0' + m.slice(3);
  else if (m.startsWith('61') && m.length === 11) m = '0' + m.slice(2);
  return /^04\d{8}$/.test(m) ? '+61' + m.slice(1) : null;
}

/**
 * Send one SMS. Returns ClickSend's message object on success, null on
 * failure, invalid mobile, or unconfigured (mirrors sendEmail's contract).
 */
async function sendSms(to, body) {
  const config = getConfig();
  if (!config) {
    console.warn('[SMS] Not configured — skipping (set CLICKSEND_USERNAME + CLICKSEND_API_KEY)');
    return null;
  }
  const mobile = normalizeAuMobile(to);
  if (!mobile) {
    console.warn('[SMS] Not an AU mobile — skipping (number ends', String(to || '').slice(-3) + ')');
    return null;
  }
  try {
    const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(config.username + ':' + config.apiKey).toString('base64'),
      },
      body: JSON.stringify({
        messages: [{ source: 'atomis', to: mobile, from: config.senderId, body: String(body) }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    const msg = data && data.data && data.data.messages && data.data.messages[0];
    if (res.ok && msg && msg.status === 'SUCCESS') {
      // Recipient is PII, so log only the ClickSend message id — enough to
      // look the send up in their dashboard.
      console.log('[SMS/ClickSend] Sent | id:', msg.message_id);
      return msg;
    }
    console.error('[SMS/ClickSend] API error:', (msg && msg.status) || (data && data.response_msg) || ('HTTP ' + res.status));
    return null;
  } catch (err) {
    console.error('[SMS/ClickSend] Send error:', err.message);
    return null;
  }
}

module.exports = { sendSms, isConfigured, normalizeAuMobile };
