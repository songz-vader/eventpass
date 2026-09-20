import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser, uniqueEmail, GOOD_PASSWORD } from './helpers.js';

test('auth', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('security headers are set and framework fingerprint is hidden', async () => {
    const c = s.client();
    const r = await c.get('/api/public/config');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-powered-by'), null);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'no inline scripts allowed');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('referrer-policy'));
  });

  await t.test('register creates the account, logs in, and sets a hardened cookie', async () => {
    const { r, c, email } = await registerUser(s);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.user.email, email);
    assert.equal(r.body.user.email_verified, false);
    assert.ok(r.body.csrf);
    assert.equal(r.body.user.password_hash, undefined, 'never leak the hash');
    const sc = r.setCookies[0];
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Path=\//);
    const me = await c.get('/api/auth/session');
    assert.equal(me.body.authenticated, true);
    assert.equal(me.body.user.email, email);
    // the account really exists in the backend database
    const row = await s.db.prepare('SELECT email, password_hash FROM users WHERE email = ?').get(email);
    assert.ok(row.password_hash.startsWith('scrypt$'));
    assert.equal(s.mailer.outbox.some((m) => m.to === email), true, 'verification email sent');
  });

  await t.test('rejects weak passwords, bad emails, disposable domains and duplicates', async () => {
    const c = s.client();
    let r = await c.post('/api/auth/register', { name: 'A', email: uniqueEmail(), password: 'short' });
    assert.equal(r.status, 400);
    r = await c.post('/api/auth/register', { name: 'A', email: 'not-an-email', password: GOOD_PASSWORD });
    assert.equal(r.status, 400);
    r = await c.post('/api/auth/register', { name: 'A', email: 'x@mailinator.com', password: GOOD_PASSWORD });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'disposable_email');
    const { email } = await registerUser(s);
    r = await s.client().post('/api/auth/register', { name: 'B', email: email.toUpperCase(), password: GOOD_PASSWORD });
    assert.equal(r.status, 409, 'email match is case-insensitive');
  });

  await t.test('login: right password works, wrong password and unknown email give the same generic error', async () => {
    const { email } = await registerUser(s);
    const ok = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.user);
    const bad = await s.client().post('/api/auth/login', { email, password: 'wrong-password-123' });
    const none = await s.client().post('/api/auth/login', { email: uniqueEmail('ghost'), password: 'wrong-password-123' });
    assert.equal(bad.status, 401);
    assert.equal(none.status, 401);
    assert.deepEqual(bad.body, none.body, 'no account enumeration via login');
  });

  await t.test('lockout: repeated failures lock the account, even against the right password', async () => {
    const { email } = await registerUser(s);
    const c = s.client();
    for (let i = 0; i < s.config.lockout.threshold; i++) await c.post('/api/auth/login', { email, password: 'nope-nope-nope' });
    const locked = await c.post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'account_locked');
    assert.ok(locked.body.error.retry_after > 0);
  });

  await t.test('state-changing requests need the CSRF token and a same-origin Origin header', async () => {
    const { c } = await registerUser(s);
    let r = await c.post('/api/events', { name: 'x' }, { headers: { 'x-csrf-token': 'wrong' } });
    assert.equal(r.status, 403);
    r = await c.post('/api/events', { name: 'x' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await c.post('/api/events', { name: 'ok event' });
    assert.equal(r.status, 201);
  });

  await t.test('logout destroys the session server-side', async () => {
    const { c } = await registerUser(s);
    const stolen = c.cookieHeader();
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    const replay = await fetch(s.url + '/api/auth/session', { headers: { cookie: stolen } });
    assert.equal((await replay.json()).authenticated, false, 'old cookie is dead');
  });

  await t.test('protected routes reject anonymous callers', async () => {
    const c = s.client();
    for (const p of ['/api/events', '/api/guests', '/api/account', '/api/overview', '/api/messaging/channels']) {
      assert.equal((await c.get(p)).status, 401, p);
    }
  });

  await t.test('email verification link works once', async () => {
    const { c, email } = await registerUser(s);
    const token = s.mailToken(email, 'verify');
    assert.ok(token, 'token in email');
    let r = await s.client().post('/api/auth/email/verify', { token });
    assert.equal(r.status, 200);
    assert.equal((await c.get('/api/auth/session')).body.user.email_verified, true);
    r = await s.client().post('/api/auth/email/verify', { token });
    assert.equal(r.status, 400, 'single use');
    assert.equal((await s.client().post('/api/auth/email/verify', { token: 'garbage' })).status, 400);
  });

  await t.test('password reset: never reveals accounts, token is single use, old sessions are revoked', async () => {
    const { c, email } = await registerUser(s);
    const unknown = await s.client().post('/api/auth/password/forgot', { email: uniqueEmail('nobody') });
    const known = await s.client().post('/api/auth/password/forgot', { email });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, known.body);
    const token = s.mailToken(email, 'reset');
    assert.ok(token);
    const newPw = 'nyati-mwekundu-anaruka-9';
    let r = await s.client().post('/api/auth/password/reset', { token, password: newPw });
    assert.equal(r.status, 200);
    assert.equal((await s.client().post('/api/auth/password/reset', { token, password: newPw })).status, 400);
    assert.equal((await c.get('/api/auth/session')).body.authenticated, false, 'existing session revoked');
    assert.equal((await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD })).status, 401);
    assert.equal((await s.client().post('/api/auth/login', { email, password: newPw })).status, 200);
    assert.equal((await s.client().post('/api/auth/password/reset', { token: 'x', password: newPw })).status, 400);
  });

  await t.test('public config advertises what the backend supports (drives the front end)', async () => {
    const r = await s.client().get('/api/public/config');
    assert.equal(r.body.registration, true);
    assert.ok(Array.isArray(r.body.oauth));
    assert.deepEqual(r.body.oauth.map((p) => p.id).sort(), ['apple', 'google', 'microsoft', 'yahoo']);
    assert.ok(r.body.oauth.every((p) => p.enabled === false), 'not configured → not enabled');
    assert.equal(r.body.mfa.totp, true);
    assert.equal(r.body.regions.length, 31);
    assert.ok(r.body.templateVars.includes('MAP'));
    assert.ok(r.body.tabs.some((x) => x.id === 'messages'), 'server-declared tabs');
  });
});
