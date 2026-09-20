import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser, GOOD_PASSWORD } from './helpers.js';
import { totp } from '../server/lib/totp.js';

const PLATFORM_ENV = {
  PLATFORM_AT_USERNAME: 'sandbox', PLATFORM_AT_API_KEY: 'plat-key',
  PLATFORM_WA_PHONE_ID: '5550001', PLATFORM_WA_TOKEN: 'wa-token', PLATFORM_WA_OTP_TEMPLATE: 'ep_login_code',
};

// advance the server's clock so OTP cooldowns / TOTP steps roll over without sleeping
function clock(s) { let off = 0; s.ctx.now = () => Date.now() + off; return (ms) => { off += ms; }; }

async function verifiedPhoneUser(s, phone = '0712 345 678') {
  const { c, email } = await registerUser(s);
  let r = await c.post('/api/account/phone', { phone });
  assert.equal(r.status, 200, r.text);
  const code = s.lastOtp();
  r = await c.post('/api/account/phone/verify', { code });
  assert.equal(r.status, 200, r.text);
  return { c, email };
}

test('phone connector', async (t) => {
  const s = await startTestServer({ env: PLATFORM_ENV });
  t.after(() => s.close());

  await t.test('normalises the number, texts a code via the platform SMS account, and verifies it', async () => {
    const { c } = await registerUser(s);
    const r = await c.post('/api/account/phone', { phone: '0754 123 456' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.to, '+255 7•• ••• 456');
    assert.equal(r.body.operator, 'Vodacom');
    const call = s.fetch.calls.at(-1);
    assert.match(call.url, /api\.sandbox\.africastalking\.com/, 'sandbox username → sandbox host');
    assert.equal(call.body.to, '+255754123456');
    assert.equal(call.headers.apiKey, 'plat-key');
    assert.match(call.body.message, /Your EventPass code is \d{6}/);
    let v = await c.post('/api/account/phone/verify', { code: '000000' });
    assert.equal(v.status, 400);
    v = await c.post('/api/account/phone/verify', { code: s.lastOtp() });
    assert.equal(v.status, 200);
    assert.equal(v.body.user.phone_verified, true);
    assert.equal(v.body.user.phone, '+255754123456');
  });

  await t.test('rejects landlines and garbage', async () => {
    const { c } = await registerUser(s);
    assert.equal((await c.post('/api/account/phone', { phone: '022 212 3456' })).status, 400);
    assert.equal((await c.post('/api/account/phone', { phone: 'hello' })).status, 400);
  });

  await t.test('a code cannot be guessed: 5 wrong tries burn it', async () => {
    const { c } = await registerUser(s);
    await c.post('/api/account/phone', { phone: '0713000111' });
    const real = s.lastOtp();
    for (let i = 0; i < 5; i++) await c.post('/api/account/phone/verify', { code: real === '111111' ? '222222' : '111111' });
    const r = await c.post('/api/account/phone/verify', { code: real });
    assert.equal(r.status, 400, 'right code no longer works after too many wrong ones');
  });

  await t.test('resending too fast is blocked (cooldown), protecting your SMS bill', async () => {
    const { c } = await registerUser(s);
    assert.equal((await c.post('/api/account/phone', { phone: '0713000222' })).status, 200);
    const r = await c.post('/api/account/phone', { phone: '0713000222' });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'otp_cooldown');
  });

  await t.test('a verified number belongs to one account only', async () => {
    await verifiedPhoneUser(s, '0765 000 999');
    const { c } = await registerUser(s);
    const r = await c.post('/api/account/phone', { phone: '0765000999' });
    assert.equal(r.status, 409);
  });

  await t.test('WhatsApp codes use the approved authentication template', async () => {
    const { c } = await registerUser(s);
    const r = await c.post('/api/account/phone', { phone: '0784 555 666', channel: 'whatsapp' });
    assert.equal(r.status, 200, r.text);
    const call = s.fetch.calls.at(-1);
    assert.match(call.url, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/5550001\/messages$/);
    assert.equal(call.body.type, 'template');
    assert.equal(call.body.template.name, 'ep_login_code');
    assert.equal(call.body.to, '255784555666');
    const code = call.body.template.components[0].parameters[0].text;
    assert.match(code, /^\d{6}$/);
    assert.equal(call.body.template.components[1].sub_type, 'url', 'copy-code button param');
    assert.equal((await c.post('/api/account/phone/verify', { code })).status, 200);
  });
});

test('two-factor authentication', async (t) => {
  const s = await startTestServer({ env: PLATFORM_ENV });
  t.after(() => s.close());
  const advance = clock(s);

  await t.test('authenticator app: setup → enable → login demands a code → replay is refused', async () => {
    const { c, email } = await registerUser(s);
    const setup = await c.post('/api/account/mfa/totp/setup');
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.uri, /^otpauth:\/\/totp\//);
    assert.match(setup.body.qr, /^data:image\//);

    assert.equal((await c.post('/api/account/mfa/totp/enable', { code: '123456' })).status, 400);
    const en = await c.post('/api/account/mfa/totp/enable', { code: totp(setup.body.secret, { now: s.ctx.now() }) });
    assert.equal(en.status, 200, en.text);
    assert.equal(en.body.backup_codes.length, 10);
    assert.equal(en.body.user.mfa.totp, true);
    // the secret is encrypted at rest
    const stored = (await s.db.prepare('SELECT totp_secret_enc FROM users WHERE email = ?').get(email)).totp_secret_enc;
    assert.ok(!stored.includes(setup.body.secret));

    advance(31_000);
    const login = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.mfa_required, true);
    assert.equal(login.body.user, undefined, 'no session yet');
    assert.ok(login.body.methods.includes('totp') && login.body.methods.includes('backup'));

    const code = totp(setup.body.secret, { now: s.ctx.now() });
    const c2 = s.client();
    const step2 = await c2.post('/api/auth/mfa/verify', { mfa_token: login.body.mfa_token, method: 'totp', code });
    assert.equal(step2.status, 200, step2.text);
    assert.equal((await c2.get('/api/auth/session')).body.authenticated, true);

    const login2 = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    const replay = await s.client().post('/api/auth/mfa/verify', { mfa_token: login2.body.mfa_token, method: 'totp', code });
    assert.equal(replay.status, 401, 'same code cannot be used twice');
  });

  await t.test('wrong codes: 5 tries and the sign-in attempt is dead', async () => {
    const { c, email } = await registerUser(s);
    const setup = await c.post('/api/account/mfa/totp/setup');
    await c.post('/api/account/mfa/totp/enable', { code: totp(setup.body.secret, { now: s.ctx.now() }) });
    advance(31_000);
    const login = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    const tok = login.body.mfa_token;
    let last;
    for (let i = 0; i < 5; i++) last = await s.client().post('/api/auth/mfa/verify', { mfa_token: tok, method: 'totp', code: '000000' });
    assert.equal(last.status, 401);
    const good = await s.client().post('/api/auth/mfa/verify', { mfa_token: tok, method: 'totp', code: totp(setup.body.secret, { now: s.ctx.now() }) });
    assert.equal(good.status, 401, 'even the right code fails once the attempt is burned');
    assert.equal(good.body.error.code, 'mfa_expired');
  });

  await t.test('backup codes work once each', async () => {
    const { c, email } = await registerUser(s);
    const setup = await c.post('/api/account/mfa/totp/setup');
    const en = await c.post('/api/account/mfa/totp/enable', { code: totp(setup.body.secret, { now: s.ctx.now() }) });
    const [first] = en.body.backup_codes;
    const l1 = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal((await s.client().post('/api/auth/mfa/verify', { mfa_token: l1.body.mfa_token, method: 'backup', code: first.toLowerCase() })).status, 200, 'case-insensitive');
    const l2 = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal((await s.client().post('/api/auth/mfa/verify', { mfa_token: l2.body.mfa_token, method: 'backup', code: first })).status, 401, 'used already');
  });

  await t.test('SMS 2FA needs a verified phone, then sends a code at login', async () => {
    const { c, email } = await registerUser(s);
    let r = await c.post('/api/account/mfa/otp/send', { method: 'sms' });
    assert.equal(r.status, 400, 'no verified phone yet');
    await c.post('/api/account/phone', { phone: '0754 999 000' });
    await c.post('/api/account/phone/verify', { code: s.lastOtp() });
    advance(61_000);
    r = await c.post('/api/account/mfa/otp/send', { method: 'sms' });
    assert.equal(r.status, 200, r.text);
    r = await c.post('/api/account/mfa/otp/enable', { method: 'sms', code: s.lastOtp() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.user.mfa.sms, true);
    assert.equal(r.body.backup_codes.length, 10, 'first 2FA method also issues backup codes');

    const login = await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal(login.body.mfa_required, true);
    assert.deepEqual(login.body.methods.filter((m) => m !== 'backup'), ['sms']);
    advance(61_000);
    const send = await s.client().post('/api/auth/mfa/send', { mfa_token: login.body.mfa_token, method: 'sms' });
    assert.equal(send.status, 200, send.text);
    assert.equal(send.body.to, '+255 7•• ••• 000');
    const c2 = s.client();
    assert.equal((await c2.post('/api/auth/mfa/verify', { mfa_token: login.body.mfa_token, method: 'sms', code: '999999' })).status, 401);
    const ok = await c2.post('/api/auth/mfa/verify', { mfa_token: login.body.mfa_token, method: 'sms', code: s.lastOtp() });
    assert.equal(ok.status, 200, ok.text);
  });

  await t.test('turning 2FA off needs the password', async () => {
    const { c } = await registerUser(s);
    const setup = await c.post('/api/account/mfa/totp/setup');
    await c.post('/api/account/mfa/totp/enable', { code: totp(setup.body.secret, { now: s.ctx.now() }) });
    assert.equal((await c.del('/api/account/mfa/totp', { password: 'wrong-wrong-wrong' })).status, 403);
    const r = await c.del('/api/account/mfa/totp', { password: GOOD_PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.user.mfa.enabled, false);
  });
});

test('sessions, profile, export and deletion', async (t) => {
  const s = await startTestServer({ env: PLATFORM_ENV });
  t.after(() => s.close());

  await t.test('lists devices, revokes one, revokes all others', async () => {
    const { c, email } = await registerUser(s);
    const other = s.client(); await other.post('/api/auth/login', { email, password: GOOD_PASSWORD });
    const third = s.client(); await third.post('/api/auth/login', { email, password: GOOD_PASSWORD });
    const list = await c.get('/api/account/sessions');
    assert.equal(list.body.sessions.length, 3);
    assert.equal(list.body.sessions.filter((x) => x.current).length, 1);
    const target = list.body.sessions.find((x) => !x.current);
    assert.equal(target.id.length > 6, true);
    assert.equal((await c.del(`/api/account/sessions/${target.id}`)).status, 200);
    assert.equal((await c.post('/api/account/sessions/revoke-others')).status, 200);
    assert.equal((await c.get('/api/account/sessions')).body.sessions.length, 1);
    assert.equal((await other.get('/api/auth/session')).body.authenticated, false);
    assert.equal((await third.get('/api/auth/session')).body.authenticated, false);
    assert.equal((await c.get('/api/auth/session')).body.authenticated, true);
  });

  await t.test('cannot revoke another user\'s session', async () => {
    const a = await registerUser(s), b = await registerUser(s);
    const bSess = (await b.c.get('/api/account/sessions')).body.sessions[0];
    assert.equal((await a.c.del(`/api/account/sessions/${bSess.id}`)).status, 404);
    assert.equal((await b.c.get('/api/auth/session')).body.authenticated, true);
  });

  await t.test('changing password needs the current one, revokes other devices, and is audited', async () => {
    const { c, email } = await registerUser(s);
    const other = s.client(); await other.post('/api/auth/login', { email, password: GOOD_PASSWORD });
    assert.equal((await c.post('/api/account/password', { current_password: 'nope-nope-nope', new_password: 'nyati-mwekundu-anaruka-9' })).status, 403);
    assert.equal((await c.post('/api/account/password', { current_password: GOOD_PASSWORD, new_password: 'short' })).status, 400);
    assert.equal((await c.post('/api/account/password', { current_password: GOOD_PASSWORD, new_password: 'nyati-mwekundu-anaruka-9' })).status, 200);
    assert.equal((await other.get('/api/auth/session')).body.authenticated, false);
    assert.equal((await c.get('/api/auth/session')).body.authenticated, true, 'this device stays signed in');
    const audit = await c.get('/api/account/audit');
    assert.ok(audit.body.entries.some((e) => e.event === 'password_changed'));
  });

  await t.test('profile update', async () => {
    const { c } = await registerUser(s);
    const r = await c.patch('/api/account', { name: 'Amina Juma' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, 'Amina Juma');
  });

  await t.test('export contains the user\'s work and no secrets; delete wipes everything', async () => {
    const { c, email } = await registerUser(s);
    const ev = (await c.post('/api/events', { name: 'My Wedding', type: 'wedding' })).body.event;
    const exp = await c.get('/api/account/export');
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition'), /attachment/);
    assert.equal(exp.body.events[0].name, 'My Wedding');
    assert.ok(!exp.text.includes('password_hash') && !exp.text.includes('scrypt$'));

    assert.equal((await c.req('DELETE', '/api/account', { password: 'wrong-wrong-wrong' })).status, 403);
    const del = await c.req('DELETE', '/api/account', { password: GOOD_PASSWORD });
    assert.equal(del.status, 200, del.text);
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(email)).c, 0);
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM events WHERE id = ?').get(ev.id)).c, 0, 'events cascade');
    assert.equal((await s.client().post('/api/auth/login', { email, password: GOOD_PASSWORD })).status, 401);
  });
});
