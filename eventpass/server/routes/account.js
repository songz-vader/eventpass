import { isUniqueViolation } from '../db.js';
import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { ApiError, wrap, parse } from '../lib/http.js';
import { hashPassword, verifyPassword, validatePassword } from '../lib/passwords.js';
import { normalizePhone } from '../lib/phone.js';
import { generateSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { audit, publicUser, mfaEnabled } from '../services/core.js';
import { revokeAllSessions, sendNotice, registerFailure, assertNotLocked } from '../services/auth.js';
import { issueOtp, verifyOtp } from '../services/otp.js';
import { issueBackupCodes, reauthenticate } from '../services/mfa.js';
import { platformCaps } from '../messaging/index.js';
import { clearSessionCookie } from '../middleware/session.js';

function deviceLabel(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown device';
  return `${browser} on ${os}`;
}

export function accountRoutes(ctx) {
  const r = Router();
  const fresh = async (req) => await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const me = async (req) => ({ user: await publicUser(ctx, await fresh(req)) });

  r.get('/', wrap(async (req, res) => res.json(await me(req))));

  r.patch('/', wrap(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1, 'Enter your name.').max(80) }), req.body);
    await ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(b.name, req.user.id);
    res.json(await me(req));
  }));

  r.post('/password', wrap(async (req, res) => {
    const b = parse(z.object({ current_password: z.string().max(200).optional(), new_password: z.string().max(200) }), req.body);
    const u = await fresh(req);
    if (u.password_hash) {
      assertNotLocked(ctx, u);
      if (!b.current_password || !(await verifyPassword(b.current_password, u.password_hash))) { await registerFailure(ctx, u, req, 'reauth_failed'); throw new ApiError(403, 'reauth_failed', 'Your current password is incorrect.', { fields: { current_password: 'Incorrect password.' } }); }
    }
    const pwErr = validatePassword(b.new_password, { email: u.email, name: u.name });
    if (pwErr) throw new ApiError(400, 'weak_password', pwErr, { fields: { new_password: pwErr } });
    await ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(b.new_password), u.id);
    await revokeAllSessions(ctx, u.id, req.session.id);
    await audit(ctx, u.id, 'password_changed', req);
    sendNotice(ctx, u, 'Your EventPass password was changed', 'The password on your EventPass account was just changed. Other devices were signed out.');
    res.json({ ok: true, ...await me(req) });
  }));

  // ── mobile number connector ──
  r.post('/phone', wrap(async (req, res) => {
    const b = parse(z.object({ phone: z.string().trim().min(1, 'Enter your phone number.').max(30), channel: z.enum(['sms', 'whatsapp']).optional() }), req.body);
    const p = normalizePhone(b.phone);
    if (!p.ok) throw new ApiError(400, 'validation', p.error, { fields: { phone: p.error } });
    const channel = b.channel || 'sms';
    if (!platformCaps(ctx)[channel]) throw new ApiError(503, 'channel_unavailable', channel === 'whatsapp' ? 'WhatsApp codes are not available right now. Use SMS.' : 'SMS codes are not available right now.');
    const u = await fresh(req);
    if (await ctx.db.prepare('SELECT 1 FROM users WHERE phone = ? AND phone_verified = 1 AND id != ?').get(p.e164, u.id)) throw new ApiError(409, 'phone_taken', 'This number is already linked to another account.');
    if (u.phone !== p.e164) await ctx.db.prepare('UPDATE users SET phone = ?, phone_operator = ?, phone_verified = 0, sms_mfa = 0, wa_mfa = 0 WHERE id = ?').run(p.e164, p.operator, u.id);
    await issueOtp(ctx, { userId: u.id, purpose: 'phone_verify', channel, destination: p.e164 });
    res.json({ sent: true, channel, to: (await publicUser(ctx, await fresh(req))).phone_masked, operator: p.operator, e164: p.e164 });
  }));

  r.post('/phone/verify', wrap(async (req, res) => {
    const b = parse(z.object({ code: z.string().trim().min(4).max(10) }), req.body);
    const u = await fresh(req);
    if (!u.phone) throw new ApiError(400, 'no_phone', 'Add a phone number first.');
    if (!await verifyOtp(ctx, { userId: u.id, purpose: 'phone_verify', code: b.code, destination: u.phone })) throw new ApiError(400, 'invalid_code', 'That code is not correct or has expired.');
    try { await ctx.db.prepare('UPDATE users SET phone_verified = 1 WHERE id = ?').run(u.id); }
    catch (e) { if (isUniqueViolation(e)) throw new ApiError(409, 'phone_taken', 'This number is already linked to another account.'); throw e; }
    await audit(ctx, u.id, 'phone_verified', req);
    res.json(await me(req));
  }));

  r.delete('/phone', wrap(async (req, res) => {
    await reauthenticate(ctx, await fresh(req), req.body, req);
    await ctx.db.prepare('UPDATE users SET phone = NULL, phone_operator = NULL, phone_verified = 0, sms_mfa = 0, wa_mfa = 0 WHERE id = ?').run(req.user.id);
    await pruneBackupIfNoMfa(req.user.id);
    res.json(await me(req));
  }));

  // ── two-factor authentication ──
  const pruneBackupIfNoMfa = async (id) => { if (!mfaEnabled(await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id))) await ctx.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(id); };
  const hasBackup = async (id) => !!await ctx.db.prepare('SELECT 1 FROM backup_codes WHERE user_id = ? AND used_at IS NULL').get(id);

  r.post('/mfa/totp/setup', wrap(async (req, res) => {
    const u = await fresh(req);
    if (u.totp_enabled) throw new ApiError(400, 'already_enabled', 'Authenticator app is already on. Turn it off first to set up a new one.');
    const secret = generateSecret();
    await ctx.db.prepare('UPDATE users SET totp_pending_enc = ? WHERE id = ?').run(ctx.vault.encrypt(secret), u.id);
    const uri = otpauthUri({ secret, account: u.email, issuer: 'EventPass' });
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#1C1814', light: '#FFFFFF' } }) });
  }));

  r.post('/mfa/totp/enable', wrap(async (req, res) => {
    const b = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
    const u = await fresh(req);
    if (!u.totp_pending_enc) throw new ApiError(400, 'no_setup', 'Start the setup again to get a new QR code.');
    const hit = verifyTotp(ctx.vault.decrypt(u.totp_pending_enc), b.code, { now: ctx.now() });
    if (!hit) throw new ApiError(400, 'invalid_code', 'That code is not correct. Check the time on your phone and try again.');
    await ctx.db.prepare('UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(hit.step, u.id);
    const backup_codes = await hasBackup(u.id) ? [] : await issueBackupCodes(ctx, u.id);
    await audit(ctx, u.id, 'mfa_enabled', req, { method: 'totp' });
    res.json({ ...await me(req), backup_codes });
  }));

  r.post('/mfa/otp/send', wrap(async (req, res) => {
    const b = parse(z.object({ method: z.enum(['sms', 'whatsapp']) }), req.body);
    const u = await fresh(req);
    if (!u.phone || !u.phone_verified) throw new ApiError(400, 'phone_required', 'Verify your mobile number first.');
    if (!platformCaps(ctx)[b.method]) throw new ApiError(503, 'channel_unavailable', 'That method is not available right now.');
    await issueOtp(ctx, { userId: u.id, purpose: 'enable_mfa', channel: b.method, destination: u.phone, ref: b.method });
    res.json({ sent: true, to: (await publicUser(ctx, u)).phone_masked });
  }));

  r.post('/mfa/otp/enable', wrap(async (req, res) => {
    const b = parse(z.object({ method: z.enum(['sms', 'whatsapp']), code: z.string().trim().min(4).max(10) }), req.body);
    const u = await fresh(req);
    if (!u.phone_verified || !await verifyOtp(ctx, { userId: u.id, purpose: 'enable_mfa', ref: b.method, code: b.code, destination: u.phone })) throw new ApiError(400, 'invalid_code', 'That code is not correct or has expired.');
    await ctx.db.prepare(`UPDATE users SET ${b.method === 'sms' ? 'sms_mfa' : 'wa_mfa'} = 1 WHERE id = ?`).run(u.id);
    const backup_codes = await hasBackup(u.id) ? [] : await issueBackupCodes(ctx, u.id);
    await audit(ctx, u.id, 'mfa_enabled', req, { method: b.method });
    res.json({ ...await me(req), backup_codes });
  }));

  r.delete('/mfa/:method', wrap(async (req, res) => {
    const method = req.params.method;
    if (!['totp', 'sms', 'whatsapp'].includes(method)) throw new ApiError(404, 'not_found', 'Unknown method.');
    await reauthenticate(ctx, await fresh(req), req.body, req);
    const col = { totp: 'totp_enabled = 0, totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = -1', sms: 'sms_mfa = 0', whatsapp: 'wa_mfa = 0' }[method];
    await ctx.db.prepare(`UPDATE users SET ${col} WHERE id = ?`).run(req.user.id);
    await pruneBackupIfNoMfa(req.user.id);
    await audit(ctx, req.user.id, 'mfa_disabled', req, { method });
    sendNotice(ctx, await fresh(req), 'Two-factor authentication was turned off', `A sign-in method (${method}) was removed from your EventPass account.`);
    res.json(await me(req));
  }));

  r.post('/mfa/backup-codes', wrap(async (req, res) => {
    const u = await fresh(req);
    if (!mfaEnabled(u)) throw new ApiError(400, 'mfa_off', 'Turn on two-factor authentication first.');
    await reauthenticate(ctx, u, req.body, req);
    await audit(ctx, u.id, 'backup_codes_regenerated', req);
    res.json({ backup_codes: await issueBackupCodes(ctx, u.id), ...await me(req) });
  }));

  // ── connected sign-in providers ──
  r.delete('/providers/:provider', wrap(async (req, res) => {
    const u = await fresh(req);
    const ids = await ctx.db.prepare('SELECT provider FROM oauth_identities WHERE user_id = ?').all(u.id);
    if (!ids.some((i) => i.provider === req.params.provider)) throw new ApiError(404, 'not_found', 'That provider is not connected.');
    if (!u.password_hash && ids.length < 2) throw new ApiError(400, 'last_login_method', 'This is the only way you can sign in. Set a password first, then disconnect it.');
    await reauthenticate(ctx, u, req.body, req);
    await ctx.db.prepare('DELETE FROM oauth_identities WHERE user_id = ? AND provider = ?').run(u.id, req.params.provider);
    await audit(ctx, u.id, 'oauth_unlinked', req, { provider: req.params.provider });
    res.json(await me(req));
  }));

  // ── devices ──
  r.get('/sessions', wrap(async (req, res) => {
    const rows = await ctx.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(req.user.id);
    res.json({ sessions: rows.map((s) => ({ id: s.public_id, current: s.id === req.session.id, device: deviceLabel(s.ua), ip: s.ip, created_at: s.created_at, last_seen: s.last_seen, method: s.method })) });
  }));
  r.delete('/sessions/:id', wrap(async (req, res) => {
    const target = await ctx.db.prepare('SELECT id FROM sessions WHERE public_id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
    if (!target) throw new ApiError(404, 'not_found', 'That device was not found.');
    await ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(target.id);
    if (target.id === req.session.id) clearSessionCookie(ctx.config, res);
    res.json({ ok: true });
  }));
  r.post('/sessions/revoke-others', wrap(async (req, res) => {
    await revokeAllSessions(ctx, req.user.id, req.session.id);
    await audit(ctx, req.user.id, 'sessions_revoked', req);
    res.json({ ok: true });
  }));

  r.get('/audit', wrap(async (req, res) => {
    const rows = await ctx.db.prepare('SELECT event, ip, ua, meta, ts FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ entries: rows.map((e) => ({ event: e.event, ip: e.ip, device: deviceLabel(e.ua), meta: e.meta ? JSON.parse(e.meta) : null, ts: e.ts })) });
  }));

  // ── your data ──
  r.get('/export', wrap(async (req, res) => {
    const id = req.user.id, q = async (sql) => await ctx.db.prepare(sql).all(id);
    const u = await fresh(req);
    res.setHeader('Content-Disposition', 'attachment; filename="eventpass-export.json"');
    res.json({
      exported_at: new Date(ctx.now()).toISOString(),
      account: { email: u.email, name: u.name, phone: u.phone, email_verified: !!u.email_verified, created_at: u.created_at },
      events: await q('SELECT * FROM events WHERE user_id = ?'),
      guests: await q('SELECT * FROM guests WHERE user_id = ?'),
      checkin_log: await q('SELECT * FROM checkin_log WHERE user_id = ?'),
      message_log: await q('SELECT * FROM message_log WHERE user_id = ?'),
      activity: await q('SELECT * FROM activity WHERE user_id = ?'),
      security_log: await q('SELECT event, ip, ts FROM audit_log WHERE user_id = ?'),
    });
  }));

  r.delete('/', wrap(async (req, res) => {
    const u = await fresh(req);
    if (!u.password_hash && !mfaEnabled(u) && req.body?.confirm !== 'DELETE') throw new ApiError(403, 'reauth_failed', 'Type DELETE to confirm.');
    await reauthenticate(ctx, u, req.body, req);
    await ctx.db.prepare('DELETE FROM users WHERE id = ?').run(u.id);   // events, guests, logs, sessions… all cascade
    clearSessionCookie(ctx.config, res);
    res.json({ ok: true });
  }));

  return r;
}
