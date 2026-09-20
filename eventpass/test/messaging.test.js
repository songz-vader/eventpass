import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, registerUser } from './helpers.js';

const SMS = { username: 'sandbox', apiKey: 'atsk_supersecretkey_9876', sender: '' };
const WA = { phoneId: '5550100', token: 'EAAB_wa_token_secret_4321', templateName: '', templateLang: 'en', templateParams: 'NAME,EVENT,CODE' };

async function host(s) {
  const { c } = await registerUser(s);
  const ev = (await c.post('/api/events', { name: 'Harusi ya Neema', type: 'wedding', date: '2026-12-12', time: '16:00', venue: 'Mlimani City', region: 'Dar es Salaam' })).body.event;
  return { c, ev };
}
const addGuest = (c, ev, over = {}) => c.post('/api/guests', { event_id: ev.id, name: 'Asha', phone: '0754 123 456', ...over });
const setup = (c, ch, values, extra = {}) => c.req('PUT', `/api/messaging/channels/${ch}`, { values, ...extra });

test('channel configuration', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('lists every channel with its form definition, and never returns a stored secret in full', async () => {
    const { c } = await host(s);
    let r = await c.get('/api/messaging/channels');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.channels.map((x) => x.id), ['sms', 'whatsapp']);
    const sms = r.body.channels[0];
    assert.ok(sms.fields.some((f) => f.key === 'apiKey' && f.secret));
    assert.equal(sms.configured, false);
    r = await setup(c, 'sms', SMS);
    assert.equal(r.status, 200, r.text);
    r = await c.get('/api/messaging/channels');
    assert.equal(r.body.channels[0].configured, true);
    assert.equal(r.body.channels[0].values.apiKey, '••••9876');
    assert.equal(r.body.channels[0].values.username, 'sandbox');
    assert.ok(!r.text.includes('supersecretkey'));
  });

  await t.test('credentials are encrypted at rest and a blank secret keeps the stored one', async () => {
    const { c } = await host(s);
    await setup(c, 'whatsapp', WA);
    const row = await s.db.prepare("SELECT config_enc FROM channel_configs WHERE channel = 'whatsapp' ORDER BY id DESC").get();
    assert.ok(row.config_enc.startsWith('v1:'));
    assert.ok(!row.config_enc.includes('EAAB_wa_token'));
    await setup(c, 'whatsapp', { ...WA, token: '', phoneId: '5559999' });
    const r = await c.get('/api/messaging/channels');
    const wa = r.body.channels.find((x) => x.id === 'whatsapp');
    assert.equal(wa.values.phoneId, '5559999');
    assert.equal(wa.values.token, '••••4321', 'secret kept');
  });

  await t.test('unknown channels 404; channel settings are per host', async () => {
    const a = await host(s), b = await host(s);
    assert.equal((await setup(a.c, 'telegram', {})).status, 404);
    await setup(a.c, 'sms', SMS);
    assert.equal((await b.c.get('/api/messaging/channels')).body.channels[0].configured, false);
  });

  await t.test('template and auto-send are saved, oversized templates are cut', async () => {
    const { c } = await host(s);
    await setup(c, 'sms', SMS, { template: 'Hi {NAME}, code {CODE}', autoSend: false });
    const ch = (await c.get('/api/messaging/channels')).body.channels[0];
    assert.equal(ch.template, 'Hi {NAME}, code {CODE}');
    assert.equal(ch.autoSend, false);
  });

  await t.test('test message goes to a normalised number and refuses until credentials are saved', async () => {
    const { c } = await host(s);
    let r = await c.post('/api/messaging/channels/sms/test', { to: '0754 123 456' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'not_configured');
    await setup(c, 'sms', SMS);
    r = await c.post('/api/messaging/channels/sms/test', { to: 'abc' });
    assert.equal(r.status, 400);
    r = await c.post('/api/messaging/channels/sms/test', { to: '0754 123 456' });
    assert.equal(r.status, 200, r.text);
    const call = s.fetch.calls.at(-1);
    assert.match(call.url, /api\.sandbox\.africastalking\.com/);
    assert.equal(call.body.to, '+255754123456');
  });

  await t.test('a failing provider surfaces a readable error', async () => {
    const { c } = await host(s);
    await setup(c, 'sms', SMS);
    s.fetch.state.respond = () => ({ status: 401, json: {} });
    const r = await c.post('/api/messaging/channels/sms/test', { to: '0754 123 456' });
    s.fetch.state.respond = null;
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /username or API key/);
  });
});

test('sending invitations', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('adding a guest auto-sends on every configured channel and records it', async () => {
    const { c, ev } = await host(s);
    await setup(c, 'sms', SMS);
    await setup(c, 'whatsapp', WA);
    const before = s.fetch.calls.length;
    const r = await addGuest(c, ev);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.body.sent.sort(), ['sms', 'whatsapp']);
    assert.equal(r.body.guest.sms_sent, true);
    assert.equal(r.body.guest.wa_sent, true);
    const calls = s.fetch.calls.slice(before);
    const smsCall = calls.find((x) => x.url.includes('africastalking'));
    assert.equal(smsCall.body.to, '+255754123456');
    assert.ok(smsCall.body.message.includes('Asha') && smsCall.body.message.includes(r.body.guest.code));
    assert.ok(smsCall.body.message.includes('Mlimani City'));
    const waCall = calls.find((x) => x.url.includes('graph.facebook.com'));
    assert.equal(waCall.body.to, '255754123456');
    const log = (await c.get('/api/messaging/log')).body.rows;
    assert.equal(log.length, 2);
    assert.ok(log.every((l) => l.status === 'sent' && l.guest_name === 'Asha'));
  });

  await t.test('auto-send can be switched off per channel', async () => {
    const { c, ev } = await host(s);
    await setup(c, 'sms', SMS, { autoSend: false });
    const before = s.fetch.calls.length;
    const r = await addGuest(c, ev);
    assert.deepEqual(r.body.sent, []);
    assert.equal(s.fetch.calls.length, before);
  });

  await t.test('a provider failure never blocks adding the guest; the failure is reported and logged', async () => {
    const { c, ev } = await host(s);
    await setup(c, 'sms', SMS);
    s.fetch.state.respond = () => ({ status: 200, json: { SMSMessageData: { Message: 'Sent to 0/1', Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber', number: 'x' }] } } });
    const r = await addGuest(c, ev);
    s.fetch.state.respond = null;
    assert.equal(r.status, 201);
    assert.equal(r.body.guest.sms_sent, false);
    assert.equal(r.body.failed[0].channel, 'sms');
    assert.match(r.body.failed[0].error, /invalid/i);
    const log = (await c.get('/api/messaging/log')).body.rows;
    assert.equal(log[0].status, 'failed');
  });

  await t.test('manual send to one guest: needs config, phone and a known channel', async () => {
    const { c, ev } = await host(s);
    const g = (await addGuest(c, ev)).body.guest;
    let r = await c.post(`/api/guests/${g.id}/send`, { channel: 'sms' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'not_configured');
    await setup(c, 'sms', SMS, { autoSend: false });
    r = await c.post(`/api/guests/${g.id}/send`, { channel: 'sms' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await c.get('/api/guests')).body.guests[0].sms_sent, true);
    const nophone = (await addGuest(c, ev, { name: 'No Phone', phone: '' })).body.guest;
    r = await c.post(`/api/guests/${nophone.id}/send`, { channel: 'sms' });
    assert.equal(r.body.error.code, 'no_phone');
    assert.equal((await c.post(`/api/guests/${g.id}/send`, { channel: 'pigeon' })).status, 400);
  });

  await t.test('broadcast messages only guests who have not had it, skips those without a phone, and reports counts', async () => {
    const { c, ev } = await host(s);
    await setup(c, 'sms', SMS, { autoSend: false });
    const a = (await addGuest(c, ev, { name: 'A' })).body.guest;
    await addGuest(c, ev, { name: 'B', phone: '0712 000 002' });
    await addGuest(c, ev, { name: 'NoPhone', phone: '' });
    await c.post(`/api/guests/${a.id}/send`, { channel: 'sms' });
    const before = s.fetch.calls.length;
    const r = await c.post('/api/messaging/broadcast', { channel: 'sms', event_id: ev.id });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.sent, r.body.failed, r.body.skipped_no_phone, r.body.already_sent], [1, 0, 1, 1]);
    assert.equal(s.fetch.calls.length - before, 1);
    const again = await c.post('/api/messaging/broadcast', { channel: 'sms', event_id: ev.id });
    assert.equal(again.body.sent, 0);
    const all = await c.post('/api/messaging/broadcast', { channel: 'sms', event_id: ev.id, resend: true });
    assert.equal(all.body.sent, 2, 'resend hits everyone with a phone');
  });

  await t.test('broadcast is capped and cannot reach another host\'s event', async () => {
    const small = await startTestServer({ config: { limits: { maxEvents: 100, maxGuests: 5000, maxBulk: 500, maxBroadcast: 2 } } });
    t.after(() => small.close());
    const { c, ev } = await host(small);
    await setup(c, 'sms', SMS, { autoSend: false });
    for (let i = 0; i < 4; i++) await addGuest(c, ev, { name: 'g' + i, phone: `07120000${10 + i}` });
    const r = await c.post('/api/messaging/broadcast', { channel: 'sms', event_id: ev.id });
    assert.equal(r.body.sent, 2);
    assert.equal(r.body.remaining, 2, 'tells the host to run it again');
    const other = await host(small);
    assert.equal((await other.c.post('/api/messaging/broadcast', { channel: 'sms', event_id: ev.id })).status, 404);
  });

  await t.test('the message log only shows the caller\'s messages, newest first', async () => {
    const a = await host(s), b = await host(s);
    await setup(a.c, 'sms', SMS);
    await addGuest(a.c, a.ev, { name: 'First' });
    await addGuest(a.c, a.ev, { name: 'Second' });
    const rows = (await a.c.get('/api/messaging/log')).body.rows;
    assert.deepEqual(rows.map((r) => r.guest_name), ['Second', 'First']);
    assert.equal((await b.c.get('/api/messaging/log')).body.rows.length, 0);
  });

  await t.test('the Messages tab is advertised to the front end with its endpoint and columns', async () => {
    const r = await s.client().get('/api/public/config');
    const tab = r.body.tabs.find((x) => x.id === 'messages');
    assert.equal(tab.endpoint, '/api/messaging/log');
    assert.ok(tab.columns.length >= 5);
  });
});

test('provider delivery webhooks', async (t) => {
  const SECRET = 'app-secret-123';
  const s = await startTestServer({ env: { WHATSAPP_VERIFY_TOKEN: 'verify-me', WHATSAPP_APP_SECRET: SECRET, AT_WEBHOOK_SECRET: 'at-hook-secret' } });
  t.after(() => s.close());
  const sign = (body) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

  async function sentMessage() {
    const { c, ev } = await host(s);
    await setup(c, 'whatsapp', WA);
    await addGuest(c, ev);
    return { c, ref: (await s.db.prepare("SELECT provider_ref FROM message_log WHERE channel = 'whatsapp' ORDER BY id DESC").get()).provider_ref };
  }
  const statusBody = (ref, status, extra = {}) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: ref, status, ...extra }] } }] }] });

  await t.test('Meta\'s verification handshake echoes the challenge only for the right token', async () => {
    const c = s.client();
    let r = await c.get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
    assert.equal(r.status, 200);
    assert.equal(r.text, '12345');
    r = await c.get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345');
    assert.equal(r.status, 403);
  });

  await t.test('signed status callbacks update the message log; unsigned or tampered ones are rejected', async () => {
    const { c, ref } = await sentMessage();
    const anon = s.client();
    const body = statusBody(ref, 'delivered');
    let r = await anon.req('POST', '/webhooks/whatsapp', body, { raw: true, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 401, 'no signature');
    r = await anon.req('POST', '/webhooks/whatsapp', body, { raw: true, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body + ' ') } });
    assert.equal(r.status, 401, 'wrong signature');
    assert.equal((await c.get('/api/messaging/log')).body.rows[0].status, 'sent');
    r = await anon.req('POST', '/webhooks/whatsapp', body, { raw: true, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    assert.equal(r.status, 200);
    assert.equal((await c.get('/api/messaging/log')).body.rows[0].status, 'delivered');
    const second = await sentMessage();     // a failure report applies to a message that has not been delivered
    const failed = statusBody(second.ref, 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
    await anon.req('POST', '/webhooks/whatsapp', failed, { raw: true, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(failed) } });
    const row = (await second.c.get('/api/messaging/log')).body.rows[0];
    assert.equal(row.status, 'failed');
    assert.match(row.error, /undeliverable|not use WhatsApp/i);
  });

  await t.test('a late "sent" callback never downgrades a delivered/read message', async () => {
    const { c, ref } = await sentMessage();
    const anon = s.client();
    for (const st of ['read', 'delivered', 'sent']) {
      const b = statusBody(ref, st);
      await anon.req('POST', '/webhooks/whatsapp', b, { raw: true, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(b) } });
    }
    assert.equal((await c.get('/api/messaging/log')).body.rows[0].status, 'read');
  });

  await t.test('Africa\'s Talking delivery reports work only with the secret in the URL', async () => {
    const { c, ev } = await host(s);
    await setup(c, 'sms', SMS);
    await addGuest(c, ev);
    const ref = (await s.db.prepare("SELECT provider_ref FROM message_log WHERE channel = 'sms' ORDER BY id DESC").get()).provider_ref;
    const anon = s.client();
    const form = new URLSearchParams({ id: ref, status: 'Success', phoneNumber: '+255754123456' }).toString();
    const h = { 'content-type': 'application/x-www-form-urlencoded' };
    let r = await anon.req('POST', '/webhooks/at/wrong', form, { raw: true, headers: h });
    assert.equal(r.status, 401);
    r = await anon.req('POST', '/webhooks/at/at-hook-secret', form, { raw: true, headers: h });
    assert.equal(r.status, 200, r.text);
    assert.equal((await c.get('/api/messaging/log')).body.rows[0].status, 'delivered');
    await addGuest(c, ev, { name: 'Blocked', phone: '0712 000 009' });   // a second message that ends up undelivered
    const ref2 = (await s.db.prepare("SELECT provider_ref FROM message_log WHERE channel = 'sms' ORDER BY id DESC").get()).provider_ref;
    const bad = new URLSearchParams({ id: ref2, status: 'Failed', failureReason: 'UserInBlacklist' }).toString();
    await anon.req('POST', '/webhooks/at/at-hook-secret', bad, { raw: true, headers: h });
    const row = (await c.get('/api/messaging/log')).body.rows[0];
    assert.equal(row.status, 'failed');
    assert.match(row.error, /opted out/);
  });

  await t.test('webhooks are disabled when their secrets are not configured', async () => {
    const bare = await startTestServer();
    t.after(() => bare.close());
    const c = bare.client();
    assert.equal((await c.get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 404);
    assert.equal((await c.req('POST', '/webhooks/at/anything', 'id=x', { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 404);
  });
});
