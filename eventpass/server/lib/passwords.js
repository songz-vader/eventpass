import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string' || typeof password !== 'string') return false;
    const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
      { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

// Burn the same CPU when the account doesn't exist so response time doesn't reveal which emails are registered.
let dummy;
export async function dummyVerify(password) {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password || '', dummy);
  return false;
}

// Small offline list of the passwords attackers try first. For stronger screening, add the
// HaveIBeenPwned k-anonymity range API (needs an outbound request, so it's left out by default).
const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123',
  'iloveyou', 'admin123', 'welcome1', 'welcome123', 'letmein123', 'abc12345', 'abcd1234', 'monkey123', 'dragon123', 'football1', 'baseball1',
  'eventpass', 'eventpass1', 'eventpass123', 'tanzania1', 'tanzania123', 'daressalaam', 'changeme123', '111111111', '0000000000', '1q2w3e4r5t',
  'zaq12wsx', 'qazwsxedc', 'sunshine1', 'princess1', 'master1234', 'trustno1234', 'simba12345', 'kilimanjaro', 'zanzibar123']);

export function validatePassword(pw, { email = '', name = '' } = {}) {
  if (typeof pw !== 'string') return 'Enter a password.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  if (/^(.)\1+$/.test(pw)) return 'That password is too repetitive.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Try a few unrelated words.';
  const local = String(email).split('@')[0].toLowerCase();
  if (email && (lower.includes(String(email).toLowerCase()) || (local.length >= 4 && lower === local))) return 'Your password should not contain your email.';
  if (name && name.length >= 4 && lower === name.toLowerCase()) return 'Your password should not be your name.';
  return null;
}
