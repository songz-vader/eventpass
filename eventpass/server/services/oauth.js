import crypto from 'node:crypto';
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, importPKCS8, jwtVerify } from 'jose';
import { randomToken, sha256 } from '../lib/tokens.js';
import { audit } from './core.js';
import { revokeAllSessions } from './auth.js';

// OpenID Connect "authorization code + PKCE" for Google, Microsoft and Yahoo, plus any extra OIDC provider from config.
// The ID token comes straight from the provider's token endpoint over TLS; we still verify signature, issuer, audience, expiry and nonce.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';   // Microsoft's fixed tenant id for personal accounts (outlook.com, hotmail, live)

// Apple has no static client secret: it wants a JWT signed with your .p8 key (ES256), which we mint fresh for every exchange.
async function appleClientSecret(ctx, prov) {
  const key = await importPKCS8(prov.privateKey, 'ES256');
  const now = Math.floor(ctx.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: prov.keyId }).setIssuer(prov.teamId).setSubject(prov.clientId).setAudience('https://appleid.apple.com').setIssuedAt(now).setExpirationTime(now + 300).sign(key);
}

export const BUILTIN = {
  google: { label: 'Google', discovery: 'https://accounts.google.com/.well-known/openid-configuration', scopes: 'openid email profile', authParams: { prompt: 'select_account' } },
  microsoft: { label: 'Microsoft', discovery: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', scopes: 'openid email profile', authParams: { prompt: 'select_account' }, msa: true },
  apple: {
    label: 'Apple', discovery: 'https://appleid.apple.com/.well-known/openid-configuration', scopes: 'name email',
    responseMode: 'form_post',                 // Apple requires this whenever name or email is requested: the result arrives as a POST
    authMethod: 'post',                        // client_id + client_secret in the body, not a Basic header
    secret: appleClientSecret, requires: ['clientId', 'teamId', 'keyId', 'privateKey'],
  },
  yahoo: { label: 'Yahoo', discovery: 'https://api.login.yahoo.com/.well-known/openid-configuration', scopes: 'openid email profile' },
};

export class OAuthError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

export function getProvider(ctx, id) {
  const oc = ctx.config.oauth || {};
  const base = BUILTIN[id] ? { id, ...BUILTIN[id], ...(oc[id] || {}) } : oc.extra?.[id] ? { id, scopes: 'openid email profile', ...oc.extra[id] } : null;
  if (!base) return null;
  const need = base.requires || ['clientId', 'clientSecret'];
  return { ...base, enabled: !!base.discovery && need.every((k) => base[k]) };
}

export function providerList(ctx) {
  const ids = [...Object.keys(BUILTIN), ...Object.keys(ctx.config.oauth?.extra || {})];
  return ids.map((id) => { const p = getProvider(ctx, id); return { id, label: p.label, enabled: p.enabled }; });
}

export const redirectUri = (ctx, id) => `${ctx.config.appUrl}/api/auth/oauth/${id}/callback`;
export const oauthCookieName = (ctx) => (ctx.config.secureCookies ? '__Host-ep_oauth' : 'ep_oauth');

function assertSafeUrl(ctx, url, what) {
  let u; try { u = new URL(url); } catch { throw new OAuthError('provider_error', `${what} is not a URL`); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && !ctx.config.isProd)) throw new OAuthError('provider_error', `${what} must be https`);
  return u.toString();
}

async function getJson(ctx, url, init = {}) {
  let res;
  try { res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(ctx.config.fetchTimeoutMs) }); }
  catch { throw new OAuthError('provider_error', 'network'); }
  let body = null; try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, body };
}

const HOUR = 3_600_000;
export async function discover(ctx, prov) {
  const hit = ctx.discovery.get(prov.id);
  if (hit && ctx.now() - hit.at < HOUR) return hit.doc;
  const r = await getJson(ctx, assertSafeUrl(ctx, prov.discovery, 'discovery URL'), { headers: { Accept: 'application/json' } });
  const d = r.body;
  if (!r.ok || !d || typeof d.issuer !== 'string') throw new OAuthError('provider_error', 'bad discovery document');
  const doc = { issuer: d.issuer, authorization_endpoint: assertSafeUrl(ctx, d.authorization_endpoint, 'authorization_endpoint'), token_endpoint: assertSafeUrl(ctx, d.token_endpoint, 'token_endpoint'), jwks_uri: assertSafeUrl(ctx, d.jwks_uri, 'jwks_uri') };
  ctx.discovery.set(prov.id, { doc, at: ctx.now() });
  return doc;
}

async function fetchJwks(ctx, uri) {
  const r = await getJson(ctx, uri, { headers: { Accept: 'application/json' } });
  if (!r.ok || !Array.isArray(r.body?.keys)) throw new OAuthError('provider_error', 'bad jwks');
  ctx.jwks.set(uri, { keys: r.body.keys, at: ctx.now() });
  return r.body.keys;
}

// Keys are cached for an hour. A token signed with a key id we have not seen means the provider rotated keys: fetch once more.
async function keySet(ctx, uri, kid) {
  const cached = ctx.jwks.get(uri);
  let keys = cached && ctx.now() - cached.at < HOUR ? cached.keys : null;
  if (!keys || (kid && !keys.some((k) => k.kid === kid))) keys = await fetchJwks(ctx, uri);
  return createLocalJWKSet({ keys });
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function beginAuthorization(ctx, res, prov, doc, { linkUserId = null } = {}) {
  const now = ctx.now();
  const state = randomToken(32), verifier = randomToken(48), nonce = randomToken(16);
  await ctx.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  await ctx.db.prepare('INSERT INTO oauth_states (state, provider, verifier, nonce, link_user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(state, prov.id, verifier, nonce, linkUserId, now, now + 10 * 60_000);
  // The state is also kept in a cookie: only the browser that started the flow can finish it (blocks login-CSRF).
  res.cookie(oauthCookieName(ctx), state, { httpOnly: true, secure: ctx.config.secureCookies, sameSite: 'lax', path: '/', maxAge: 10 * 60_000 });
  const u = new URL(doc.authorization_endpoint);
  const params = { response_type: 'code', client_id: prov.clientId, redirect_uri: redirectUri(ctx, prov.id), scope: prov.scopes, state, nonce, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...(prov.authParams || {}) };
  if (prov.responseMode) params.response_mode = prov.responseMode;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function exchangeCode(ctx, prov, doc, { code, verifier }) {
  const secret = prov.secret ? await prov.secret(ctx, prov).catch(() => { throw new OAuthError('provider_error', 'could not build the client secret'); }) : prov.clientSecret;
  const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri(ctx, prov.id), code_verifier: verifier };
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (prov.authMethod === 'post') { form.client_id = prov.clientId; form.client_secret = secret; }
  else headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(prov.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  const r = await getJson(ctx, doc.token_endpoint, { method: 'POST', headers, body: new URLSearchParams(form) });
  if (!r.ok || typeof r.body?.id_token !== 'string') throw new OAuthError('provider_error', `token endpoint ${r.status}`);
  return r.body.id_token;
}

export async function verifyIdToken(ctx, prov, doc, idToken, nonce) {
  let claims;
  try {
    const kid = decodeProtectedHeader(idToken).kid;
    const jwks = await keySet(ctx, doc.jwks_uri, kid);
    const templated = doc.issuer.includes('{tenantid}');                 // Microsoft "common": the issuer names the signer's tenant
    const opts = { audience: prov.clientId, algorithms: ['RS256', 'ES256'], clockTolerance: 60, requiredClaims: ['exp', 'iat', 'sub', 'iss', 'aud'] };
    if (!templated) opts.issuer = doc.issuer;
    ({ payload: claims } = await jwtVerify(idToken, jwks, opts));
    if (templated && (typeof claims.tid !== 'string' || claims.iss !== doc.issuer.replace('{tenantid}', claims.tid))) throw new Error('issuer/tenant mismatch');
  } catch (e) {
    if (e instanceof OAuthError) throw e;
    throw new OAuthError('invalid_token', e.message);
  }
  const a = Buffer.from(String(claims.nonce || '')), b = Buffer.from(nonce);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new OAuthError('invalid_token', 'nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new OAuthError('invalid_token', 'bad subject');
  return claims;
}

// An email address is only used to find or create an account when the provider vouches for it.
// Microsoft work/school directories let users type any email into their profile, so only personal Microsoft accounts count.
export function trustedEmail(prov, claims) {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !email.includes('@')) return null;
  if (claims.email_verified === true || claims.email_verified === 'true') return email;
  if (prov.msa && claims.tid === MSA_TENANT) return email;
  return null;
}

// An account whose email was never verified might be a squat: someone registered a victim's address to wait for them.
// Before the real owner is let in, remove everything the squatter could have set: password, sessions, 2FA, phone.
async function neutraliseUnverifiedAccount(ctx, user, req) {
  await ctx.db.prepare(`UPDATE users SET password_hash = NULL, email_verified = 1, totp_enabled = 0, totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = -1,
    sms_mfa = 0, wa_mfa = 0, phone = NULL, phone_operator = NULL, phone_verified = 0, failed_attempts = 0, locked_until = 0 WHERE id = ?`).run(user.id);
  await ctx.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(user.id);
  await ctx.db.prepare('DELETE FROM mfa_pending WHERE user_id = ?').run(user.id);
  await revokeAllSessions(ctx, user.id);
  await audit(ctx, user.id, 'oauth_takeover_protection', req);
}

const attach = async (ctx, userId, provId, claims, email) => await ctx.db.prepare('INSERT INTO oauth_identities (user_id, provider, subject, email, created_at) VALUES (?,?,?,?,?)').run(userId, provId, claims.sub, email || null, ctx.now());

// Decide which account this provider identity belongs to. Returns the user row; throws OAuthError(code) for anything refused.
export async function resolveUser(ctx, prov, claims, { req, linkUserId }) {
  const db = ctx.db;
  const ident = await db.prepare('SELECT * FROM oauth_identities WHERE provider = ? AND subject = ?').get(prov.id, claims.sub);
  const email = trustedEmail(prov, claims);

  if (linkUserId) {
    if (!req.user || req.user.id !== linkUserId) throw new OAuthError('session_changed');
    if (ident && ident.user_id !== linkUserId) throw new OAuthError('identity_in_use');
    if (!ident) { await attach(ctx, linkUserId, prov.id, claims, email); await audit(ctx, linkUserId, 'oauth_linked', req, { provider: prov.id }); }
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(linkUserId);
  }

  if (ident) {
    if (email && email !== ident.email) await db.prepare('UPDATE oauth_identities SET email = ? WHERE id = ?').run(email, ident.id);
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(ident.user_id);
  }

  if (!email) throw new OAuthError('email_unverified');
  const existing = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    if (!existing.email_verified) await neutraliseUnverifiedAccount(ctx, existing, req);
    await attach(ctx, existing.id, prov.id, claims, email);
    await audit(ctx, existing.id, 'oauth_linked', req, { provider: prov.id, via: 'email' });
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }

  if (!ctx.config.allowRegistration) throw new OAuthError('registration_closed');
  const name = String(claims.name || '').trim().slice(0, 80) || email.split('@')[0];
  const id = await db.tx(async (t) => {
    const newId = await t.insert('INSERT INTO users (email, email_verified, password_hash, name, created_at) VALUES (?,1,NULL,?,?)', [email, name, ctx.now()]);
    await attach({ ...ctx, db: t }, newId, prov.id, claims, email);
    return newId;
  });
  await audit(ctx, id, 'register', req, { method: `oauth:${prov.id}` });
  return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export { sha256 };
