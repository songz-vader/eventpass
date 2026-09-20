import crypto from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 30s) — what Google Authenticator, Microsoft Authenticator, Authy etc. use.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretBuf, counter, digits) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(secret, { now = Date.now(), digits = 6, step = 30 } = {}) {
  return hotp(base32Decode(secret), Math.floor(now / 1000 / step), digits);
}

// Returns { step } on success, null on failure. Pass the last accepted step as lastStep to block replay.
export function verifyTotp(secret, code, { now = Date.now(), window = 1, digits = 6, step = 30, lastStep = -1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(c)) return null;
  const buf = base32Decode(secret);
  const current = Math.floor(now / 1000 / step);
  for (let w = -window; w <= window; w++) {
    const s = current + w;
    if (s <= lastStep) continue;
    const expected = hotp(buf, s, digits);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return { step: s };
  }
  return null;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
