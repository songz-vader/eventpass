import { ApiError } from '../lib/http.js';
import { otpCode, sha256, safeEqual } from '../lib/tokens.js';
import { sendPlatformOtp } from '../messaging/index.js';

const TTL = 10 * 60_000, COOLDOWN = 45_000, MAX_PER_HOUR = 5, MAX_ATTEMPTS = 5;
const hashOtp = (code, userId, purpose) => sha256(`${code}:${userId}:${purpose}`);

// Send a 6-digit code to a phone via the platform's SMS/WhatsApp account. Rate-limited per user and per number.
export async function issueOtp(ctx, { userId, purpose, channel, destination, ref = '' }) {
  const now = ctx.now();
  const last = await ctx.db.prepare('SELECT created_at FROM otp_codes WHERE user_id = ? AND purpose = ? AND ref = ? ORDER BY id DESC LIMIT 1').get(userId, purpose, ref);
  if (last && now - last.created_at < COOLDOWN) throw new ApiError(429, 'otp_cooldown', 'Wait a minute before asking for another code.', { retry_after: Math.ceil((COOLDOWN - (now - last.created_at)) / 1000) });
  const sent = (await ctx.db.prepare('SELECT COUNT(*) c FROM otp_codes WHERE destination = ? AND created_at > ?').get(destination, now - 3_600_000)).c;
  if (sent >= MAX_PER_HOUR) throw new ApiError(429, 'otp_limit', 'Too many codes were sent to this number. Try again in an hour.');
  const code = otpCode(6);
  const id = await ctx.db.prepare('INSERT INTO otp_codes (user_id, purpose, channel, destination, code_hash, ref, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .insert(userId, purpose, channel, destination, hashOtp(code, userId, purpose), ref, now, now + TTL);
  const res = await sendPlatformOtp(ctx, { channel, to: destination, code });
  if (!res.ok) {
    await ctx.db.prepare('DELETE FROM otp_codes WHERE id = ?').run(id);
    throw new ApiError(502, 'otp_send_failed', channel === 'whatsapp' ? 'We could not send the WhatsApp code. Try SMS instead.' : 'We could not send the SMS code. Check the number and try again.');
  }
  return { sent: true };
}

export async function verifyOtp(ctx, { userId, purpose, ref = '', code, destination }) {
  const now = ctx.now();
  const row = await ctx.db.prepare('SELECT * FROM otp_codes WHERE user_id = ? AND purpose = ? AND ref = ? ORDER BY id DESC LIMIT 1').get(userId, purpose, ref);
  if (!row || row.expires_at < now || row.attempts >= MAX_ATTEMPTS) return false;
  if (destination && row.destination !== destination) return false;
  // The attempt is counted and capped in one statement, so a flood of parallel guesses cannot exceed the limit.
  const counted = await ctx.db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?').run(row.id, MAX_ATTEMPTS);
  if (counted.changes !== 1) return false;
  if (!/^\d{6}$/.test(String(code || '').trim()) || !safeEqual(hashOtp(String(code).trim(), userId, purpose), row.code_hash)) return false;
  // Only the request that actually deletes the row gets to use the code.
  const used = await ctx.db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
  if (used.changes !== 1) return false;
  await ctx.db.prepare('DELETE FROM otp_codes WHERE user_id = ? AND purpose = ? AND ref = ?').run(userId, purpose, ref);
  return true;
}
