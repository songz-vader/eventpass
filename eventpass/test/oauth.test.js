import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, makeFakeFetch, registerUser, uniqueEmail, GOOD_PASSWORD } from './helpers.js';
import { totp } from '../server/lib/totp.js';

import { makeIdp, json } from './fake-idp.js';

const oauthCfg = (idp, extra = {}) => ({
  google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '', clientSecret: '' }, yahoo: { clientId: '', clientSecret: '' },
  extra: { testidp: { label: 'Test IdP', discovery: idp.issuer + '/.well-known/openid-configuration', clientId: idp.clientId, clientSecret: idp.clientSecret, scopes: 'openid email profile', ...extra } },
});

const person = (over = {}) => ({ sub: 'sub-' + crypto.randomUUID(), email: uniqueEmail('oauth'), name: 'Neema Joseph', email_verified: true, ...over });

// Runs the whole browser dance: start → provider approves → callback. Returns the callback response.
async function signIn(c, idp, user, { provider = 'testidp', qs = '', tweak, mutateCallback } = {}) {
  const start = await c.get(`/api/auth/oauth/${provider}/start${qs}`);
  assert.equal(start.status, 302, 'start should redirect: ' + start.text);
  const { code, state } = idp.authorize(start.headers.get('location'), user);
  idp.tweak = tweak || null;
  const q = new URLSearchParams({ code, state });
  mutateCallback?.(q);
  const cb = await c.get(`/api/auth/oauth/${provider}/callback?${q}`);
  idp.tweak = null;
  return cb;
}
const loc = (r) => r.headers.get('location') || '';
const errOf = (r) => new URL(loc(r), 'http://x').hash.match(/oauth_error=([a-z_]+)/)?.[1];

test('social sign-in (OpenID Connect)', async (t) => {
  const idp = await makeIdp();
  const s = await startTestServer({ fetch: idp.wrap(makeFakeFetch()), config: { oauth: oauthCfg(idp) } });
  t.after(() => s.close());

  await t.test('the config endpoint lists providers, enabled only when credentials are present', async () => {
    const r = await s.client().get('/api/public/config');
    const byId = Object.fromEntries(r.body.oauth.map((p) => [p.id, p]));
    assert.equal(byId.google.enabled, false);
    assert.equal(byId.testidp.enabled, true);
    assert.equal(byId.testidp.label, 'Test IdP');
    assert.ok(byId.google && byId.microsoft && byId.yahoo, 'the big three are always listed');
  });

  await t.test('start redirects to the provider with PKCE, state, nonce and a binding cookie', async () => {
    const c = s.client();
    const r = await c.get('/api/auth/oauth/testidp/start');
    assert.equal(r.status, 302);
    const u = new URL(loc(r));
    assert.equal(u.origin + u.pathname, 'https://idp.test/authorize');
    const p = u.searchParams;
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('client_id'), 'client-123');
    assert.equal(p.get('redirect_uri'), `${s.url}/api/auth/oauth/testidp/callback`);
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok(p.get('code_challenge').length >= 43);
    assert.ok(p.get('state').length >= 32 && p.get('nonce').length >= 16);
    assert.match(p.get('scope'), /openid/);
    assert.ok(r.setCookies.some((x) => /^ep_oauth=/.test(x) && /HttpOnly/i.test(x)), 'flow is bound to this browser');
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM oauth_states').get()).c >= 1, true);
  });

  await t.test('a disabled or unknown provider never redirects anywhere', async () => {
    const c = s.client();
    let r = await c.get('/api/auth/oauth/google/start');
    assert.equal(r.status, 302);
    assert.match(loc(r), /^\/#\/login\?oauth_error=provider_disabled/);
    r = await c.get('/api/auth/oauth/facebook/start');
    assert.match(loc(r), /oauth_error=provider_disabled/);
  });

  await t.test('first sign-in creates the account, verified and passwordless, and starts a session', async () => {
    const c = s.client(), u = person();
    const r = await signIn(c, idp, u);
    assert.equal(r.status, 302);
    assert.equal(loc(r), '/');
    const sess = await c.get('/api/auth/session');
    assert.equal(sess.body.authenticated, true);
    assert.equal(sess.body.user.email, u.email.toLowerCase());
    assert.equal(sess.body.user.name, 'Neema Joseph');
    assert.equal(sess.body.user.email_verified, true);
    assert.equal(sess.body.user.has_password, false);
    assert.equal(sess.body.user.providers[0].provider, 'testidp');
    assert.ok(sess.body.csrf, 'front end gets its CSRF token from the session call');
    assert.equal((await c.post('/api/events', { name: 'Mine', type: 'party' })).status, 201, 'and can immediately work');
  });

  await t.test('signing in again with the same identity reaches the same account, even if the email changed', async () => {
    const u = person();
    const a = s.client(), b = s.client();
    await signIn(a, idp, u);
    const id1 = (await a.get('/api/auth/session')).body.user.id;
    await signIn(b, idp, { ...u, email: uniqueEmail('renamed') });
    const sess = await b.get('/api/auth/session');
    assert.equal(sess.body.user.id, id1);
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(id1)).c, 1);
  });

  await t.test('a verified email links to the existing account with that email', async () => {
    const { email } = await registerUser(s);
    // verify the address the normal way first
    await s.db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
    const before = (await s.db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
    const c = s.client();
    await signIn(c, idp, person({ email }));
    assert.equal((await c.get('/api/auth/session')).body.user.id, before);
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(email)).c, 1);
    const pw = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal(pw.status, 200, 'the password still works for a verified account');
  });

  await t.test('pre-hijack defence: linking into a never-verified account wipes the squatter\'s password and sessions', async () => {
    const attacker = s.client();
    const email = uniqueEmail('victim');
    const reg = await attacker.post('/api/auth/register', { name: 'Squatter', email, password: GOOD_PASSWORD });
    assert.equal(reg.status, 201);
    assert.equal((await attacker.get('/api/account')).status, 200);
    const victim = s.client();
    await signIn(victim, idp, person({ email }));
    const sess = await victim.get('/api/auth/session');
    assert.equal(sess.body.user.email_verified, true);
    assert.equal(sess.body.user.has_password, false, 'the squatter\'s password is gone');
    assert.equal((await attacker.get('/api/account')).status, 401, 'the squatter\'s session is revoked');
    assert.equal((await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD })).status, 401);
  });

  await t.test('an unverified email from the provider is never trusted for linking or account creation', async () => {
    const { email } = await registerUser(s);
    await s.db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
    const c = s.client();
    let r = await signIn(c, idp, person({ email, email_verified: false }));
    assert.equal(errOf(r), 'email_unverified');
    assert.equal((await c.get('/api/auth/session')).body.authenticated, false);
    r = await signIn(s.client(), idp, person({ email_verified: false }));
    assert.equal(errOf(r), 'email_unverified');
  });

  await t.test('state and cookie protections: wrong state, missing cookie, reused state, other provider', async () => {
    const u = person();
    // tampered state
    let c = s.client();
    let r = await signIn(c, idp, u, { mutateCallback: (q) => q.set('state', 'x'.repeat(43)) });
    assert.equal(errOf(r), 'invalid_state');
    // no binding cookie (as if the callback link was opened in a different browser)
    c = s.client();
    const start = await c.get('/api/auth/oauth/testidp/start');
    const { code, state } = idp.authorize(loc(start), u);
    r = await s.client().get(`/api/auth/oauth/testidp/callback?code=${code}&state=${state}`);
    assert.equal(errOf(r), 'invalid_state');
    // replay the same callback in the right browser twice: the first works, the second is refused
    r = await c.get(`/api/auth/oauth/testidp/callback?code=${code}&state=${state}`);
    assert.equal(loc(r), '/');
    r = await c.get(`/api/auth/oauth/testidp/callback?code=${code}&state=${state}`);
    assert.equal(errOf(r), 'invalid_state');
    // expired
    c = s.client();
    const st2 = await c.get('/api/auth/oauth/testidp/start');
    const a2 = idp.authorize(loc(st2), person());
    await s.db.prepare('UPDATE oauth_states SET expires_at = 0').run();
    r = await c.get(`/api/auth/oauth/testidp/callback?code=${a2.code}&state=${a2.state}`);
    assert.equal(errOf(r), 'invalid_state');
  });

  await t.test('a provider-side denial is reported as cancelled, without echoing provider text', async () => {
    const c = s.client();
    await c.get('/api/auth/oauth/testidp/start');
    const st = await s.db.prepare('SELECT state FROM oauth_states ORDER BY created_at DESC').get();
    const r = await c.get(`/api/auth/oauth/testidp/callback?error=access_denied&error_description=%3Cscript%3E&state=${st.state}`);
    assert.equal(errOf(r), 'cancelled');
    assert.ok(!loc(r).includes('script'));
  });

  await t.test('ID token checks: audience, issuer, nonce, expiry and signature are all enforced', async () => {
    const cases = {
      audience: (p) => { p.aud = 'someone-else'; },
      issuer: (p) => { p.iss = 'https://evil.test'; },
      nonce: (p) => { p.nonce = 'not-the-nonce'; },
      expired: (p) => { p.exp = Math.floor(Date.now() / 1000) - 3600; },
      no_sub: (p) => { delete p.sub; },
    };
    for (const [name, tweak] of Object.entries(cases)) {
      const c = s.client();
      const r = await signIn(c, idp, person(), { tweak });
      assert.equal(errOf(r), 'invalid_token', name);
      assert.equal((await c.get('/api/auth/session')).body.authenticated, false, name);
    }
    idp.useRogue = true;                                                       // same key id, different private key
    const c = s.client();
    const r = await signIn(c, idp, person());
    idp.useRogue = false;
    assert.equal(errOf(r), 'invalid_token', 'forged signature');
    assert.equal((await c.get('/api/auth/session')).body.authenticated, false);
  });

  await t.test('a failing token endpoint gives a friendly error and no session', async () => {
    idp.tokenStatus = 500;
    const c = s.client();
    const r = await signIn(c, idp, person());
    idp.tokenStatus = 200;
    assert.equal(errOf(r), 'provider_error');
    assert.equal((await c.get('/api/auth/session')).body.authenticated, false);
  });

  await t.test('signing keys are cached, and a rotated key is picked up automatically', async () => {
    await signIn(s.client(), idp, person());
    const before = idp.jwksFetches;
    await signIn(s.client(), idp, person());
    assert.equal(idp.jwksFetches, before, 'cached');
    await idp.rotate();
    const c = s.client();
    const r = await signIn(c, idp, person());
    assert.equal(loc(r), '/', 'new key id triggers one refetch');
    assert.equal(idp.jwksFetches, before + 1);
  });

  await t.test('two-factor still applies: the callback hands over to the second step instead of signing in', async () => {
    const u = person();
    const c = s.client();
    await signIn(c, idp, u);
    await c.get('/api/auth/session');                                          // the front end fetches its CSRF token this way
    const setup = await c.post('/api/account/mfa/totp/setup');
    assert.equal(setup.status, 200, setup.text);
    assert.equal((await c.post('/api/account/mfa/totp/enable', { code: totp(setup.body.secret, { now: s.ctx.now() }) })).status, 200);
    const real = s.ctx.now;
    s.ctx.now = () => real() + 120_000;                                        // move to a fresh TOTP step
    try {
      const c2 = s.client();
      const r = await signIn(c2, idp, u);
      assert.match(loc(r), /^\/#\/mfa\/[A-Za-z0-9_-]{20,}$/);
      assert.equal((await c2.get('/api/auth/session')).body.authenticated, false, 'not signed in yet');
      const token = loc(r).split('/').pop();
      const info = await s.client().post('/api/auth/mfa/info', { mfa_token: token });
      assert.equal(info.status, 200, info.text);
      assert.ok(info.body.methods.includes('totp'));
      assert.equal((await s.client().post('/api/auth/mfa/info', { mfa_token: 'nope'.repeat(6) })).status, 401);
      const bad = await c2.post('/api/auth/mfa/verify', { mfa_token: token, method: 'totp', code: '000000' });
      assert.equal(bad.status, 401);
      const ok = await c2.post('/api/auth/mfa/verify', { mfa_token: token, method: 'totp', code: totp(setup.body.secret, { now: s.ctx.now() }) });
      assert.equal(ok.status, 200, ok.text);
      assert.equal((await c2.get('/api/auth/session')).body.authenticated, true);
    } finally { s.ctx.now = real; }
  });

  await t.test('an account can connect a provider from settings, and cannot steal another account\'s identity', async () => {
    const { c } = await registerUser(s);
    const me = person();
    let r = await signIn(c, idp, me, { qs: '?mode=link' });
    assert.equal(loc(r), '/#/account?linked=testidp');
    assert.equal((await c.get('/api/account')).body.user.providers[0].provider, 'testidp');
    // someone else tries to connect the very same provider identity
    const other = await registerUser(s);
    r = await signIn(other.c, idp, me, { qs: '?mode=link' });
    assert.match(loc(r), /^\/#\/account\?oauth_error=identity_in_use/);
    // link mode needs a session
    r = await s.client().get('/api/auth/oauth/testidp/start?mode=link');
    assert.match(loc(r), /oauth_error=login_required/);
  });

  await t.test('link flow is tied to the session that started it', async () => {
    const a = await registerUser(s), b = await registerUser(s);
    const start = await a.c.get('/api/auth/oauth/testidp/start?mode=link');
    const { code, state } = idp.authorize(loc(start), person());
    // the victim's browser carries the attacker's state cookie but a different session
    b.c.jar.set('ep_oauth', a.c.jar.get('ep_oauth'));
    const r = await b.c.get(`/api/auth/oauth/testidp/callback?code=${code}&state=${state}`);
    assert.match(loc(r), /oauth_error=session_changed/);
    assert.equal((await b.c.get('/api/account')).body.user.providers.length, 0);
  });

  await t.test('disconnecting a provider needs the password, and never removes the last way to sign in', async () => {
    const { c, email } = await registerUser(s);
    await signIn(c, idp, person(), { qs: '?mode=link' });
    assert.equal((await c.del('/api/account/providers/testidp', { password: 'wrong-password-123' })).status, 403);
    const ok = await c.del('/api/account/providers/testidp', { password: GOOD_PASSWORD });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.user.providers.length, 0);
    // an account that only has the provider cannot disconnect it
    const solo = s.client();
    await signIn(solo, idp, person());
    await solo.get('/api/auth/session');
    const r = await solo.del('/api/account/providers/testidp', {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'last_login_method');
    // …until it has a password
    assert.equal((await solo.post('/api/account/password', { new_password: 'kiboko-na-mbuzi-2026-x' })).status, 200);
    assert.equal((await solo.del('/api/account/providers/testidp', { password: 'kiboko-na-mbuzi-2026-x' })).status, 200);
    void email;
  });
});

test('social sign-in when sign-ups are closed', async (t) => {
  const idp = await makeIdp();
  const s = await startTestServer({ fetch: idp.wrap(makeFakeFetch()), env: { ALLOW_REGISTRATION: 'false' }, config: { oauth: oauthCfg(idp) } });
  t.after(() => s.close());
  const r = await signIn(s.client(), idp, person());
  assert.equal(errOf(r), 'registration_closed');
  assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM users').get()).c, 0);
});

test('the built-in providers', async (t) => {
  await t.test('Google, Microsoft and Yahoo use their real discovery documents and redirect URIs', async () => {
    const seen = [];
    const base = makeFakeFetch();
    const f = async (url, init) => {
      const u = String(url); seen.push(u);
      const host = new URL(u).origin;
      if (u.endsWith('/.well-known/openid-configuration')) return json(200, { issuer: host === 'https://login.microsoftonline.com' ? 'https://login.microsoftonline.com/{tenantid}/v2.0' : host, authorization_endpoint: host + '/authorize', token_endpoint: host + '/token', jwks_uri: host + '/keys' });
      return base(url, init);
    };
    f.calls = base.calls; f.state = base.state;
    const s = await startTestServer({ fetch: f, config: { oauth: { google: { clientId: 'g-id', clientSecret: 'g-s' }, microsoft: { clientId: 'm-id', clientSecret: 'm-s' }, yahoo: { clientId: 'y-id', clientSecret: 'y-s' }, extra: {} } } });
    t.after(() => s.close());
    const c = s.client();
    const want = { google: 'https://accounts.google.com/.well-known/openid-configuration', microsoft: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', yahoo: 'https://api.login.yahoo.com/.well-known/openid-configuration' };
    for (const [id, disc] of Object.entries(want)) {
      const r = await c.get(`/api/auth/oauth/${id}/start`);
      assert.equal(r.status, 302, id);
      assert.ok(seen.includes(disc), `${id} discovery ${disc}`);
      const u = new URL(loc(r));
      assert.equal(u.searchParams.get('redirect_uri'), `${s.url}/api/auth/oauth/${id}/callback`);
      assert.equal(u.searchParams.get('client_id'), { google: 'g-id', microsoft: 'm-id', yahoo: 'y-id' }[id]);
      assert.match(u.searchParams.get('scope'), /openid/);
    }
  });

  await t.test('Microsoft: tenant-templated issuer is accepted; work/school email is not trusted, personal accounts are', async () => {
    const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
    const idp = await makeIdp({ issuer: 'https://login.microsoftonline.com' });
    const tenants = { work: 'aaaaaaaa-1111-2222-3333-444444444444', personal: MSA_TENANT };
    const base = makeFakeFetch();
    const f = async (url, init) => {
      const u = String(url);
      if (u === 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration') return json(200, { issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0', authorization_endpoint: idp.issuer + '/authorize', token_endpoint: idp.issuer + '/token', jwks_uri: idp.issuer + '/jwks' });
      return idp.wrap(base)(url, init);
    };
    f.calls = base.calls; f.state = base.state;
    const s = await startTestServer({ fetch: f, config: { oauth: { google: { clientId: '', clientSecret: '' }, microsoft: { clientId: idp.clientId, clientSecret: idp.clientSecret }, yahoo: { clientId: '', clientSecret: '' }, extra: {} } } });
    t.after(() => s.close());
    const asTenant = (tid) => (p) => { p.tid = tid; p.iss = `https://login.microsoftonline.com/${tid}/v2.0`; delete p.email_verified; };
    // personal Microsoft account (outlook.com / hotmail / live): email is verified by Microsoft
    let c = s.client();
    let r = await signIn(c, idp, person(), { provider: 'microsoft', tweak: asTenant(tenants.personal) });
    assert.equal(loc(r), '/', 'personal account signs in');
    // work/school directory: the email claim is user-editable, so it cannot create an account
    c = s.client();
    r = await signIn(c, idp, person(), { provider: 'microsoft', tweak: asTenant(tenants.work) });
    assert.equal(errOf(r), 'email_unverified');
    // issuer that does not match its own tenant id is rejected
    c = s.client();
    r = await signIn(c, idp, person(), { provider: 'microsoft', tweak: (p) => { asTenant(tenants.personal)(p); p.iss = 'https://login.microsoftonline.com/some-other-tenant/v2.0'; } });
    assert.equal(errOf(r), 'invalid_token');
  });
});
