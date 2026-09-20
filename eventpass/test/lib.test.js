import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhone, maskPhone } from '../server/lib/phone.js';
import { hashPassword, verifyPassword, validatePassword } from '../server/lib/passwords.js';
import { createVault } from '../server/lib/vault.js';
import { totp, verifyTotp, generateSecret, base32Decode, base32Encode, otpauthUri } from '../server/lib/totp.js';
import { renderTemplate, smsSegments, buildMessageVars } from '../server/lib/template.js';
import { randomCode, otpCode, sha256, safeEqual, makeBackupCodes } from '../server/lib/tokens.js';
import { REGIONS, mapLink, validCoords } from '../server/lib/locations.js';

// ───────────────────────── phone ─────────────────────────
test('phone: accepts every common way Tanzanians write a mobile number', () => {
  const inputs = [
    '0712345678', '712345678', '+255712345678', '255712345678',
    '+255 712 345 678', '0712 345 678', '0712-345-678', '00255712345678', '+255 (0) 712 345 678',
  ];
  for (const i of inputs) {
    const r = normalizePhone(i);
    assert.equal(r.ok, true, i);
    assert.equal(r.e164, '+255712345678', i);
    assert.equal(r.country, 'TZ', i);
  }
});

test('phone: detects operator from TCRA prefix (best-effort)', () => {
  const cases = {
    '0754123456': 'Vodacom', '0744123456': 'Vodacom', '0764123456': 'Vodacom',
    '0684123456': 'Airtel', '0694123456': 'Airtel', '0784123456': 'Airtel',
    '0654123456': 'Tigo/Yas', '0674123456': 'Tigo/Yas', '0714123456': 'Tigo/Yas',
    '0624123456': 'Halotel', '0614123456': 'Halotel',
    '0734123456': 'TTCL', '0774123456': 'Zantel', '0664123456': 'Smile',
  };
  for (const [num, op] of Object.entries(cases)) {
    assert.equal(normalizePhone(num).operator, op, num);
  }
});

test('phone: rejects landlines, too short/long, letters and garbage', () => {
  for (const bad of ['', '   ', 'abc', '0222123456', '+255222123456', '071234567', '07123456789', '+2557123', '12345', null, undefined, '+255 812 345 678']) {
    assert.equal(normalizePhone(bad).ok, false, String(bad));
  }
});

test('phone: accepts valid international E.164 numbers when + is given', () => {
  const r = normalizePhone('+254712345678');
  assert.equal(r.ok, true);
  assert.equal(r.e164, '+254712345678');
  assert.equal(r.country, 'INTL');
  assert.equal(normalizePhone('254712345678').ok, false, 'foreign number without + is ambiguous');
  assert.equal(normalizePhone('+1234').ok, false);
  assert.equal(normalizePhone('+' + '1'.repeat(16)).ok, false);
});

test('phone: masks numbers for display', () => {
  assert.equal(maskPhone('+255712345678'), '+255 7•• ••• 678');
  assert.equal(maskPhone(null), '');
});

// ───────────────────────── passwords ─────────────────────────
test('passwords: hash verifies, wrong password fails, hashes are salted', async () => {
  const h1 = await hashPassword('correct horse battery');
  const h2 = await hashPassword('correct horse battery');
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery', h1), true);
  assert.equal(await verifyPassword('wrong horse battery', h1), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
  assert.equal(await verifyPassword('anything', null), false);
});

test('passwords: policy blocks weak choices', () => {
  assert.ok(validatePassword('short1', {}));
  assert.ok(validatePassword('password123', {}), 'common');
  assert.ok(validatePassword('aaaaaaaaaaaa', {}), 'repeated char');
  assert.ok(validatePassword('songz@example.com', { email: 'songz@example.com' }), 'contains email');
  assert.ok(validatePassword('x'.repeat(129), {}), 'too long');
  assert.equal(validatePassword('tembo-anakula-mihogo-7', { email: 'a@b.co' }), null);
});

// ───────────────────────── vault ─────────────────────────
test('vault: round-trips, is randomised, and detects tampering', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const v = createVault(key);
  const secret = JSON.stringify({ apiKey: 'atsk_live_123' });
  const a = v.encrypt(secret), b = v.encrypt(secret);
  assert.notEqual(a, b);
  assert.ok(!a.includes('atsk_live'));
  assert.equal(v.decrypt(a), secret);
  const parts = a.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => v.decrypt(parts.join(':')));
  assert.throws(() => createVault(Buffer.alloc(16).toString('base64')), /32 bytes/);
  const other = createVault(Buffer.alloc(32, 9).toString('base64'));
  assert.throws(() => other.decrypt(a));
});

// ───────────────────────── totp (RFC 6238 vectors) ─────────────────────────
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
test('totp: matches RFC 6238 SHA-1 test vectors', () => {
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, code] of vectors) {
    assert.equal(totp(RFC_SECRET, { now: t * 1000, digits: 8 }), code, `t=${t}`);
  }
});

test('totp: base32 round trip and secret generation', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(base32Encode(base32Decode(s)), s);
});

test('totp: verify accepts ±1 step, rejects far codes, and blocks replay', () => {
  const now = 1_700_000_000_000;
  const code = totp(RFC_SECRET, { now });
  const ok = verifyTotp(RFC_SECRET, code, { now });
  assert.ok(ok && typeof ok.step === 'number');
  assert.ok(verifyTotp(RFC_SECRET, code, { now: now + 30_000 }), 'previous step still ok');
  assert.equal(verifyTotp(RFC_SECRET, code, { now: now + 120_000 }), null, 'too old');
  assert.equal(verifyTotp(RFC_SECRET, code, { now, lastStep: ok.step }), null, 'replay of same step');
  assert.equal(verifyTotp(RFC_SECRET, '000000', { now }), null);
  assert.equal(verifyTotp(RFC_SECRET, 'abcdef', { now }), null);
  assert.equal(verifyTotp(RFC_SECRET, '12345', { now }), null);
});

test('totp: otpauth URI is authenticator-app compatible', () => {
  const u = otpauthUri({ secret: RFC_SECRET, account: 'a@b.co', issuer: 'EventPass' });
  assert.match(u, /^otpauth:\/\/totp\/EventPass:a%40b\.co\?/);
  assert.ok(u.includes(`secret=${RFC_SECRET}`) && u.includes('issuer=EventPass'));
});

// ───────────────────────── templates ─────────────────────────
test('template: substitutes variables safely (no $-pattern injection)', () => {
  const out = renderTemplate('Hi {NAME}, code {CODE} {UNKNOWN}', { NAME: "A$&B$'C", CODE: 'X1' });
  assert.equal(out, "Hi A$&B$'C, code X1 {UNKNOWN}");
});

test('template: builds vars from guest + event', () => {
  const vars = buildMessageVars(
    { name: 'Amina', code: 'ABCD2345', invite_type: 'double' },
    { name: 'Amara & Juma', date: '2026-12-05', time: '14:30', venue: 'Serena Hotel', region: 'Dar es Salaam', district: 'Ilala', lat: -6.8, lng: 39.28 },
    'https://events.example.tz',
  );
  assert.equal(vars.NAME, 'Amina');
  assert.equal(vars.TYPE, 'Double Entry (Guest + 1)');
  assert.equal(vars.TIME, '2:30 PM');
  assert.match(vars.DATE, /Saturday, 5 December 2026/);
  assert.equal(vars.LINK, 'https://events.example.tz/i/ABCD2345');
  assert.match(vars.MAP, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-6\.8%2C39\.28$/);
  assert.equal(vars.LOCATION, 'Serena Hotel, Ilala, Dar es Salaam');
});

test('template: counts SMS segments for GSM-7 vs unicode', () => {
  assert.deepEqual(smsSegments('a'.repeat(160)), { length: 160, segments: 1, encoding: 'GSM-7' });
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('🎉').encoding, 'UCS-2');
  // an emoji is 2 UTF-16 units in a Unicode SMS, so 2 + 68 = 70 fits one segment and 2 + 69 = 71 does not
  assert.equal(smsSegments('🎉' + 'a'.repeat(68)).segments, 1);
  assert.equal(smsSegments('🎉' + 'a'.repeat(69)).segments, 2);
  assert.equal(smsSegments('{'.repeat(80)).length, 160, 'extension chars count double');
});

// ───────────────────────── tokens ─────────────────────────
test('tokens: invite codes are unambiguous, right length and unique enough', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = randomCode(8);
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
});

test('tokens: otp is zero-padded digits; hashing and compare behave', () => {
  for (let i = 0; i < 200; i++) assert.match(otpCode(6), /^\d{6}$/);
  assert.equal(sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('tokens: backup codes are 10 distinct XXXX-XXXX codes', () => {
  const codes = makeBackupCodes(10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

// ───────────────────────── locations ─────────────────────────
test('locations: Tanzania has 31 regions and map links are built safely', () => {
  assert.equal(REGIONS.length, 31);
  assert.ok(REGIONS.includes('Dar es Salaam') && REGIONS.includes('Mjini Magharibi'));
  assert.equal(mapLink({ lat: -6.8, lng: 39.28 }), 'https://www.google.com/maps/search/?api=1&query=-6.8%2C39.28');
  assert.equal(mapLink({ venue: 'Serena Hotel', district: 'Ilala', region: 'Dar es Salaam' }), 'https://www.google.com/maps/search/?api=1&query=Serena%20Hotel%2C%20Ilala%2C%20Dar%20es%20Salaam');
  assert.equal(mapLink({}), '');
  assert.equal(validCoords(-6.8, 39.28), true);
  assert.equal(validCoords(91, 0), false);
  assert.equal(validCoords(0, 181), false);
});
