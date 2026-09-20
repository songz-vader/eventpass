import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateKeyPair, exportPKCS8, jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import { startTestServer, makeFakeFetch, uniqueEmail } from './helpers.js';
import { makeIdp } from './fake-idp.js';

const TEAM = 'TEAM123456', KEY_ID = 'KEYID12345', SERVICE = 'com.example.eventpass.web';
const loc = (r) => r.headers.get('location') || '';
const errOf = (r) => new URL(loc(r), 'http://x').hash.match(/oauth_error=([a-z_]+)/)?.[1];
const person = (over = {}) => ({ sub: '001234.' + crypto.randomUUID().replace(/-/g, ''), email: uniqueEmail('apple'), name: null, email_verified: 'true', ...over });   // Apple sends email_verified as the string "true"

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const pem = await exportPKCS8(privateKey);

async function setup(t, appleCfg = { clientId: SERVICE, teamId: TEAM, keyId: KEY_ID, privateKey: pem }) {
  const idp = await makeIdp({
    issuer: 'https://appleid.apple.com', clientId: SERVICE, authStyle: 'post',
    verifySecret: async (jwt) => {                                         // Apple's rules for the client secret
      try {
        const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, { issuer: TEAM, audience: 'https://appleid.apple.com', subject: SERVICE, algorithms: ['ES256'] });
        return protectedHeader.kid === KEY_ID && payload.exp - payload.iat <= 15_777_000;   // at most six months
      } catch { return false; }
    },
  });
  const s = await startTestServer({ fetch: idp.wrap(makeFakeFetch()), config: { oauth: { google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '', clientSecret: '' }, yahoo: { clientId: '', clientSecret: '' }, apple: appleCfg, extra: {} } } });
  t.after(() => s.close());
  return { idp, s };
}

// What really happens: the browser goes to Apple, and Apple POSTs the result to us from its own site
// (foreign Origin, and no cookies because ours are SameSite=Lax). We bounce it back as a same-site GET.
async function appleSignIn({ s, idp }, c, user, { userParam, extra = {} } = {}) {
  const start = await c.get('/api/auth/oauth/apple/start');
  assert.equal(start.status, 302, start.text);
  const { code, state, params } = idp.authorize(loc(start), user);
  const fields = { code, state, ...(userParam ? { user: JSON.stringify(userParam) } : {}), ...extra };
  const post = await s.client().req('POST', '/api/auth/oauth/apple/callback', new URLSearchParams(fields).toString(), { raw: true, origin: 'https://appleid.apple.com', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { start, params, post, state, code, finish: () => c.get(loc(post)) };
}

test('Sign in with Apple', async (t) => {
  const env = await setup(t);
  const { idp, s } = env;

  await t.test('is offered only when all four Apple credentials are set', async () => {
    const on = (await s.client().get('/api/public/config')).body.oauth.find((p) => p.id === 'apple');
    assert.deepEqual([on.label, on.enabled], ['Apple', true]);
    for (const missing of ['clientId', 'teamId', 'keyId', 'privateKey']) {
      const other = await startTestServer({ config: { oauth: { google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '', clientSecret: '' }, yahoo: { clientId: '', clientSecret: '' }, apple: { clientId: SERVICE, teamId: TEAM, keyId: KEY_ID, privateKey: pem, [missing]: '' }, extra: {} } } });
      const p = (await other.client().get('/api/public/config')).body.oauth.find((x) => x.id === 'apple');
      assert.equal(p.enabled, false, `without ${missing}`);
      await other.close();
    }
  });

  await t.test('start asks Apple for name and email, and for the result to be posted back', async () => {
    const r = await s.client().get('/api/auth/oauth/apple/start');
    const u = new URL(loc(r)); const p = u.searchParams;
    assert.equal(u.origin + u.pathname, 'https://appleid.apple.com/authorize');
    assert.equal(p.get('response_mode'), 'form_post', 'required by Apple whenever name or email is requested');
    assert.equal(p.get('scope'), 'name email');
    assert.equal(p.get('client_id'), SERVICE);
    assert.equal(p.get('redirect_uri'), `${s.url}/api/auth/oauth/apple/callback`);
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('code_challenge_method'), 'S256');
  });

  await t.test('the form_post result is bounced back as a same-site GET, and only the expected fields survive', async () => {
    const c = s.client();
    const a = await appleSignIn(env, c, person(), { extra: { evil: 'https://evil.test', code_extra: 'x' } });
    assert.equal(a.post.status, 303);
    assert.equal(a.post.setCookies.length, 0, 'the bounce sets nothing');
    const to = new URL(loc(a.post), s.url);
    assert.equal(to.pathname, '/api/auth/oauth/apple/callback');
    assert.deepEqual([...to.searchParams.keys()].sort(), ['code', 'state']);
    assert.ok(!loc(a.post).includes('evil'));
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM oauth_states WHERE state = ?').get(a.state)).c, 1, 'the bounce does not use up the state');
    assert.equal((await c.get('/api/auth/session')).body.authenticated, false, 'and does not sign anyone in');
    const done = await a.finish();
    assert.equal(loc(done), '/');
    assert.equal((await c.get('/api/auth/session')).body.authenticated, true);
  });

  await t.test('the client secret is a short-lived ES256 JWT from the .p8 key, sent in the body rather than as a Basic header', async () => {
    const before = idp.tokenRequests.length;
    const a = await appleSignIn(env, s.client(), person());
    await a.finish();
    const req = idp.tokenRequests[before];
    assert.equal(req.body.client_id, SERVICE);
    assert.ok(!req.headers.Authorization && !req.headers.authorization);
    const hdr = decodeProtectedHeader(req.body.client_secret), pl = decodeJwt(req.body.client_secret);
    assert.deepEqual([hdr.alg, hdr.kid], ['ES256', KEY_ID]);
    assert.deepEqual([pl.iss, pl.sub, pl.aud], [TEAM, SERVICE, 'https://appleid.apple.com']);
    assert.ok(pl.exp - pl.iat <= 600, 'we mint a fresh five-minute secret rather than keeping a long-lived one');
    assert.ok(req.body.code_verifier);
  });

  await t.test('the name Apple sends once is used for a new account; the email always comes from the signed token', async () => {
    const u = person();
    const c = s.client();
    const a = await appleSignIn(env, c, u, { userParam: { name: { firstName: 'Neema', lastName: 'Joseph' }, email: 'victim@example.com' } });
    assert.match(loc(a.post), /user=/);
    await a.finish();
    const me = (await c.get('/api/auth/session')).body.user;
    assert.equal(me.name, 'Neema Joseph');
    assert.equal(me.email, u.email.toLowerCase(), 'the unsigned "user" field cannot choose the email');
    assert.equal(me.email_verified, true);
    assert.equal((await s.db.prepare("SELECT COUNT(*) c FROM users WHERE email = 'victim@example.com'").get()).c, 0);
  });

  await t.test('later sign-ins need no name or email from Apple', async () => {
    const u = person();
    const first = s.client(); await (await appleSignIn(env, first, u, { userParam: { name: { firstName: 'Asha', lastName: 'M' } } })).finish();
    const id = (await first.get('/api/auth/session')).body.user.id;
    const again = s.client();
    await (await appleSignIn(env, again, { ...u, email: undefined })).finish();     // Apple omits the email after the first time
    const me = (await again.get('/api/auth/session')).body.user;
    assert.equal(me.id, id); assert.equal(me.name, 'Asha M');
  });

  await t.test('a hidden "Private Relay" address works like any other verified email', async () => {
    const c = s.client();
    await (await appleSignIn(env, c, person({ email: 'x7k2p9@privaterelay.appleid.com', extra: { is_private_email: 'true' } }))).finish();
    assert.equal((await c.get('/api/auth/session')).body.user.email, 'x7k2p9@privaterelay.appleid.com');
  });

  await t.test('an unverified email claim is not trusted', async () => {
    const c = s.client();
    const a = await appleSignIn(env, c, person({ email_verified: 'false' }));
    assert.equal(errOf(await a.finish()), 'email_unverified');
  });

  await t.test('cancelling on Apple\'s screen comes back as a friendly "cancelled"', async () => {
    const c = s.client();
    const start = await c.get('/api/auth/oauth/apple/start');
    const state = new URL(loc(start)).searchParams.get('state');
    const post = await s.client().req('POST', '/api/auth/oauth/apple/callback', new URLSearchParams({ error: 'user_cancelled_authorize', state }).toString(), { raw: true, origin: 'https://appleid.apple.com', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(post.status, 303);
    assert.equal(errOf(await c.get(loc(post))), 'cancelled');
  });

  await t.test('the Origin exemption covers only the sign-in bounce, nothing else', async () => {
    const form = { raw: true, origin: 'https://appleid.apple.com', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
    assert.equal((await s.client().req('POST', '/api/auth/login', 'email=a&password=b', form)).status, 403);
    assert.equal((await s.client().req('POST', '/api/auth/oauth/BAD!/callback', 'code=x', form)).status, 403, 'a malformed provider name is not exempt');
    assert.equal((await s.client().req('POST', '/api/auth/oauth/BAD!/callback', 'code=x', { ...form, origin: s.url })).status, 404);
    const big = await s.client().req('POST', '/api/auth/oauth/apple/callback', new URLSearchParams({ code: 'x'.repeat(5000), state: 's' }).toString(), form);
    assert.equal(big.status, 303);
    assert.ok(!loc(big).includes('xxxxx'), 'oversized values are dropped, not echoed');
    assert.equal((await s.client().post('/api/scan/checkin', {}, { origin: 'https://appleid.apple.com' })).status, 403);
  });
});
