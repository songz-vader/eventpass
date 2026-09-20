import { ApiError } from '../lib/http.js';
import { sha256, randomToken, makeBackupCodes } from '../lib/tokens.js';
import { verifyTotp } from '../lib/totp.js';
import { verifyPassword } from '../lib/passwords.js';
import { verifyOtp } from './otp.js';
import { mfaEnabled } from './core.js';
import { registerFailure, assertNotLocked } from './auth.js';
import { platformCaps } from '../messaging/index.js';

const PENDING_TTL = 5 * 60_000;
const MAX_PENDING_ATTEMPTS = 5;

export async function availableMethods(ctx, u) {
  const caps = platformCaps(ctx);
  const m = [];
  if (u.totp_enabled) m.push('totp');
  if (u.sms_mfa && u.phone_verified && caps.sms) m.push('sms');
  if (u.wa_mfa && u.phone_verified && caps.whatsapp) m.push('whatsapp');
  if (await ctx.db.prepare('SELECT 1 FROM backup_codes WHERE user_id = ? AND used_at IS NULL').get(u.id)) m.push('backup');
  return m;
}

export async function beginMfa(ctx, req, user, loginMethod) {
  const token = randomToken(32);
  const now = ctx.now();
  await ctx.db.prepare('INSERT INTO mfa_pending (id, user_id, method, created_at, expires_at) VALUES (?,?,?,?,?)').run(sha256(token), user.id, loginMethod, now, now + PENDING_TTL);
  return { mfa_required: true, mfa_token: token, methods: await availableMethods(ctx, user) };
}

export async function getPending(ctx, token) {
  const row = await ctx.db.prepare('SELECT * FROM mfa_pending WHERE id = ?').get(sha256(String(token || '')));
  if (!row || row.expires_at < ctx.now()) { if (row) await ctx.db.prepare('DELETE FROM mfa_pending WHERE id = ?').run(row.id); throw new ApiError(401, 'mfa_expired', 'That sign-in took too long. Please start again.'); }
  return row;
}
export async function countAttempt(ctx, pending) {
  await ctx.db.prepare('UPDATE mfa_pending SET attempts = attempts + 1 WHERE id = ?').run(pending.id);
  if (pending.attempts + 1 >= MAX_PENDING_ATTEMPTS) { await ctx.db.prepare('DELETE FROM mfa_pending WHERE id = ?').run(pending.id); return true; }
  return false;
}

export function normalizeBackup(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : '';
}

export async function issueBackupCodes(ctx, userId) {
  const codes = makeBackupCodes(10);
  await ctx.db.tx(async (t) => {
    await t.run('DELETE FROM backup_codes WHERE user_id = ?', [userId]);
    for (const c of codes) await t.run('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)', [userId, sha256(c)]);
  });
  return codes;
}

// Checks one second-factor code. Returns true/false; consumes one-time codes and records the TOTP step to stop replays.
export async function checkSecondFactor(ctx, user, { method, code, ref = '' }) {
  if (method === 'totp') {
    if (!user.totp_enabled || !user.totp_secret_enc) return false;
    const hit = verifyTotp(ctx.vault.decrypt(user.totp_secret_enc), code, { now: ctx.now(), lastStep: user.totp_last_step });
    if (!hit) return false;
    // Moves the "last used" step forward only if nobody else already used this step or a later one: a replayed code changes no row.
    const advanced = await ctx.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(hit.step, user.id, hit.step);
    if (advanced.changes !== 1) return false;
    user.totp_last_step = hit.step;
    return true;
  }
  if (method === 'sms' || method === 'whatsapp') {
    if (method === 'sms' ? !user.sms_mfa : !user.wa_mfa) return false;
    return await verifyOtp(ctx, { userId: user.id, purpose: 'login', ref, code, destination: user.phone });
  }
  if (method === 'backup') {
    const norm = normalizeBackup(code);
    if (!norm) return false;
    const r = await ctx.db.prepare('UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(ctx.now(), user.id, sha256(norm));
    return r.changes === 1;
  }
  return false;
}

// Sensitive account actions (disable 2FA, delete account, new backup codes) ask the person to prove it's really them.
export async function reauthenticate(ctx, user, body = {}, req) {
  assertNotLocked(ctx, user);
  if (user.password_hash) {
    if (typeof body.password === 'string' && await verifyPassword(body.password, user.password_hash)) return;
    await registerFailure(ctx, user, req, 'reauth_failed');   // guessing the password here counts toward the lockout too
    throw new ApiError(403, 'reauth_failed', 'Your password is incorrect.');
  }
  if (mfaEnabled(user)) {
    const method = body.method === 'backup' ? 'backup' : 'totp';
    if (body.code && await checkSecondFactor(ctx, user, { method, code: body.code })) return;
    await registerFailure(ctx, user, req, 'reauth_failed');
    throw new ApiError(403, 'reauth_failed', 'That code is not valid.');
  }
}
