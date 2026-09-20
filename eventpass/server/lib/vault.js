import crypto from 'node:crypto';

// AES-256-GCM envelope for secrets stored at rest (users' SMS/WhatsApp API keys, TOTP seeds).
// Format: v1:<iv>:<tag>:<ciphertext>  (base64 parts). A DB leak alone does not expose the keys.
export function createVault(keyBase64) {
  const key = Buffer.from(keyBase64 || '', 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must decode to exactly 32 bytes (generate one with: npm run keygen)');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    decrypt(blob) {
      const [v, iv, tag, ct] = String(blob).split(':');
      if (v !== 'v1') throw new Error('Unknown vault format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}
