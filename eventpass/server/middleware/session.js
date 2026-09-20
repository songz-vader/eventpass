import { ApiError, wrap, parseCookies, clientIp, userAgent } from '../lib/http.js';
import { randomToken, sha256, safeEqual } from '../lib/tokens.js';

const DAY = 86_400_000;

export async function createSession(ctx, req, res, userId, method) {
  const { config: cfg, db } = ctx;
  const now = ctx.now();
  const token = randomToken(32);
  const csrf = randomToken(24);
  await db.prepare(`INSERT INTO sessions (id, public_id, user_id, csrf, created_at, last_seen, expires_at, ip, ua, method) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sha256(token), randomToken(9), userId, csrf, now, now, now + cfg.session.idleDays * DAY, clientIp(req), userAgent(req), method);
  setSessionCookie(cfg, res, token, cfg.session.idleDays * DAY);
  return csrf;
}

function setSessionCookie(cfg, res, token, maxAgeMs) {
  res.cookie(cfg.cookieName, token, { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', path: '/', maxAge: maxAgeMs });
}
export function clearSessionCookie(cfg, res) {
  res.clearCookie(cfg.cookieName, { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', path: '/' });
}

export async function destroySession(ctx, req, res) {
  if (req.session) await ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
  clearSessionCookie(ctx.config, res);
}

export function loadSession(ctx) {
  const { config: cfg, db } = ctx;
  return wrap(async (req, res, next) => {                      // wrap: a database error reaches the error handler instead of hanging the request
    req.session = null; req.user = null;
    const token = parseCookies(req.headers.cookie)[cfg.cookieName];
    if (!token) return next();
    const now = ctx.now();
    const s = await db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(token));
    if (!s) return next();
    if (s.expires_at <= now || s.created_at + cfg.session.absoluteDays * DAY <= now) {
      await db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
      return next();
    }
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!user) return next();
    if (now - s.last_seen > 5 * 60_000) {   // sliding idle timeout, capped by the absolute lifetime
      const exp = Math.min(now + cfg.session.idleDays * DAY, s.created_at + cfg.session.absoluteDays * DAY);
      await db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?').run(now, exp, s.id);
      setSessionCookie(cfg, res, token, exp - now);
    }
    req.session = s; req.user = user;
    next();
  });
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'unauthenticated', 'Please sign in.'));
  next();
}

// Cross-site request forgery, layer 2: authenticated writes must echo the per-session token.
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.headers['x-csrf-token'];
  if (!sent || !req.session || !safeEqual(sent, req.session.csrf)) return next(new ApiError(403, 'bad_csrf', 'Your session expired. Refresh the page and try again.'));
  next();
}

export function requireVerifiedEmail(req, res, next) {
  if (!req.user.email_verified) return next(new ApiError(403, 'email_unverified', 'Verify your email address first. We sent you a link when you signed up.'));
  next();
}
