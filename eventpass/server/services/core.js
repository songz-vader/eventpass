import { maskPhone } from '../lib/phone.js';
import { clientIp, userAgent } from '../lib/http.js';

export const mfaEnabled = (u) => !!(u.totp_enabled || u.sms_mfa || u.wa_mfa);

export async function audit(ctx, userId, event, req, meta) {
  await ctx.db.prepare('INSERT INTO audit_log (user_id, event, ip, ua, meta, ts) VALUES (?,?,?,?,?,?)')
    .run(userId ?? null, event, req ? clientIp(req) : null, req ? userAgent(req) : null, meta ? JSON.stringify(meta) : null, ctx.now());
}

export async function logActivity(ctx, userId, msg) {
  await ctx.db.prepare('INSERT INTO activity (user_id, msg, ts) VALUES (?,?,?)').run(userId, msg.slice(0, 300), ctx.now());
  await ctx.db.prepare('DELETE FROM activity WHERE user_id = ? AND id NOT IN (SELECT id FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 200)').run(userId, userId);
}

export async function publicUser(ctx, u) {
  const providers = await ctx.db.prepare('SELECT provider, email FROM oauth_identities WHERE user_id = ?').all(u.id);
  const backup = (await ctx.db.prepare('SELECT COUNT(*) c FROM backup_codes WHERE user_id = ? AND used_at IS NULL').get(u.id)).c;
  return {
    id: u.id, email: u.email, email_verified: !!u.email_verified, name: u.name,
    phone: u.phone, phone_masked: maskPhone(u.phone), phone_verified: !!u.phone_verified, operator: u.phone_operator,
    has_password: !!u.password_hash, providers,
    mfa: { enabled: mfaEnabled(u), totp: !!u.totp_enabled, sms: !!u.sms_mfa, whatsapp: !!u.wa_mfa, backup_remaining: backup },
    created_at: u.created_at,
  };
}
