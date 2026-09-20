import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser } from './helpers.js';

async function host(s) {
  const { c } = await registerUser(s);
  const ev = await c.post('/api/events', { name: 'Neema & Juma Wedding', type: 'wedding', date: new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10), time: '16:00', venue: 'Mlimani City', region: 'Dar es Salaam' });
  assert.equal(ev.status, 201, ev.text);
  return { c, ev: ev.body.event };
}
const guest = (c, ev, over = {}) => c.post('/api/guests', { event_id: ev.id, name: 'Asha Mwakyusa', phone: '0712 345 678', invite_type: 'single', ...over });

test('guests', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('all guest routes need a signed-in host', async () => {
    const c = s.client();
    for (const [m, p] of [['GET', '/api/guests'], ['POST', '/api/guests'], ['POST', '/api/checkin'], ['GET', '/api/overview'], ['GET', '/api/messaging/channels']]) {
      const r = await c.req(m, p, m === 'POST' ? {} : undefined);
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  await t.test('adding a guest normalises the phone, detects the operator and issues a random unambiguous code', async () => {
    const { c, ev } = await host(s);
    const r = await guest(c, ev);
    assert.equal(r.status, 201, r.text);
    const g = r.body.guest;
    assert.equal(g.phone, '+255712345678');
    assert.equal(g.operator, 'Tigo/Yas');
    assert.match(g.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(g.invite_type, 'single');
    assert.equal(g.checked_in, false);
    assert.equal(g.event_name, 'Neema & Juma Wedding');
    assert.deepEqual(r.body.sent, [], 'nothing configured, nothing sent');
    const codes = new Set();
    for (let i = 0; i < 20; i++) codes.add((await guest(c, ev, { name: 'G' + i, phone: '' })).body.guest.code);
    assert.equal(codes.size, 20);
  });

  await t.test('a guest without a phone is allowed; bad input is rejected with a helpful message', async () => {
    const { c, ev } = await host(s);
    assert.equal((await guest(c, ev, { phone: '' })).status, 201);
    let r = await guest(c, ev, { phone: '12345' });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.fields.phone);
    r = await guest(c, ev, { name: '   ' });
    assert.equal(r.status, 400);
    r = await guest(c, ev, { invite_type: 'vip' });
    assert.equal(r.status, 400);
    r = await guest(c, ev, { landline: 1, phone: '022 260 0000' });
    assert.equal(r.status, 400, 'landline is not a mobile');
  });

  await t.test('hosts only ever see and touch their own guests and events', async () => {
    const a = await host(s), b = await host(s);
    const g = (await guest(a.c, a.ev)).body.guest;
    assert.equal((await guest(b.c, a.ev)).status, 404, 'cannot add to someone else\'s event');
    assert.equal((await b.c.get('/api/guests')).body.guests.length, 0);
    for (const [m, p, body] of [['PATCH', `/api/guests/${g.id}`, { name: 'x' }], ['DELETE', `/api/guests/${g.id}`], ['GET', `/api/guests/${g.id}/qr.svg`], ['GET', `/api/guests/${g.id}/message?channel=sms`], ['POST', `/api/guests/${g.id}/send`, { channel: 'sms' }]]) {
      assert.equal((await b.c.req(m, p, body)).status, 404, `${m} ${p}`);
    }
    assert.equal((await b.c.get(`/api/guests?event_id=${a.ev.id}`)).body.guests.length, 0);
    assert.equal((await a.c.get('/api/guests')).body.guests.length, 1);
  });

  await t.test('edit and delete; event guest counts follow', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev)).body.guest;
    let r = await c.patch(`/api/guests/${g.id}`, { name: 'Asha M.', invite_type: 'double', phone: '0754 111 222' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.guest.invite_type, 'double');
    assert.equal(r.body.guest.phone, '+255754111222');
    assert.equal(r.body.guest.operator, 'Vodacom');
    assert.equal(r.body.guest.code, g.code, 'code never changes on edit');
    assert.equal((await c.get('/api/events')).body.events[0].guest_count, 1);
    assert.equal((await c.del(`/api/guests/${g.id}`)).status, 200);
    assert.equal((await c.get('/api/events')).body.events[0].guest_count, 0);
  });

  await t.test('the guest list can be filtered by event and searched', async () => {
    const { c, ev } = await host(s);
    const ev2 = (await c.post('/api/events', { name: 'Kigoma Conference', type: 'conference' })).body.event;
    await guest(c, ev, { name: 'Zawadi One' });
    await guest(c, ev2, { name: 'Baraka Two' });
    assert.equal((await c.get(`/api/guests?event_id=${ev2.id}`)).body.guests.length, 1);
    assert.equal((await c.get('/api/guests?q=zawadi')).body.guests[0].name, 'Zawadi One');
    assert.equal((await c.get('/api/guests')).body.guests.length, 2);
  });

  await t.test('bulk import reports each bad row instead of failing the whole batch', async () => {
    const { c, ev } = await host(s);
    const r = await c.post('/api/guests/bulk', { event_id: ev.id, guests: [
      { name: 'Ok One', phone: '0712 000 111' },
      { name: '', phone: '0712 000 222' },
      { name: 'Bad Phone', phone: '999' },
      { name: 'Ok Two', phone: '', invite_type: 'double' },
      { name: 'ok one', phone: '0712000111' },
    ] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.created, 2);
    assert.deepEqual(r.body.skipped.map((x) => x.row), [2, 3, 5]);
    assert.match(r.body.skipped[2].reason, /duplicate/i);
    assert.equal((await c.post('/api/guests/bulk', { event_id: ev.id, guests: Array.from({ length: 501 }, (_, i) => ({ name: 'n' + i })) })).status, 400, 'batch cap');
  });

  await t.test('the per-account guest limit is enforced', async () => {
    const small = await startTestServer({ config: { limits: { maxEvents: 100, maxGuests: 3, maxBulk: 500, maxBroadcast: 300 } } });
    t.after(() => small.close());
    const { c, ev } = await host(small);
    for (let i = 0; i < 3; i++) assert.equal((await guest(c, ev, { name: 'g' + i, phone: '' })).status, 201);
    const r = await guest(c, ev, { name: 'over', phone: '' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'limit');
  });

  await t.test('QR code is an SVG of the guest code, served only to the owner', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev)).body.guest;
    const r = await c.get(`/api/guests/${g.id}/qr.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(r.text, /<svg/);
  });

  await t.test('CSV export escapes quotes/commas and neutralises spreadsheet formulas', async () => {
    const { c, ev } = await host(s);
    await guest(c, ev, { name: '=HYPERLINK("http://evil","click")', phone: '' });
    await guest(c, ev, { name: 'Mwanga, "Big" Juma', phone: '0712 345 678' });
    const r = await c.get(`/api/guests/export.csv?event_id=${ev.id}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const lines = r.text.trim().split('\n');
    assert.match(lines[0], /^Name,Phone,Operator,Event,Code,Invite type,Checked in,SMS sent,WhatsApp sent/);
    assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil"",""click"")"`), 'formula prefixed with an apostrophe');
    assert.ok(r.text.includes('"Mwanga, ""Big"" Juma"'));
  });

  await t.test('message preview renders the template and a wa.me link', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev)).body.guest;
    const r = await c.get(`/api/guests/${g.id}/message?channel=whatsapp`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.text.includes(g.code) && r.body.text.includes('Neema & Juma Wedding'));
    assert.ok(r.body.waLink.startsWith('https://wa.me/255712345678?text='));
    assert.equal((await c.get(`/api/guests/${g.id}/message?channel=fax`)).status, 400);
  });

  await t.test('the public invitation page can show a QR of the code without signing in', async () => {
    const anon = s.client();
    const r = await anon.get('/api/public/qr/K7M2P9QX.svg');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(r.text, /<svg/);
    assert.equal((await anon.get('/api/public/qr/no%20good.svg')).status, 400, 'only well-formed codes');
    assert.equal((await anon.get('/api/public/qr/' + 'A'.repeat(40) + '.svg')).status, 400);
  });

  await t.test('an issued invite code opens the public invitation page', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev)).body.guest;
    const r = await s.client().post('/api/public/invite', { code: g.code.toLowerCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.guest.name, 'Asha Mwakyusa');
    assert.equal(r.body.event.venue, 'Mlimani City');
    assert.equal((await c.get('/api/guests')).body.guests[0].code_viewed, true);
  });
});

test('check-in', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('a valid code admits the guest once; a second scan says already checked in', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev, { invite_type: 'double' })).body.guest;
    let r = await c.post('/api/checkin', { code: `  ${g.code.toLowerCase()} `, event_id: ev.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.result, 'ok');
    assert.equal(r.body.guest.name, 'Asha Mwakyusa');
    assert.equal(r.body.guest.invite_type, 'double');
    r = await c.post('/api/checkin', { code: g.code });
    assert.equal(r.body.result, 'already');
    assert.ok(r.body.checked_in_at);
    const list = (await c.get('/api/guests')).body.guests;
    assert.equal(list[0].checked_in, true);
  });

  await t.test('unknown codes and other hosts\' codes are simply invalid (nothing leaks)', async () => {
    const a = await host(s), b = await host(s);
    const g = (await guest(a.c, a.ev)).body.guest;
    let r = await b.c.post('/api/checkin', { code: g.code });
    assert.equal(r.body.result, 'invalid');
    assert.ok(!JSON.stringify(r.body).includes('Asha'));
    r = await a.c.post('/api/checkin', { code: 'ZZZZZZZZ' });
    assert.equal(r.body.result, 'invalid');
    assert.equal((await a.c.get('/api/guests')).body.guests[0].checked_in, false);
    assert.equal((await a.c.post('/api/checkin', { code: '' })).status, 400);
  });

  await t.test('a code for a different event is refused, not silently admitted', async () => {
    const { c, ev } = await host(s);
    const ev2 = (await c.post('/api/events', { name: 'Other Party', type: 'party' })).body.event;
    const g = (await guest(c, ev)).body.guest;
    const r = await c.post('/api/checkin', { code: g.code, event_id: ev2.id });
    assert.equal(r.body.result, 'wrong_event');
    assert.equal(r.body.guest.event_name, 'Neema & Juma Wedding');
    assert.equal((await c.get('/api/guests')).body.guests[0].checked_in, false, 'not admitted');
  });

  await t.test('two scanners hitting the same code at the same moment admit exactly one', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev)).body.guest;
    const rs = await Promise.all(Array.from({ length: 6 }, () => c.post('/api/checkin', { code: g.code })));
    const results = rs.map((r) => r.body.result).sort();
    assert.equal(results.filter((x) => x === 'ok').length, 1);
    assert.equal(results.filter((x) => x === 'already').length, 5);
    assert.equal((await s.db.prepare('SELECT COUNT(*) c FROM checkin_log WHERE guest_id = ?').get(g.id)).c, 1);
  });

  await t.test('stats, log and undo', async () => {
    const { c, ev } = await host(s);
    const g1 = (await guest(c, ev, { name: 'One', phone: '' })).body.guest;
    await guest(c, ev, { name: 'Two', phone: '' });
    await c.post('/api/checkin', { code: g1.code });
    let st = (await c.get(`/api/checkin/stats?event_id=${ev.id}`)).body;
    assert.deepEqual([st.total, st.checked_in, st.remaining], [2, 1, 1]);
    const log = (await c.get('/api/checkin/log')).body.log;
    assert.equal(log.length, 1);
    assert.equal(log[0].guest_name, 'One');
    assert.equal(log[0].event_name, 'Neema & Juma Wedding');
    const u = await c.post('/api/checkin/undo', { guest_id: g1.id });
    assert.equal(u.status, 200);
    st = (await c.get(`/api/checkin/stats?event_id=${ev.id}`)).body;
    assert.deepEqual([st.checked_in, st.remaining], [0, 2]);
    assert.equal((await c.post('/api/checkin', { code: g1.code })).body.result, 'ok', 'can be admitted again after an undo');
  });

  await t.test('another host cannot undo or read someone else\'s check-ins', async () => {
    const a = await host(s), b = await host(s);
    const g = (await guest(a.c, a.ev)).body.guest;
    await a.c.post('/api/checkin', { code: g.code });
    assert.equal((await b.c.post('/api/checkin/undo', { guest_id: g.id })).status, 404);
    assert.equal((await b.c.get('/api/checkin/log')).body.log.length, 0);
  });
});

test('overview', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('summarises the host\'s own numbers and recent activity', async () => {
    const { c, ev } = await host(s);
    const g = (await guest(c, ev)).body.guest;
    await guest(c, ev, { name: 'Second', phone: '' });
    await c.post('/api/checkin', { code: g.code });
    const other = await host(s);
    await guest(other.c, other.ev, { name: 'Not mine', phone: '' });
    const r = await c.get('/api/overview');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.stats.events, r.body.stats.guests, r.body.stats.checked_in, r.body.stats.pending], [1, 2, 1, 1]);
    assert.ok(r.body.activity.length >= 3);
    assert.ok(r.body.activity.every((a) => a.msg && a.ts));
    assert.ok(!JSON.stringify(r.body).includes('Not mine'));
    assert.equal(r.body.next_event.id, ev.id);
  });
});
