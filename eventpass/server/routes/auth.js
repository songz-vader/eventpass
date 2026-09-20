import { isUniqueViolation } from '../db.js';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, wrap, parse } from '../lib/http.js';
import { hashPassword, verifyPassword, dummyVerify, validatePassword } from '../lib/passwords.js';
import { normalizePhone } from '../lib/phone.js';
import { isDisposable } from '../lib/email.js';
import { makeLimiter } from '../middleware/limits.js';
import { requireAuth, destroySession } from '../middleware/session.js';
import { audit, publicUser, mfaEnabled } from '../services/core.js';
import { startSession, registerFailure, assertNotLocked, sendVerifyEmail, sendResetEmail, sendNotice, consumeEmailToken, revokeAllSessions } from '../services/auth.js';
import { beginMfa, getPending, countAttempt, checkSecondFactor, availableMethods } from '../services/mfa.js';
import { issueOtp } from '../services/otp.js';
import { oauthRoutes } from './oauth.js';

const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address.');
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(80),
  email,
  password: z.string().max(200),
  phone: z.string().trim().max(30).optional(),
});
const invalidCreds = () => new ApiError(401, 'invalid_credentials', 'Incorrect email or password.');

export function authRoutes(ctx) {
  const r = Router();
  const cfg = ctx.config;
  const loginLimit = makeLimiter(cfg, { windowMs: cfg.rate.loginWindowMs, limit: cfg.rate.loginPerIp, message: 'Too many sign-in attempts. Wait a few minutes and try again.' });
  const otpLimit = makeLimiter(cfg, { windowMs: cfg.rate.otpWindowMs, limit: cfg.rate.otpSendPerIp, message: 'Too many codes requested. Try again later.' });

  const done = async (req, res, user, method, status = 200) => {
    const csrf = await startSession(ctx, req, res, user, method);
    res.status(status).json({ user: await publicUser(ctx, user), csrf });
  };

  r.get('/session', wrap(async (req, res) => {
    if (!req.user) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: await publicUser(ctx, req.user), csrf: req.session.csrf });
  }));

  r.post('/register', loginLimit, wrap(async (req, res) => {
    if (!cfg.allowRegistration) throw new ApiError(403, 'registration_closed', 'Sign-ups are closed right now.');
    const b = parse(registerSchema, req.body);
    if (isDisposable(b.email)) throw new ApiError(400, 'disposable_email', 'Use a permanent email address such as Gmail, Yahoo, Outlook or your own domain.', { fields: { email: 'Use a permanent email address.' } });
    const pwErr = validatePassword(b.password, { email: b.email, name: b.name });
    if (pwErr) throw new ApiError(400, 'weak_password', pwErr, { fields: { password: pwErr } });
    let phone = null, operator = null;
    if (b.phone) {
      const p = normalizePhone(b.phone);
      if (!p.ok) throw new ApiError(400, 'validation', p.error, { fields: { phone: p.error } });
      phone = p.e164; operator = p.operator;
    }
    if (await ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email)) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    const hash = await hashPassword(b.password);
    let id;
    try {
      id = await ctx.db.prepare('INSERT INTO users (email, password_hash, name, phone, phone_operator, created_at) VALUES (?,?,?,?,?,?)').insert(b.email, hash, b.name, phone, operator, ctx.now());
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
      throw e;
    }
    const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    await audit(ctx, id, 'register', req, { method: 'password' });
    await sendVerifyEmail(ctx, user);
    await done(req, res, user, 'password', 201);
  }));

  r.post('/login', loginLimit, wrap(async (req, res) => {
    const b = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(b.email);
    assertNotLocked(ctx, user);
    if (!user || !user.password_hash) { await dummyVerify(b.password); throw invalidCreds(); }
    if (!(await verifyPassword(b.password, user.password_hash))) { await registerFailure(ctx, user, req); throw invalidCreds(); }
    if (mfaEnabled(user)) { await audit(ctx, user.id, 'login_password_ok_mfa_needed', req); return res.json(await beginMfa(ctx, req, user, 'password')); }
    await done(req, res, user, 'password');
  }));

  // ── second step of sign-in ──
  const mfaSchema = z.object({ mfa_token: z.string().min(10).max(200), method: z.enum(['totp', 'sms', 'whatsapp', 'backup']), code: z.string().trim().min(4).max(20).optional() });

  // Which second-factor options to offer: needed when sign-in was started somewhere other than the password form (e.g. Google).
  r.post('/mfa/info', loginLimit, wrap(async (req, res) => {
    const b = parse(mfaSchema.pick({ mfa_token: true }), req.body);
    const pending = await getPending(ctx, b.mfa_token);
    const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
    res.json({ methods: await availableMethods(ctx, user), to: (await publicUser(ctx, user)).phone_masked });
  }));

  r.post('/mfa/send', otpLimit, wrap(async (req, res) => {
    const b = parse(mfaSchema.pick({ mfa_token: true, method: true }), req.body);
    if (b.method !== 'sms' && b.method !== 'whatsapp') throw new ApiError(400, 'validation', 'Choose SMS or WhatsApp.');
    const pending = await getPending(ctx, req.body.mfa_token);
    const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
    if (!(b.method === 'sms' ? user.sms_mfa : user.wa_mfa) || !user.phone_verified) throw new ApiError(400, 'method_unavailable', 'That method is not turned on for this account.');
    await issueOtp(ctx, { userId: user.id, purpose: 'login', channel: b.method, destination: user.phone, ref: pending.id });
    res.json({ sent: true, to: (await publicUser(ctx, user)).phone_masked });
  }));

  r.post('/mfa/verify', loginLimit, wrap(async (req, res) => {
    const b = parse(mfaSchema, req.body);
    if (!b.code) throw new ApiError(400, 'validation', 'Enter the code.');
    const pending = await getPending(ctx, b.mfa_token);
    const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
    assertNotLocked(ctx, user);
    const ok = await checkSecondFactor(ctx, user, { method: b.method, code: b.code, ref: pending.id });
    if (!ok) {
      const dead = await countAttempt(ctx, pending);
      await audit(ctx, user.id, 'mfa_failed', req, { method: b.method });
      if (dead) throw new ApiError(401, 'mfa_expired', 'Too many wrong codes. Please sign in again.');
      throw new ApiError(401, 'invalid_code', 'That code is not correct or has expired.');
    }
    await ctx.db.prepare('DELETE FROM mfa_pending WHERE id = ?').run(pending.id);
    if (b.method === 'backup') await audit(ctx, user.id, 'backup_code_used', req);
    await done(req, res, user, `${pending.method}+${b.method}`);
  }));

  r.post('/logout', wrap(async (req, res) => {
    if (req.user) await audit(ctx, req.user.id, 'logout', req);
    await destroySession(ctx, req, res);
    res.json({ ok: true });
  }));

  // ── email verification ──
  r.post('/email/verify', wrap(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const row = await consumeEmailToken(ctx, token, 'verify');
    await ctx.db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
    await audit(ctx, row.user_id, 'email_verified', req);
    res.json({ ok: true });
  }));

  r.post('/email/resend', requireAuth, wrap(async (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true });
    const last = await ctx.db.prepare(`SELECT created_at FROM email_tokens WHERE user_id = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1`).get(req.user.id);
    if (last && ctx.now() - last.created_at < 60_000) throw new ApiError(429, 'cooldown', 'Wait a minute before asking for another email.');
    await sendVerifyEmail(ctx, req.user);
    res.json({ ok: true });
  }));

  // ── password reset ──
  const generic = { ok: true, message: 'If that email has an account, we have sent a reset link.' };
  r.post('/password/forgot', loginLimit, wrap(async (req, res) => {
    const b = parse(z.object({ email }), req.body);
    const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(b.email);
    if (user) { await audit(ctx, user.id, 'password_reset_requested', req); await sendResetEmail(ctx, user); }
    res.json(generic);
  }));

  r.post('/password/reset', loginLimit, wrap(async (req, res) => {
    const b = parse(z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }), req.body);
    const row = await consumeEmailToken(ctx, b.token, 'reset');
    const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const pwErr = validatePassword(b.password, { email: user.email, name: user.name });
    if (pwErr) {
      await ctx.db.prepare('UPDATE email_tokens SET used_at = NULL WHERE token_hash = ?').run(row.token_hash); // let them retry with a stronger password
      throw new ApiError(400, 'weak_password', pwErr, { fields: { password: pwErr } });
    }
    await ctx.db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = 0, email_verified = 1 WHERE id = ?').run(await hashPassword(b.password), user.id);
    await revokeAllSessions(ctx, user.id);
    await audit(ctx, user.id, 'password_reset', req);
    sendNotice(ctx, user, 'Your EventPass password was changed', 'The password on your EventPass account was just changed, and you were signed out everywhere.');
    res.json({ ok: true });
  }));

  r.use('/oauth', oauthRoutes(ctx));
  return r;
}
