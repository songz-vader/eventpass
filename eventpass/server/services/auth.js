import { ApiError } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/tokens.js';
import { createSession } from '../middleware/session.js';
import { audit } from './core.js';

const HOUR = 3_600_000;

export async function startSession(ctx, req, res, user, method) {
  await ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(ctx.now(), user.id);
  const csrf = await createSession(ctx, req, res, user.id, method);
  await audit(ctx, user.id, 'login', req, { method });
  return csrf;
}

export async function registerFailure(ctx, user, req, event = 'login_failed') {
  const { threshold, baseMs, maxMs } = ctx.config.lockout;
  await ctx.db.prepare('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(user.id);      // counted in the database, so parallel guesses all count
  const failed = (await ctx.db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(user.id)).failed_attempts;
  let lockUntil = 0;
  if (failed % threshold === 0) lockUntil = ctx.now() + Math.min(baseMs * 2 ** (failed / threshold - 1), maxMs);
  if (lockUntil) await ctx.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(lockUntil, user.id);
  user.failed_attempts = failed;
  await audit(ctx, user.id, event, req, lockUntil ? { locked: true } : undefined);
}

export function assertNotLocked(ctx, user) {
  if (user && user.locked_until > ctx.now()) {
    throw new ApiError(429, 'account_locked', 'Too many failed attempts. Try again later, or reset your password.', { retry_after: Math.ceil((user.locked_until - ctx.now()) / 1000) });
  }
}

export async function makeEmailToken(ctx, userId, purpose, ttlMs) {
  const token = randomToken(32);
  await ctx.db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?,?,?,?,?)').run(sha256(token), userId, purpose, ctx.now(), ctx.now() + ttlMs);
  return token;
}

export async function consumeEmailToken(ctx, token, purpose) {
  const hash = sha256(String(token || '')), now = ctx.now();
  // One statement both checks and uses it up, so two simultaneous requests cannot both succeed.
  const used = await ctx.db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at >= ?').run(now, hash, purpose, now);
  if (used.changes !== 1) throw new ApiError(400, 'invalid_token', 'This link is invalid or has expired. Request a new one.');
  return await ctx.db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(hash);
}

function sendBackground(ctx, msg) {
  ctx.mailer.send(msg).catch((e) => console.error('[mail] send failed:', e.message));
}

export async function sendVerifyEmail(ctx, user) {
  const token = await makeEmailToken(ctx, user.id, 'verify', 48 * HOUR);
  sendBackground(ctx, {
    to: user.email, subject: 'Confirm your email for EventPass',
    text: `Hi ${user.name || 'there'},\n\nConfirm your email address to unlock sending invitations and two-factor security:\n\n${ctx.config.appUrl}/#/verify/${token}\n\nThe link works for 48 hours. If you didn't create an EventPass account, ignore this email.`,
  });
}

export async function sendResetEmail(ctx, user) {
  const token = await makeEmailToken(ctx, user.id, 'reset', HOUR);
  sendBackground(ctx, {
    to: user.email, subject: 'Reset your EventPass password',
    text: `Hi ${user.name || 'there'},\n\nUse this link to choose a new password:\n\n${ctx.config.appUrl}/#/reset/${token}\n\nIt works for one hour and only once. If you didn't ask for this, you can ignore this email; your password has not changed.`,
  });
}

export function sendNotice(ctx, user, subject, body) {
  sendBackground(ctx, { to: user.email, subject, text: `Hi ${user.name || 'there'},\n\n${body}\n\nIf this wasn't you, reset your password right away: ${ctx.config.appUrl}/#/forgot` });
}

export async function revokeAllSessions(ctx, userId, exceptId) {
  if (exceptId) await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId);
  else await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  await ctx.db.prepare('DELETE FROM mfa_pending WHERE user_id = ?').run(userId);
}
