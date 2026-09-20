import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { createMailer } from '../server/mailer.js';

export const TEST_KEY = Buffer.alloc(32, 42).toString('base64');

// A stand-in for the outside world (Africa's Talking, Meta Graph). Records every call; tests can override `respond`.
export function makeFakeFetch() {
  const calls = [];
  const state = { respond: null };
  const fn = async (url, init = {}) => {
    const u = String(url);
    let body = init.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (typeof body === 'string' && body.startsWith('{')) { try { body = JSON.parse(body); } catch {} }
    const call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body };
    calls.push(call);
    if (state.respond) { const r = state.respond(call); if (r) return jsonRes(r.status || 200, r.json); }
    if (u.includes('africastalking.com')) return jsonRes(201, { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: 101, number: body.to, status: 'Success', messageId: 'ATXid_' + calls.length, cost: 'TZS 20' }] } });
    if (u.includes('graph.facebook.com')) return jsonRes(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.' + calls.length }] });
    return jsonRes(404, { error: 'no fake for ' + u });
  };
  fn.calls = calls; fn.state = state;
  return fn;
}
const jsonRes = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

export async function startTestServer({ env = {}, config = {}, fetch } = {}) {
  const cfg = loadConfig({ NODE_ENV: 'test', APP_ENCRYPTION_KEY: TEST_KEY, ...env }, { rate: { enabled: false }, ...config });
  // Same tests, either database: by default a private in-memory SQLite. Set TEST_DATABASE_URL=postgres://… to run them on PostgreSQL,
  // where each test server gets its own throwaway schema.
  const pgUrl = process.env.TEST_DATABASE_URL;
  const schema = pgUrl ? 't_' + crypto.randomBytes(6).toString('hex') : null;
  const db = await openDb(pgUrl || ':memory:', schema ? { schema, dropSchemaOnClose: true } : {});
  const fakeFetch = fetch || makeFakeFetch();
  const mailer = createMailer(cfg);
  const { app, ctx } = createApp({ config: cfg, db, fetch: fakeFetch, mailer });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  cfg.appUrl = url;
  const t = {
    url, config: cfg, db, mailer, ctx, fetch: fakeFetch, server,
    client: () => new Client(url),
    close: async () => { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); await db.close(); },
    lastMail: (to) => [...mailer.outbox].reverse().find((m) => !to || m.to === to),
    // extract a link token from the latest email, e.g. /#/verify/<token>
    mailToken: (to, kind) => { const m = t.lastMail(to); const r = m?.text.match(new RegExp(`#/${kind}/([A-Za-z0-9_-]+)`)); return r?.[1]; },
    lastOtp: () => { for (const c of [...fakeFetch.calls].reverse()) { const txt = c.body?.message || JSON.stringify(c.body || ''); const m = txt.match(/\b(\d{6})\b/); if (m) return m[1]; } return null; },
  };
  return t;
}

export class Client {
  constructor(url) { this.url = url; this.jar = new Map(); this.csrf = null; this.origin = url; }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, body, { headers = {}, origin = this.origin, raw = false } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = this.cookieHeader();
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') { if (origin) h.origin = origin; if (this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf; }
    const res = await fetch(this.url + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';');
      const [k, ...v] = pair.split('=');
      const val = v.join('=');
      const dead = attrs.some((a) => /^\s*max-age=0/i.test(a)) || !val;
      if (dead) this.jar.delete(k.trim()); else this.jar.set(k.trim(), val);
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (json?.csrf) this.csrf = json.csrf;
    return { status: res.status, body: json, text, headers: res.headers, setCookies };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  patch(p, b = {}, o) { return this.req('PATCH', p, b, o); }
  del(p, b, o) { return this.req('DELETE', p, b, o); }
}

let n = 0;
export const uniqueEmail = (p = 'user') => `${p}${++n}_${Date.now()}@example.com`;
export const GOOD_PASSWORD = 'tembo-anakula-mihogo-7';

export async function registerUser(t, over = {}) {
  const c = t.client();
  const email = over.email || uniqueEmail();
  const r = await c.post('/api/auth/register', { name: 'Test Host', email, password: GOOD_PASSWORD, ...over });
  return { c, email, r };
}
