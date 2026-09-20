import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { startTestServer, registerUser, GOOD_PASSWORD } from './helpers.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const cfg = (env) => loadConfig({ NODE_ENV: 'test', APP_ENCRYPTION_KEY: KEY, ...env });

// Behind a reverse proxy (Caddy, nginx, a hosting platform) every request arrives from the proxy's address. Express only reads the
// visitor's real address from X-Forwarded-For when told how many proxies to trust, and it wants that as a NUMBER: the string "1"
// would be read as the IP address 0.0.0.1.
test('TRUST_PROXY is understood the way Express needs it', async (t) => {
  await t.test('a hop count becomes a number, in production by default', () => {
    assert.strictEqual(cfg({ TRUST_PROXY: '1' }).trustProxy, 1);
    assert.strictEqual(cfg({ TRUST_PROXY: '2' }).trustProxy, 2);
    const prod = loadConfig({ NODE_ENV: 'production', APP_URL: 'https://x.example', APP_ENCRYPTION_KEY: KEY, ALLOW_NO_SMTP: 'true' });
    assert.strictEqual(prod.trustProxy, 1);
  });
  await t.test('off means off; words and address lists pass through', () => {
    assert.strictEqual(cfg({}).trustProxy, false);
    assert.strictEqual(cfg({ TRUST_PROXY: '0' }).trustProxy, false);
    assert.strictEqual(cfg({ TRUST_PROXY: 'false' }).trustProxy, false);
    assert.strictEqual(cfg({ TRUST_PROXY: 'true' }).trustProxy, true);
    assert.strictEqual(cfg({ TRUST_PROXY: 'loopback, 172.16.0.0/12' }).trustProxy, 'loopback, 172.16.0.0/12');
  });
  await t.test('with one proxy trusted, a visitor\'s real address is recorded, not the proxy\'s', async () => {
    const s = await startTestServer({ env: { TRUST_PROXY: '1' } });
    t.after(() => s.close());
    const { email } = await registerUser(s);
    const visitor = s.client();                                            // signs in "through the proxy", which adds the real address
    assert.equal((await visitor.post('/api/auth/login', { email, password: GOOD_PASSWORD }, { headers: { 'x-forwarded-for': '41.59.12.34' } })).status, 200);
    assert.equal((await visitor.get('/api/account/sessions')).body.sessions.find((x) => x.current).ip, '41.59.12.34');
  });
  await t.test('with no proxy trusted, a forged X-Forwarded-For is ignored', async () => {
    const s = await startTestServer({});
    t.after(() => s.close());
    const { email } = await registerUser(s);
    const visitor = s.client();
    await visitor.post('/api/auth/login', { email, password: GOOD_PASSWORD }, { headers: { 'x-forwarded-for': '6.6.6.6' } });
    assert.notEqual((await visitor.get('/api/account/sessions')).body.sessions.find((x) => x.current).ip, '6.6.6.6');
  });
});
