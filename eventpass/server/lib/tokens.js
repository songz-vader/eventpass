import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — readable on a printed invite
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// CSPRNG-backed (the old front-end used Math.random, which is predictable).
export function randomCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

export const otpCode = (len = 6) => String(crypto.randomInt(0, 10 ** len)).padStart(len, '0');

export function makeBackupCodes(n = 10) {
  const set = new Set();
  while (set.size < n) {
    let a = '', b = '';
    for (let i = 0; i < 4; i++) { a += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)]; b += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)]; }
    set.add(`${a}-${b}`);
  }
  return [...set];
}
