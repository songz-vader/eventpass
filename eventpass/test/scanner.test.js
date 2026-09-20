import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser } from './helpers.js';

async function host(s) {
  const { c } = await registerUser(s);
  const ev = (await c.post('/api/events', { name: 'Harusi ya Neema', type: 'wedding', date: '2099-12-12', venue: 'Mlimani City' })).body.event;
  const guest = async (name = 'Asha Mwakyusa', over = {}) => (await c.post('/api/guests', { event_id: ev.id, name, phone: '', ...over })).body.guest;
  return { c, ev, guest };
}
const link = (c, ev, over = {}) => c.post('/api/scanner-links', { event_id: ev.id, label: 'Main gate', hours: 24, ...over });
const asStaff = (s, token, how = 'x-scanner-token') => {
  const c = s.client();
  const headers = how === 'bearer' ? { authorization: `Bearer ${token}` } : { 'x-scanner-token': token };
  return { get: (p) => c.get(p, { headers }), post: (p, b) => c.post(p, b, { headers }), raw: c };
};

test('door staff links', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('only a signed-in host can manage links', async () => {
    const c = s.client();
    assert.equal((await c.get('/api/scanner-links')).status, 401);
    assert.equal((await c.post('/api/scanner-links', {})).status, 401);
    assert.equal((await c.del('/api/scanner-links/1')).status, 401);
  });

  await t.test('creating a link returns the secret once, and only its hash is stored', async () => {
    const { c, ev } = await host(s);
    const r = await link(c, ev);
    assert.equal(r.status, 201, r.text);
    assert.match(r.body.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(r.body.url, `${s.url}/#/scan/${r.body.token}`);
    assert.match(r.body.qr, /^data:image\/png;base64,/);
    assert.equal(r.body.link.label, 'Main gate');
    assert.equal(r.body.link.status, 'active');
    assert.equal(r.body.link.event_name, 'Harusi ya Neema');
    const row = await s.db.prepare('SELECT token_hash FROM scanner_links ORDER BY id DESC').get();
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(r.body.token));
    const list = await c.get('/api/scanner-links');
    assert.equal(list.body.links.length, 1);
    assert.ok(!list.text.includes(r.body.token) && !list.text.includes(row.token_hash), 'the list never shows the secret');
  });

  await t.test('input is checked: label, lifetime, and event ownership', async () => {
    const a = await host(s), b = await host(s);
    assert.equal((await link(a.c, a.ev, { label: '  ' })).status, 400);
    assert.equal((await link(a.c, a.ev, { hours: 0 })).status, 400);
    assert.equal((await link(a.c, a.ev, { hours: 24 * 30 })).status, 400);
    assert.equal((await link(b.c, a.ev)).status, 404, 'someone else\'s event');
    assert.equal((await link(a.c, { id: 999999 })).status, 404);
  });

  await t.test('a host can have at most 20 live links', async () => {
    const { c, ev } = await host(s);
    for (let i = 0; i < 20; i++) assert.equal((await link(c, ev, { label: 'Gate ' + i })).status, 201);
    const r = await link(c, ev);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'limit');
  });

  await t.test('staff can read the event and progress, but not the guest list', async () => {
    const { c, ev, guest } = await host(s);
    await guest('Secret Guest One'); await guest('Secret Guest Two');
    const { body: { token } } = await link(c, ev);
    for (const how of ['x-scanner-token', 'bearer']) {
      const r = await asStaff(s, token, how).get('/api/scan/info');
      assert.equal(r.status, 200, `${how}: ${r.text}`);
      assert.equal(r.body.label, 'Main gate');
      assert.equal(r.body.event.name, 'Harusi ya Neema');
      assert.deepEqual([r.body.stats.total, r.body.stats.checked_in, r.body.stats.remaining], [2, 0, 2]);
      assert.ok(!r.text.includes('Secret Guest') && !r.text.includes('@example.com'));
    }
  });

  await t.test('missing, wrong, cookie-only and query-string tokens are all refused', async () => {
    const { c, ev } = await host(s);
    const { body: { token } } = await link(c, ev);
    assert.equal((await s.client().get('/api/scan/info')).status, 401);
    assert.equal((await asStaff(s, 'nope'.repeat(12)).get('/api/scan/info')).body.error.code, 'scanner_invalid');
    assert.equal((await c.get('/api/scan/info')).status, 401, 'a host session is not a scanner token');
    assert.equal((await s.client().get(`/api/scan/info?token=${token}`)).status, 401, 'tokens never travel in URLs, which end up in logs');
    assert.equal((await asStaff(s, 'x'.repeat(500)).get('/api/scan/info')).status, 401);
  });

  await t.test('links stop working when they expire or are revoked, straight away', async () => {
    const { c, ev } = await host(s);
    const a = await link(c, ev, { hours: 1 }), b = await link(c, ev, { label: 'Side gate' });
    assert.equal((await asStaff(s, b.body.token).get('/api/scan/info')).status, 200);
    assert.equal((await c.del(`/api/scanner-links/${b.body.link.id}`)).status, 200);
    let r = await asStaff(s, b.body.token).get('/api/scan/info');
    assert.equal(r.status, 401); assert.equal(r.body.error.code, 'scanner_revoked');
    const real = s.ctx.now; s.ctx.now = () => real() + 2 * 3600_000;
    try {
      r = await asStaff(s, a.body.token).get('/api/scan/info');
      assert.equal(r.status, 401); assert.equal(r.body.error.code, 'scanner_expired');
      const list = (await c.get('/api/scanner-links')).body.links;
      assert.deepEqual(list.map((l) => l.status).sort(), ['expired', 'revoked']);
    } finally { s.ctx.now = real; }
  });

  await t.test('scanning admits guests of that event only, once, and says why otherwise', async () => {
    const { c, ev, guest } = await host(s);
    const other = (await c.post('/api/events', { name: 'Kigoma Conference', type: 'conference' })).body.event;
    const g = await guest('Asha Mwakyusa', { invite_type: 'double' });
    const stranger = (await c.post('/api/guests', { event_id: other.id, name: 'Baraka', phone: '' })).body.guest;
    const { body: { token } } = await link(c, ev);
    const staff = asStaff(s, token);
    let r = await staff.post('/api/scan/checkin', { code: ` ${g.code.toLowerCase()} ` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.result, 'ok'); assert.equal(r.body.guest.name, 'Asha Mwakyusa'); assert.equal(r.body.guest.invite_type, 'double');
    assert.equal((await staff.post('/api/scan/checkin', { code: g.code })).body.result, 'already');
    r = await staff.post('/api/scan/checkin', { code: stranger.code });
    assert.equal(r.body.result, 'wrong_event');
    assert.equal(r.body.guest.event_name, 'Kigoma Conference');
    assert.equal((await c.get('/api/guests')).body.guests.find((x) => x.id === stranger.id).checked_in, false, 'not admitted');
    assert.equal((await staff.post('/api/scan/checkin', { code: 'ZZZZZZZZ' })).body.result, 'invalid');
    assert.equal((await staff.post('/api/scan/checkin', { code: '' })).status, 400);
    const foreign = await host(s); const fg = await foreign.guest('Not yours');
    assert.equal((await staff.post('/api/scan/checkin', { code: fg.code })).body.result, 'invalid', 'another host\'s code looks like any unknown code');
  });

  await t.test('the host sees who scanned, and the link tracks its use', async () => {
    const { c, ev, guest } = await host(s);
    const g1 = await guest('One'), g2 = await guest('Two');
    const made = await link(c, ev, { label: 'Gate B' });
    const staff = asStaff(s, made.body.token);
    await staff.post('/api/scan/checkin', { code: g1.code });
    await staff.post('/api/scan/checkin', { code: g1.code });        // repeat: not counted
    await c.post('/api/checkin', { code: g2.code });                  // the host's own scan
    const log = (await c.get('/api/checkin/log')).body.log;
    assert.equal(log.find((e) => e.guest_name === 'One').via, 'Gate B');
    assert.equal(log.find((e) => e.guest_name === 'Two').via, null);
    const act = (await c.get('/api/overview')).body.activity.map((a) => a.msg).join('\n');
    assert.match(act, /"One" checked in at \d\d:\d\d \(Gate B\)/);
    const l = (await c.get('/api/scanner-links')).body.links[0];
    assert.equal(l.scans, 1); assert.ok(l.last_used_at);
    const recent = await staff.get('/api/scan/recent');
    assert.deepEqual(recent.body.log.map((e) => e.guest_name).sort(), ['One', 'Two']);
    assert.equal((await staff.get('/api/scan/info')).body.stats.checked_in, 2);
  });

  await t.test('two gates scanning the same code at the same instant admit exactly one', async () => {
    const { c, ev, guest } = await host(s);
    const g = await guest();
    const a = asStaff(s, (await link(c, ev, { label: 'A' })).body.token), b = asStaff(s, (await link(c, ev, { label: 'B' })).body.token);
    const rs = await Promise.all([a, b, a, b, a, b].map((st) => st.post('/api/scan/checkin', { code: g.code })));
    const res = rs.map((r) => r.body.result);
    assert.equal(res.filter((x) => x === 'ok').length, 1);
    assert.equal(res.filter((x) => x === 'already').length, 5);
  });

  await t.test('hosts cannot revoke or see each other\'s links; deleting the event ends its links', async () => {
    const a = await host(s), b = await host(s);
    const made = await link(a.c, a.ev);
    assert.equal((await b.c.del(`/api/scanner-links/${made.body.link.id}`)).status, 404);
    assert.equal((await b.c.get('/api/scanner-links')).body.links.length, 0);
    assert.equal((await asStaff(s, made.body.token).get('/api/scan/info')).status, 200, 'still alive after the failed revoke');
    await a.c.del(`/api/events/${a.ev.id}`);
    assert.equal((await asStaff(s, made.body.token).get('/api/scan/info')).body.error.code, 'scanner_invalid');
  });

  await t.test('a web page on another site cannot drive a scanner link; devices with no Origin can', async () => {
    const { c, ev, guest } = await host(s);
    const g = await guest();
    const { body: { token } } = await link(c, ev);
    const evil = await s.client().post('/api/scan/checkin', { code: g.code }, { headers: { 'x-scanner-token': token }, origin: 'https://evil.test' });
    assert.equal(evil.status, 403);
    const device = await s.client().post('/api/scan/checkin', { code: g.code }, { headers: { authorization: `Bearer ${token}` }, origin: null });
    assert.equal(device.status, 200, device.text);
    assert.equal(device.body.result, 'ok');
  });
});

test('browser permissions', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const r = await s.client().get('/api/public/config');
  const pp = r.headers.get('permissions-policy');
  assert.match(pp, /camera=\(self\)/, 'this site may use the camera for QR scanning');
  assert.match(pp, /microphone=\(\)/, 'but never the microphone');
  assert.match(pp, /geolocation=\(self\)/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /script-src[^;]*unsafe/, 'scripts stay locked down');
});
