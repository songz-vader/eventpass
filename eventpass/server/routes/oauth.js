import { Router } from 'express';
import { ApiError, parseCookies } from '../lib/http.js';
import { safeEqual } from '../lib/tokens.js';
import { mfaEnabled } from '../services/core.js';
import { startSession } from '../services/auth.js';
import { beginMfa } from '../services/mfa.js';
import { getProvider, discover, beginAuthorization, exchangeCode, verifyIdToken, resolveUser, oauthCookieName, OAuthError } from '../services/oauth.js';

// Browser navigations, not API calls: every outcome is a redirect back into the app.
//   success → /        second step needed → /#/mfa/<token>        failure → /#/login?oauth_error=<code>
// Codes are fixed words; text from the provider is never put in the URL.
export function oauthRoutes(ctx) {
  const r = Router();
  const cfg = ctx.config;
  const back = (link, params) => `/#/${link ? 'account' : 'login'}?${new URLSearchParams(params)}`;
  const clearBinding = (res) => res.clearCookie(oauthCookieName(ctx), { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', path: '/' });

  r.get('/:provider/start', async (req, res) => {
    const link = req.query.mode === 'link';
    try {
      const prov = getProvider(ctx, req.params.provider);
      if (!prov?.enabled) throw new OAuthError('provider_disabled');
      if (link && !req.user) throw new OAuthError('login_required');
      const doc = await discover(ctx, prov);
      res.redirect(302, await beginAuthorization(ctx, res, prov, doc, { linkUserId: link ? req.user.id : null }));
    } catch (e) {
      if (!(e instanceof OAuthError)) console.error('[oauth] start failed:', e);
      res.redirect(302, back(link && e.code !== 'login_required', { oauth_error: e instanceof OAuthError ? e.code : 'provider_error' }));
    }
  });

  // Apple (response_mode=form_post) delivers the result as a cross-site POST from appleid.apple.com. Our cookies are SameSite=Lax, so the
  // browser would not send the sign-in cookie with that POST. We therefore do nothing with it except bounce it, with only the fields we
  // expect, to the GET callback below: a top-level GET from this very site carries the cookie, and the flow finishes exactly as for other providers.
  r.post('/:provider/callback', (req, res, next) => {
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(req.params.provider)) return next(new ApiError(404, 'not_found', 'Not found.'));
    const keep = new URLSearchParams();
    for (const k of ['code', 'state', 'error', 'user']) { const v = req.body?.[k]; if (typeof v === 'string' && v.length <= 4000) keep.set(k, v); }
    res.redirect(303, `/api/auth/oauth/${req.params.provider}/callback?${keep}`);
  });

  r.get('/:provider/callback', async (req, res) => {
    const q = req.query;
    const state = typeof q.state === 'string' ? q.state : '';
    let row = state ? await ctx.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state) : null;
    const bound = parseCookies(req.headers.cookie)[oauthCookieName(ctx)];
    // Only the browser that started the flow may use (and so use up) its state. A stray request without the cookie
    // (another browser, a link prefetcher) is refused but does not burn the state of the real sign-in.
    const mine = !!(row && bound && safeEqual(bound, state));
    if (mine) { await ctx.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state); clearBinding(res); }
    const link = !!row?.link_user_id;
    const fail = (code) => res.redirect(302, back(link, { oauth_error: code }));
    try {
      if (!row || !mine || row.provider !== req.params.provider || row.expires_at < ctx.now()) throw new OAuthError('invalid_state');
      if (q.error) throw new OAuthError(['access_denied', 'user_cancelled_authorize', 'user_cancelled_login'].includes(q.error) ? 'cancelled' : 'provider_error');
      if (typeof q.code !== 'string' || !q.code || q.code.length > 2000) throw new OAuthError('provider_error');
      const prov = getProvider(ctx, row.provider);
      if (!prov?.enabled) throw new OAuthError('provider_disabled');
      const doc = await discover(ctx, prov);
      const idToken = await exchangeCode(ctx, prov, doc, { code: q.code, verifier: row.verifier });
      const claims = await verifyIdToken(ctx, prov, doc, idToken, row.nonce);
      // Apple sends the person's name only once, outside the signed token. It is unsigned, so it may name a new account and nothing else.
      if (prov.responseMode === 'form_post' && !claims.name && typeof q.user === 'string' && q.user.length < 2000) {
        try { const n = JSON.parse(q.user)?.name; const full = [n?.firstName, n?.lastName].filter((x) => typeof x === 'string').join(' ').trim(); if (full) claims.name = full.slice(0, 80); } catch { /* ignore a malformed field */ }
      }
      const user = await resolveUser(ctx, prov, claims, { req, linkUserId: row.link_user_id });

      if (link) return res.redirect(302, `/#/account?linked=${prov.id}`);
      if (mfaEnabled(user)) return res.redirect(302, `/#/mfa/${(await beginMfa(ctx, req, user, `oauth:${prov.id}`)).mfa_token}`);
      if (req.session) await ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);  // never carry an older session across a new sign-in
      await startSession(ctx, req, res, user, `oauth:${prov.id}`);
      res.redirect(302, '/');
    } catch (e) {
      if (e instanceof OAuthError) { if (!['invalid_state', 'cancelled'].includes(e.code)) console.warn(`[oauth] ${req.params.provider} sign-in refused: ${e.code} (${e.message})`); return fail(e.code); }
      console.error('[oauth] callback failed:', e);
      fail('provider_error');
    }
  });

  return r;
}
