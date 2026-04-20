// AES-256-GCM field-level encryption service.
//
// Key source (priority): FIELD_ENCRYPTION_KEY env var (hex, 64 chars).
// Fallback: auto-generate once and persist to system_config. For production set
// FIELD_ENCRYPTION_KEY explicitly so keys survive container rebuilds and are
// consistent across environments.
//
// Stored format: base64(iv[12] || authTag[16] || ciphertext)
//
// NEVER log plaintext of encrypted fields (TFN, BSB, account number).

const crypto = require('crypto');
const { getDb } = require('../db/database');

let cachedKey = null;

function loadOrGenerateKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = (process.env.FIELD_ENCRYPTION_KEY || '').trim();
  if (/^[0-9a-f]{64}$/i.test(fromEnv)) {
    cachedKey = Buffer.from(fromEnv, 'hex');
    return cachedKey;
  }

  // Fallback: pull from system_config (schema uses config_key / config_value)
  try {
    const db = getDb();
    const row = db.prepare("SELECT config_value FROM system_config WHERE config_key = 'field_encryption_key'").get();
    if (row && row.config_value && /^[0-9a-f]{64}$/i.test(row.config_value)) {
      cachedKey = Buffer.from(row.config_value, 'hex');
      return cachedKey;
    }
    const fresh = crypto.randomBytes(32);
    db.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value, config_type, description) VALUES ('field_encryption_key', ?, 'string', 'AES-256-GCM key for bank/TFN encryption — set FIELD_ENCRYPTION_KEY env var to override')").run(fresh.toString('hex'));
    console.warn('[encryption] Generated new FIELD_ENCRYPTION_KEY in system_config. Set FIELD_ENCRYPTION_KEY env var to pin this key for production.');
    cachedKey = fresh;
    return cachedKey;
  } catch (e) {
    // Last-resort: ephemeral key (bad — restarts will lose data). Used only to avoid a crash.
    console.error('[encryption] FATAL: could not load or persist key:', e.message);
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }
}

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const key = loadOrGenerateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(encoded) {
  if (!encoded) return null;
  try {
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length < 28) return null;
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const ct = buf.slice(28);
    const key = loadOrGenerateKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    console.error('[encryption] decrypt failed:', e.message);
    return null;
  }
}

// Helpers: mask utilities (never echo the encrypted value)
function maskLast(value, last = 3) {
  if (!value) return '';
  const s = String(value).replace(/\s|-/g, '');
  if (s.length <= last) return '•'.repeat(s.length);
  return '•'.repeat(s.length - last) + s.slice(-last);
}

module.exports = { encrypt, decrypt, maskLast, loadOrGenerateKey };
