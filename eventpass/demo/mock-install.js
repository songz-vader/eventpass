// A stand-in for the EventPass server that runs inside the page, so the real front end can be previewed without installing anything.
// It reuses the real phone, template, location and channel code from ../server/, but keeps everything in memory and sends nothing.
import QRCode from 'qrcode';
import { REGIONS, mapLink, locationText } from '../server/lib/locations.js';
import { TEMPLATE_VARS, DEFAULT_TEMPLATES, smsSegments, buildMessageVars, renderTemplate } from '../server/lib/template.js';
import { normalizePhone, maskPhone } from '../server/lib/phone.js';
import { TABS } from '../server/modules.js';
import { channelSchema, channelIds, getChannel } from '../server/messaging/index.js';

const DAY = 864e5, MIN = 6e4;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rcode = () => Array.from({ length: 8 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const eat = (ts = Date.now()) => new Date(ts + 3 * 3600_000).toISOString().slice(0, 10);
// Ids must not collide when several people add things at the same moment, so they come from the clock plus a random tail.
let lastId = 0;
const nid = () => { let n = Date.now() * 1000 + Math.floor(Math.random() * 1000); if (n <= lastId) n = lastId + 1; return (lastId = n); };

// ── QR codes drawn in the page (the real server draws them too) ──
function qrSvg(text) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'H' }).modules, n = q.size, m = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.get(x, y)) d += `M${x + m},${y + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#1C1814"/></svg>`;
}
const qrUrl = (t) => 'data:image/svg+xml;base64,' + btoa(qrSvg(t));

// ── state: starts EMPTY. Nothing is pre-filled. ──
const LS_USER = 'ep_preview_user';
const loadUser = () => { try { const u = JSON.parse(localStorage.getItem(LS_USER)); return u && typeof u === 'object' ? u : null; } catch { return null; } };
const saveUser = () => { try { if (S.user) localStorage.setItem(LS_USER, JSON.stringify(S.user)); else localStorage.removeItem(LS_USER); } catch { /* storage unavailable: the person just signs in again after a reload */ } };
const S = {
  user: null, events: [], guests: [], checkins: [], activity: [], msgLog: [], links: [], audit: [], sessionStart: Date.now(),
  channels: { sms: { config: {}, template: '', autoSend: true }, whatsapp: { config: {}, template: '', autoSend: true } },   // API keys live here in memory only, never in the shared store
};
S.user = loadUser();
const signedIn = () => !!S.user;
const newUser = (name, email, verified) => ({ id: 1, email, email_verified: verified, name, phone: null, phone_verified: false, operator: null, has_password: true, providers: [], mfa: { enabled: false, totp: false, sms: false, whatsapp: false, backup_remaining: 0 }, created_at: Date.now() });
const evLabel = (id) => S.events.find((e) => e.id === id);
function addEvent(o) { const e = { id: nid(), type: 'other', date: '', time: '', venue: '', region: '', district: '', address: '', lat: null, lng: null, dress: '', note: '', created_at: Date.now(), ...o }; S.events.push(e); return e; }
function addGuest(eventId, name, phone, type = 'single', extra = {}) {
  const p = phone ? normalizePhone(phone) : null;
  const g = { id: nid(), event_id: eventId, name, phone: p?.ok ? p.e164 : '', operator: p?.ok ? p.operator : null, invite_type: type, code: rcode(), checked_in: false, checked_in_at: null, sms_sent: false, wa_sent: false, code_viewed: false, created_at: Date.now(), ...extra };
  S.guests.push(g); return g;
}
function log(msg) { S.activity.unshift({ id: nid(), msg, ts: Date.now(), by: S.user?.name || '' }); }
function audit(event) { S.audit.unshift({ event, ip: '', device: 'This browser', meta: null, ts: Date.now() }); }
const LIMITS = { events: 50, guests: 1000 };       // the shared preview store holds at most 5,000 documents in total

// ── the shared store: this preview's "backend" ──
// When the page runs inside claude.ai it can keep its data in the artifact's own database, shared by everyone who can open it.
// Elsewhere (a saved file) there is no store, so it works in memory and a reload starts blank again.
const COLS = { events: 'events', guests: 'guests', checkins: 'checkins', activity: 'activity', msgLog: 'msglog', links: 'links' };
const CAPS = { activity: 100, msgLog: 300, checkins: 500 };     // busy logs keep only their newest entries
const shadow = new Map();                                        // "collection/id" → the JSON last known to be in the store
let db = null, status = 'memory', queue = Promise.resolve();
const TEXT = {
  saving: 'Preview. Saved in this page\'s shared store. Nothing is sent.',
  memory: 'Preview. Not saved: a reload starts blank. Nothing is sent.',
  readonly: 'Preview. You can look around, but your changes are not being saved.',
  full: 'Preview storage is full. New changes are not being saved.',
};
function setStatus(s) { status = s; const t = document.getElementById('ep-preview-tag'); if (t) t.textContent = TEXT[s]; }

const secretKeys = (ch) => getChannel(ch).fields.filter((f) => f.secret).map((f) => f.key);
const publicConfig = (ch) => Object.fromEntries(Object.entries(S.channels[ch].config).filter(([k]) => !secretKeys(ch).includes(k)));
function localDocs() {
  const want = new Map();
  for (const [prop, col] of Object.entries(COLS)) {
    if (CAPS[prop]) S[prop].length = Math.min(S[prop].length, CAPS[prop]);
    for (const o of S[prop]) want.set(`${col}/${o.id}`, o);
  }
  for (const ch of channelIds()) {                                      // a channel only gets a document once someone has changed something on it
    const st = S.channels[ch], config = publicConfig(ch);
    if (st.template || st.autoSend === false || Object.keys(config).length) want.set(`channels/${ch}`, { id: ch, template: st.template, autoSend: st.autoSend, config });
  }
  return want;
}
// Writes whatever changed since the last sync: one write per changed document, deletes for removed ones.
function sync() {
  if (!db) return Promise.resolve();
  queue = queue.then(async () => {
    try {
      const want = localDocs();
      for (const [key, obj] of want) { const j = JSON.stringify(obj); if (shadow.get(key) !== j) { await db.doc(key).set(JSON.parse(j)); shadow.set(key, j); } }
      for (const key of [...shadow.keys()]) if (!want.has(key)) { await db.doc(key).delete(); shadow.delete(key); }
      if (status !== 'saving') setStatus('saving');
    } catch (e) { setStatus(e?.code === 'quota_exceeded' ? 'full' : 'readonly'); }
  });
  return queue;
}
// Anything read back is untrusted (other people write to the same store): keep only what looks like our own shapes.
const sane = (prop, o) => o && typeof o === 'object' && Number.isSafeInteger(o.id) && (prop === 'events' ? typeof o.name === 'string' : prop === 'guests' ? typeof o.name === 'string' && typeof o.code === 'string' && Number.isSafeInteger(o.event_id) : true);
const byTime = (a, b) => b.ts - a.ts;
function sortAll() {
  S.events.sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || a.id - b.id);
  for (const p of ['activity', 'msgLog', 'checkins']) S[p].sort(byTime);
}
function applyRemote(prop, col, changes) {
  for (const c of changes) {
    const key = `${col}/${c.doc.id}`, id = Number(c.doc.id);
    if (c.type === 'removed') { S[prop] = S[prop].filter((o) => o.id !== id); shadow.delete(key); continue; }
    const data = c.doc.data(); if (!sane(prop, data)) continue;
    const j = JSON.stringify(data); if (shadow.get(key) === j) continue;          // our own write coming back
    shadow.set(key, j);
    const i = S[prop].findIndex((o) => o.id === id), copy = JSON.parse(j);
    if (i >= 0) S[prop][i] = copy; else S[prop].push(copy);
  }
  sortAll();
}
function applyChannel(ch, data) {
  if (!data || typeof data !== 'object') return;
  const j = JSON.stringify(data); if (shadow.get(`channels/${ch}`) === j) return;
  shadow.set(`channels/${ch}`, j);
  const st = S.channels[ch], keep = Object.fromEntries(Object.entries(st.config).filter(([k]) => secretKeys(ch).includes(k)));
  st.template = typeof data.template === 'string' ? data.template : ''; st.autoSend = data.autoSend !== false;
  st.config = { ...(data.config && typeof data.config === 'object' ? data.config : {}), ...keep };
}
async function initStore() {
  if (!window.claude?.use) return;
  const got = await Promise.race([window.claude.use('db').catch(() => null), new Promise((r) => setTimeout(() => r(null), 4000))]);
  if (!got) return;
  try {
    for (const [prop, col] of Object.entries(COLS)) {
      const snap = await got.collection(col).get();
      for (const d of snap.docs) { const data = d.data(); if (sane(prop, data)) { const j = JSON.stringify(data); shadow.set(`${col}/${d.id}`, j); S[prop].push(JSON.parse(j)); } }
    }
    for (const ch of channelIds()) { const d = await got.doc(`channels/${ch}`).get(); if (d.exists) applyChannel(ch, d.data()); }
    sortAll();
    db = got;
    for (const [prop, col] of Object.entries(COLS)) got.collection(col).onSnapshot((snap) => applyRemote(prop, col, snap.docChanges()), () => {});
    for (const ch of channelIds()) got.doc(`channels/${ch}`).onSnapshot((d) => applyChannel(ch, d.data()), () => {});
    setStatus('saving');
  } catch { db = null; setStatus('memory'); }
}
const ready = initStore();
window.__EP_DEMO__ = { flush: () => queue, get status() { return status; } };

// ── helpers that mirror the server's behaviour ──
class Fail extends Error { constructor(status, code, message, fields = {}) { super(message); this.status = status; this.code = code; this.fields = fields; } }
const shapeEvent = (e) => ({ ...e, map_url: mapLink(e), guest_count: S.guests.filter((g) => g.event_id === e.id).length, checked_in_count: S.guests.filter((g) => g.event_id === e.id && g.checked_in).length });
const shapeGuest = (g) => ({ ...g, event_name: evLabel(g.event_id)?.name || '' });
const ownEvent = (id) => { const e = S.events.find((x) => x.id === Number(id)); if (!e) throw new Fail(404, 'not_found', 'Event not found.'); return e; };
const ownGuest = (id) => { const g = S.guests.find((x) => x.id === Number(id)); if (!g) throw new Fail(404, 'not_found', 'Guest not found.'); return g; };
const phoneOr = (raw) => { if (!raw || !String(raw).trim()) return { phone: '', operator: null }; const p = normalizePhone(String(raw)); if (!p.ok) throw new Fail(400, 'validation', p.error, { phone: p.error }); return { phone: p.e164, operator: p.operator }; };
const userOut = () => { const m = S.user.mfa; m.enabled = m.totp || m.sms || m.whatsapp; return { ...S.user, phone_masked: maskPhone(S.user.phone) }; };
const fmtClock = (ts) => new Date(ts + 3 * 3600_000).toISOString().slice(11, 16);

function chanConfigured(id) { return !!getChannel(id).isConfigured(S.channels[id].config); }
function describe(id) {
  const def = channelSchema().find((c) => c.id === id), st = S.channels[id], values = {};
  for (const f of def.fields) { const v = st.config[f.key] ?? f.default ?? ''; values[f.key] = f.secret ? (v ? '••••' + String(v).slice(-4) : '') : v; }
  return { ...def, configured: chanConfigured(id), autoSend: st.autoSend, template: st.template || DEFAULT_TEMPLATES[id].en, values, hasSecret: Object.fromEntries(def.fields.filter((f) => f.secret).map((f) => [f.key, !!st.config[f.key]])) };
}
function sendTo(g, ch) {                                                   // pretends to send; the real server calls the provider here
  if (!chanConfigured(ch)) return { ok: false, code: 'not_configured', error: `${getChannel(ch).label} is not set up yet. Add your ${getChannel(ch).provider} details in the Messaging tab.` };
  if (!g.phone) return { ok: false, code: 'no_phone', error: 'This guest has no phone number.' };
  S.msgLog.unshift({ id: nid(), guest_id: g.id, guest_name: g.name, channel: ch, to_phone: g.phone, status: 'sent', error: null, ts: Date.now() });
  g[getChannel(ch).flag] = true;
  return { ok: true };
}
function messageFor(g, ch) {
  const st = S.channels[ch], ev = evLabel(g.event_id);
  const text = renderTemplate(st.template || DEFAULT_TEMPLATES[ch].en, buildMessageVars(g, ev, location.origin));
  return { text, waLink: g.phone ? `https://wa.me/${g.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}` : null };
}
function admit(code, eventId, via = null) {
  const g = S.guests.find((x) => x.code === code);
  if (!g) return { result: 'invalid' };
  const brief = { name: g.name, invite_type: g.invite_type, event_name: evLabel(g.event_id).name };
  if (eventId && g.event_id !== eventId) return { result: 'wrong_event', guest: brief };
  if (g.checked_in) return { result: 'already', guest: brief, checked_in_at: g.checked_in_at };
  g.checked_in = true; g.checked_in_at = Date.now();
  S.checkins.unshift({ id: nid(), guest_id: g.id, guest_name: g.name, event_id: g.event_id, event_name: brief.event_name, invite_type: g.invite_type, ts: g.checked_in_at, via });
  log(`"${g.name}" checked in at ${fmtClock(g.checked_in_at)}${via ? ` (${via})` : ''}`);
  return { result: 'ok', guest: brief, checked_in_at: g.checked_in_at };
}
const stats = (eventId) => { const gs = S.guests.filter((g) => !eventId || g.event_id === eventId); const c = gs.filter((g) => g.checked_in).length; return { total: gs.length, checked_in: c, remaining: gs.length - c }; };
const linkShape = (l) => ({ id: l.id, label: l.label, event_id: l.event_id, event_name: evLabel(l.event_id)?.name, created_at: l.created_at, expires_at: l.expires_at, revoked_at: l.revoked_at, last_used_at: l.last_used_at, scans: l.scans, status: l.revoked_at ? 'revoked' : l.expires_at <= Date.now() ? 'expired' : 'active' });
const backupCodes = () => Array.from({ length: 10 }, () => rcode().slice(0, 4) + '-' + rcode().slice(0, 4));
// Staff-link secrets are kept only as a hash in the shared store, like the real server does.
async function hashOf(str) {
  const data = new TextEncoder().encode(str);
  if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let h = 2166136261; for (const c of data) h = Math.imul(h ^ c, 16777619) >>> 0; return 'f' + h.toString(16);     // no Web Crypto (rare): a weaker stand-in, fine for a preview
}
async function linkFrom(headers) {
  const t = String(headers['X-Scanner-Token'] || headers['x-scanner-token'] || '').trim();
  const hash = t ? await hashOf(t) : null;
  const l = hash ? S.links.find((x) => x.token_hash === hash) : null;
  if (!l) throw new Fail(401, 'scanner_invalid', 'This staff link is not valid. Ask the host for a new one.');
  if (l.revoked_at) throw new Fail(401, 'scanner_revoked', 'The host has turned this staff link off.');
  if (l.expires_at <= Date.now()) throw new Fail(401, 'scanner_expired', 'This staff link has expired. Ask the host for a new one.');
  return l;
}
const userOnly = (fn) => (r) => { if (!signedIn()) throw new Fail(401, 'unauthenticated', 'Please sign in.'); return fn(r); };

// ── routes: [method, pattern, handler({ p: path parts, q: query, b: body, h: headers }) → json | [status, json]] ──
const R = [];
const on = (m, re, fn) => R.push([m, re, fn]);
const auth = (m, re, fn) => on(m, re, userOnly(fn));

on('GET', /^\/api\/public\/config$/, () => ({
  app: { name: 'EventPass', version: '1.0.0' }, registration: true,
  oauth: [['apple', 'Apple'], ['google', 'Google'], ['microsoft', 'Microsoft'], ['yahoo', 'Yahoo']].map(([id, label]) => ({ id, label, enabled: true })),
  mfa: { totp: true, sms: true, whatsapp: true, backup: true }, email: true, regions: REGIONS, templateVars: TEMPLATE_VARS, defaultTemplates: DEFAULT_TEMPLATES,
  channels: channelSchema().map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
  tabs: TABS.map(({ id, label, icon, builtin, title, sub, endpoint, columns, empty }) => ({ id, label, icon, builtin, title, sub, endpoint, columns, empty })),
  limits: { maxEvents: 100, maxGuests: 5000, maxBulk: 500, maxBroadcast: 300 },
}));
on('GET', /^\/api\/auth\/session$/, () => (signedIn() ? { authenticated: true, user: userOut(), csrf: 'demo' } : { authenticated: false }));
on('POST', /^\/api\/auth\/login$/, ({ b }) => {
  if (!b.email || !b.password) throw new Fail(401, 'invalid_credentials', 'Incorrect email or password.');
  const email = String(b.email).trim().toLowerCase(), local = email.split('@')[0] || 'Host';
  S.user = newUser(local.charAt(0).toUpperCase() + local.slice(1), email, true); S.sessionStart = Date.now(); audit('login');
  return { user: userOut(), csrf: 'demo' };
});
on('POST', /^\/api\/auth\/register$/, ({ b }) => {
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.includes('@')) throw new Fail(400, 'validation', 'Enter a valid email address.', { email: 'Enter a valid email address.' });
  if (String(b.password || '').length < 10) throw new Fail(400, 'weak_password', 'Use at least 10 characters.', { password: 'Use at least 10 characters.' });
  S.user = newUser(String(b.name || '').trim() || 'Host', email, false); S.sessionStart = Date.now(); audit('register');
  return [201, { user: userOut(), csrf: 'demo' }];
});
on('POST', /^\/api\/auth\/logout$/, () => { audit('logout'); S.user = null; return { ok: true }; });
on('POST', /^\/api\/auth\/password\/forgot$/, () => ({ ok: true, message: 'If that email has an account, we have sent a reset link.' }));
on('POST', /^\/api\/auth\/email\/(resend|verify)$/, () => { if (S.user) S.user.email_verified = true; return { ok: true }; });

auth('GET', /^\/api\/account$/, () => ({ user: userOut() }));
auth('PATCH', /^\/api\/account$/, ({ b }) => { S.user.name = String(b.name || '').trim() || S.user.name; return { user: userOut() }; });
auth('POST', /^\/api\/account\/password$/, ({ b }) => { if (!b.new_password || b.new_password.length < 10) throw new Fail(400, 'weak_password', 'Use at least 10 characters.', { new_password: 'Use at least 10 characters.' }); S.user.has_password = true; return { ok: true, user: userOut() }; });
auth('POST', /^\/api\/account\/phone$/, ({ b }) => { const p = normalizePhone(String(b.phone || '')); if (!p.ok) throw new Fail(400, 'validation', p.error, { phone: p.error }); Object.assign(S.user, { phone: p.e164, operator: p.operator, phone_verified: false }); return { sent: true, channel: b.channel || 'sms', to: maskPhone(p.e164), operator: p.operator, e164: p.e164 }; });
auth('POST', /^\/api\/account\/phone\/verify$/, ({ b }) => { if (!/^\d{4,10}$/.test(String(b.code || '')) || b.code === '000000') throw new Fail(400, 'invalid_code', 'That code is not correct or has expired. (In this preview, any 6 digits except 000000 work.)'); S.user.phone_verified = true; return { user: userOut() }; });
auth('DELETE', /^\/api\/account\/phone$/, () => { Object.assign(S.user, { phone: null, operator: null, phone_verified: false }); Object.assign(S.user.mfa, { sms: false, whatsapp: false }); return { user: userOut() }; });
auth('POST', /^\/api\/account\/mfa\/totp\/setup$/, () => { const uri = 'otpauth://totp/EventPass:' + S.user.email + '?secret=JBSWY3DPEHPK3PXP&issuer=EventPass'; return { secret: 'JBSWY3DPEHPK3PXP', uri, qr: qrUrl(uri) }; });
const enable = (key, b) => { if (!/^\d{6}$/.test(String(b.code || '')) || b.code === '000000') throw new Fail(400, 'invalid_code', 'That code is not correct. (In this preview, any 6 digits except 000000 work.)'); S.user.mfa[key] = true; const first = !S.user.mfa.backup_remaining; if (first) S.user.mfa.backup_remaining = 10; return { user: userOut(), backup_codes: first ? backupCodes() : [] }; };
auth('POST', /^\/api\/account\/mfa\/totp\/enable$/, ({ b }) => enable('totp', b));
auth('POST', /^\/api\/account\/mfa\/otp\/send$/, () => ({ sent: true, to: maskPhone(S.user.phone) }));
auth('POST', /^\/api\/account\/mfa\/otp\/enable$/, ({ b }) => enable(b.method === 'whatsapp' ? 'whatsapp' : 'sms', b));
auth('DELETE', /^\/api\/account\/mfa\/(totp|sms|whatsapp)$/, ({ p }) => { S.user.mfa[p[0]] = false; if (!userOut().mfa.enabled) S.user.mfa.backup_remaining = 0; return { user: userOut() }; });
auth('POST', /^\/api\/account\/mfa\/backup-codes$/, () => { S.user.mfa.backup_remaining = 10; return { backup_codes: backupCodes(), user: userOut() }; });
auth('DELETE', /^\/api\/account\/providers\/(\w+)$/, ({ p }) => { S.user.providers = S.user.providers.filter((x) => x.provider !== p[0]); return { user: userOut() }; });
auth('GET', /^\/api\/account\/sessions$/, () => ({ sessions: [{ id: 's1', current: true, device: 'This browser', ip: '', created_at: S.sessionStart, last_seen: Date.now(), method: 'password' }] }));
auth('DELETE', /^\/api\/account\/sessions\/(\w+)$/, () => ({ ok: true }));
auth('POST', /^\/api\/account\/sessions\/revoke-others$/, () => ({ ok: true }));
auth('GET', /^\/api\/account\/audit$/, () => ({ entries: S.audit.slice(0, 50) }));
auth('DELETE', /^\/api\/account$/, () => { S.user = null; return { ok: true }; });

auth('GET', /^\/api\/overview$/, () => {
  const gs = S.guests, c = gs.filter((g) => g.checked_in).length, today = eat();
  const next = S.events.filter((e) => e.date && e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return { stats: { events: S.events.length, guests: gs.length, checked_in: c, pending: gs.length - c, invites_sent: gs.filter((g) => g.sms_sent || g.wa_sent).length }, next_event: next ? shapeEvent(next) : null, activity: S.activity.slice(0, 15).map((a) => ({ id: a.id, ts: a.ts, msg: a.by && a.by !== S.user.name ? `${a.msg} (${a.by})` : a.msg })) };
});

auth('GET', /^\/api\/events$/, () => ({ events: [...S.events].sort((a, b) => (a.date || '9').localeCompare(b.date || '9')).map(shapeEvent) }));
const eventBody = (b) => { if (!String(b.name || '').trim()) throw new Fail(400, 'validation', 'Enter an event name.', { name: 'Enter an event name.' }); const has = (v) => v !== undefined && v !== null && v !== ''; return { name: b.name.trim(), type: b.type || 'other', date: b.date || '', time: b.time || '', venue: b.venue || '', region: b.region || '', district: b.district || '', address: b.address || '', dress: b.dress || '', note: b.note || '', lat: has(b.lat) ? Number(b.lat) : null, lng: has(b.lng) ? Number(b.lng) : null }; };
auth('POST', /^\/api\/events$/, ({ b }) => { if (S.events.length >= LIMITS.events) throw new Fail(400, 'limit', `The preview holds up to ${LIMITS.events} events.`); const e = addEvent({ ...eventBody(b), created_at: Date.now() }); log(`Event "${e.name}" created`); return [201, { event: shapeEvent(e) }]; });
auth('PATCH', /^\/api\/events\/(\d+)$/, ({ p, b }) => { const e = ownEvent(p[0]); Object.assign(e, eventBody({ ...e, ...b })); return { event: shapeEvent(e) }; });
auth('DELETE', /^\/api\/events\/(\d+)$/, ({ p }) => { const e = ownEvent(p[0]); S.events = S.events.filter((x) => x !== e); S.guests = S.guests.filter((g) => g.event_id !== e.id); S.links = S.links.filter((l) => l.event_id !== e.id); log(`Event "${e.name}" deleted`); return { ok: true }; });

auth('GET', /^\/api\/guests$/, ({ q }) => {
  const ev = Number(q.get('event_id')) || 0, s = (q.get('q') || '').toLowerCase();
  return { guests: S.guests.filter((g) => (!ev || g.event_id === ev) && (!s || [g.name, g.code, g.phone].some((v) => String(v).toLowerCase().includes(s)))).sort((a, b) => b.id - a.id).map(shapeGuest) };
});
auth('POST', /^\/api\/guests$/, ({ b }) => {
  const ev = ownEvent(b.event_id); const name = String(b.name || '').trim();
  if (!name) throw new Fail(400, 'validation', "Enter the guest's name.", { name: "Enter the guest's name." });
  const { phone, operator } = phoneOr(b.phone);
  if (S.guests.length >= LIMITS.guests) throw new Fail(400, 'limit', `The preview holds up to ${LIMITS.guests} guests.`);
  const g = addGuest(ev.id, name, '', b.invite_type === 'double' ? 'double' : 'single', { phone, operator, created_at: Date.now() });
  log(`"${name}" invited to "${ev.name}"`);
  const sent = [], failed = [];
  if (phone) for (const ch of channelIds()) { if (!chanConfigured(ch) || !S.channels[ch].autoSend) continue; const r = sendTo(g, ch); if (r.ok) sent.push(ch); else failed.push({ channel: ch, error: r.error }); }
  return [201, { guest: shapeGuest(g), sent, failed }];
});
auth('POST', /^\/api\/guests\/bulk$/, ({ b }) => {
  const ev = ownEvent(b.event_id), skipped = []; let created = 0;
  b.guests.forEach((row, i) => {
    const name = typeof row.name === 'string' ? row.name.trim() : ''; const skip = (reason) => skipped.push({ row: i + 1, name, reason });
    if (!name) return skip('Missing name.');
    let ph; try { ph = phoneOr(row.phone); } catch (e) { return skip(e.message); }
    if (S.guests.some((g) => g.event_id === ev.id && g.name.toLowerCase() === name.toLowerCase() && g.phone === ph.phone)) return skip('Duplicate of another guest in this event.');
    if (S.guests.length >= LIMITS.guests) return skip(`The preview holds up to ${LIMITS.guests} guests.`);
    addGuest(ev.id, name, '', row.invite_type === 'double' ? 'double' : 'single', { ...ph, created_at: Date.now() }); created++;
  });
  if (created) log(`${created} guests imported to "${ev.name}"`);
  return { created, skipped };
});
auth('PATCH', /^\/api\/guests\/(\d+)$/, ({ p, b }) => { const g = ownGuest(p[0]); if (b.name !== undefined) g.name = String(b.name).trim() || g.name; if (b.invite_type) g.invite_type = b.invite_type; if ('phone' in b) { const ph = phoneOr(b.phone); if (ph.phone !== g.phone) { g.sms_sent = false; g.wa_sent = false; } Object.assign(g, ph); } return { guest: shapeGuest(g) }; });
auth('DELETE', /^\/api\/guests\/(\d+)$/, ({ p }) => { const g = ownGuest(p[0]); S.guests = S.guests.filter((x) => x !== g); log(`"${g.name}" removed`); return { ok: true }; });
auth('GET', /^\/api\/guests\/(\d+)\/message$/, ({ p, q }) => { const ch = q.get('channel'); if (!channelIds().includes(ch)) throw new Fail(400, 'validation', 'Choose SMS or WhatsApp.'); return messageFor(ownGuest(p[0]), ch); });
auth('POST', /^\/api\/guests\/(\d+)\/send$/, ({ p, b }) => { const g = ownGuest(p[0]); if (!channelIds().includes(b.channel)) throw new Fail(400, 'validation', 'Choose SMS or WhatsApp.'); const r = sendTo(g, b.channel); if (!r.ok) throw new Fail(400, r.code, r.error); log(`Invitation sent to "${g.name}" by ${getChannel(b.channel).label}`); return { ok: true, guest: shapeGuest(g) }; });

auth('POST', /^\/api\/checkin$/, ({ b }) => admit(String(b.code || '').trim().toUpperCase(), b.event_id ? Number(b.event_id) : null));
auth('GET', /^\/api\/checkin\/stats$/, ({ q }) => stats(Number(q.get('event_id')) || 0));
auth('GET', /^\/api\/checkin\/log$/, ({ q }) => { const ev = Number(q.get('event_id')) || 0; return { log: S.checkins.filter((c) => !ev || c.event_id === ev).slice(0, Number(q.get('limit')) || 100) }; });
auth('POST', /^\/api\/checkin\/undo$/, ({ b }) => { const g = ownGuest(b.guest_id); g.checked_in = false; g.checked_in_at = null; S.checkins = S.checkins.filter((c) => c.guest_id !== g.id); log(`Check-in for "${g.name}" was undone`); return { ok: true }; });

auth('GET', /^\/api\/scanner-links$/, () => ({ links: S.links.map(linkShape).reverse() }));
auth('POST', /^\/api\/scanner-links$/, async ({ b }) => {
  const ev = ownEvent(b.event_id); const label = String(b.label || '').trim();
  if (!label) throw new Fail(400, 'validation', 'Name this link, for example "Main gate".', { label: 'Name this link.' });
  const token = 'demo-' + [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const l = { id: nid(), label, event_id: ev.id, created_at: Date.now(), expires_at: Date.now() + (Number(b.hours) || 24) * 3600_000, revoked_at: null, last_used_at: null, scans: 0, token_hash: await hashOf(token) };
  S.links.push(l); log(`Staff link "${label}" created for "${ev.name}"`);
  const url = `${location.origin}${location.pathname}#/scan/${token}`;
  return [201, { link: linkShape(l), token, url, qr: qrUrl(url) }];
});
auth('DELETE', /^\/api\/scanner-links\/(\d+)$/, ({ p }) => { const l = S.links.find((x) => x.id === Number(p[0])); if (!l) throw new Fail(404, 'not_found', 'Link not found.'); l.revoked_at = Date.now(); return { ok: true }; });

on('GET', /^\/api\/scan\/info$/, async ({ h }) => { const l = await linkFrom(h), e = evLabel(l.event_id); return { label: l.label, expires_at: l.expires_at, event: { id: e.id, name: e.name, date: e.date, time: e.time, venue: e.venue }, stats: stats(e.id) }; });
on('POST', /^\/api\/scan\/checkin$/, async ({ h, b }) => { const l = await linkFrom(h); const out = admit(String(b.code || '').trim().toUpperCase(), l.event_id, l.label); if (out.result === 'ok') { l.scans++; l.last_used_at = Date.now(); } return out; });
on('GET', /^\/api\/scan\/recent$/, async ({ h }) => { const l = await linkFrom(h); return { log: S.checkins.filter((c) => c.event_id === l.event_id).slice(0, 15) }; });

auth('GET', /^\/api\/messaging\/channels$/, () => ({ channels: channelIds().map(describe) }));
auth('PUT', /^\/api\/messaging\/channels\/(\w+)$/, ({ p, b }) => {
  const id = p[0]; if (!getChannel(id)) throw new Fail(404, 'not_found', 'Unknown channel.');
  const st = S.channels[id];
  for (const f of getChannel(id).fields) { if (!b.values || !(f.key in b.values)) continue; const v = String(b.values[f.key] ?? '').trim(); if (f.secret && !v) continue; st.config[f.key] = v; }
  if (b.template !== undefined) st.template = String(b.template).slice(0, 1000);
  if (b.autoSend !== undefined) st.autoSend = !!b.autoSend;
  log(`${getChannel(id).label} settings updated`);
  return { channel: describe(id) };
});
auth('POST', /^\/api\/messaging\/channels\/(\w+)\/test$/, ({ p, b }) => {
  const id = p[0]; if (!getChannel(id)) throw new Fail(404, 'not_found', 'Unknown channel.');
  if (!chanConfigured(id)) throw new Fail(400, 'not_configured', 'Save your credentials first, then send a test.');
  const ph = normalizePhone(String(b.to || '')); if (!ph.ok) throw new Fail(400, 'validation', ph.error, { to: ph.error });
  S.msgLog.unshift({ id: nid(), guest_id: null, guest_name: null, channel: id, to_phone: ph.e164, status: 'sent', error: null, ts: Date.now() });
  return { ok: true, to: ph.e164 };
});
auth('POST', /^\/api\/messaging\/broadcast$/, ({ b }) => {
  const ch = b.channel; if (!channelIds().includes(ch)) throw new Fail(400, 'validation', 'Choose SMS or WhatsApp.');
  if (b.event_id) ownEvent(b.event_id);
  if (!chanConfigured(ch)) throw new Fail(400, 'not_configured', `${getChannel(ch).label} is not set up yet. Add your ${getChannel(ch).provider} details first.`);
  const flag = getChannel(ch).flag, out = { sent: 0, failed: 0, skipped_no_phone: 0, already_sent: 0, remaining: 0, errors: [] };
  for (const g of S.guests.filter((x) => !b.event_id || x.event_id === Number(b.event_id))) {
    if (!g.phone) out.skipped_no_phone++; else if (g[flag] && !b.resend) out.already_sent++; else { sendTo(g, ch); out.sent++; }
  }
  if (out.sent) log(`${out.sent} invitations sent by ${getChannel(ch).label}`);
  return out;
});
auth('GET', /^\/api\/messaging\/log$/, () => ({ rows: S.msgLog.slice(0, 200) }));

on('POST', /^\/api\/public\/invite$/, ({ b }) => {
  const g = S.guests.find((x) => x.code === String(b.code || '').trim().toUpperCase());
  if (!g) throw new Fail(404, 'invalid_code', 'That code was not found. Check it and try again.');
  g.code_viewed = true; const e = evLabel(g.event_id);
  return { guest: { name: g.name, invite_type: g.invite_type, code: g.code }, event: { name: e.name, type: e.type, date: e.date, time: e.time, venue: e.venue, region: e.region, district: e.district, address: e.address, location: locationText(e), lat: e.lat, lng: e.lng, map_url: mapLink(e), dress: e.dress, note: e.note } };
});
on('POST', /^\/api\/public\/sms-length$/, ({ b }) => smsSegments(String(b.text || '').slice(0, 2000)));

// ── plumbing: replace fetch, and keep the page from navigating away ──
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (init.method || 'GET').toUpperCase();
  await ready;                                                                  // the shared store is read before the first screen draws
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));            // a little latency, so loading states are visible
  for (const [m, re, fn] of R) {
    if (m !== method) continue;
    const hit = url.pathname.match(re); if (!hit) continue;
    try {
      const out = await fn({ p: hit.slice(1), q: url.searchParams, b: init.body ? JSON.parse(init.body) : {}, h: init.headers || {} });
      if (method !== 'GET') { saveUser(); void sync(); }                        // keep this person's session, and write what changed to the shared store
      return Array.isArray(out) ? json(out[0], out[1]) : json(200, out);
    } catch (e) {
      if (e instanceof Fail) return json(e.status, { error: { code: e.code, message: e.message, fields: e.fields } });
      console.error('[preview]', e); return json(500, { error: { code: 'server_error', message: 'The preview hit a problem.' } });
    }
  }
  console.warn('[preview] no mock for', method, url.pathname);
  return json(404, { error: { code: 'demo_unavailable', message: 'That part needs the real server and is not in the preview.' } });
};

// <img src="/api/public/qr/CODE.svg"> is answered by the page itself
const setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (name === 'src' && this instanceof HTMLImageElement && typeof value === 'string') { const m = value.match(/^\/api\/public\/qr\/([A-Za-z0-9]+)\.svg$/); if (m) value = qrUrl(m[1].toUpperCase()); }
  return setAttr.call(this, name, value);
};
// Downloads and provider sign-in are real-server features: explain instead of navigating away.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="/api/"]'); if (!a) return;
  e.preventDefault();
  const t = document.getElementById('toasts'); if (!t) return;
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = a.hasAttribute('download') ? 'Downloads work in the real app.' : 'Signing in with Apple, Google, Microsoft or Yahoo works in the real app.';
  t.append(el); setTimeout(() => el.remove(), 4000);
}, true);
// Only the #hash part may change: the page is hosted at an address we do not control.
for (const fn of ['pushState', 'replaceState']) {
  const orig = history[fn].bind(history);
  history[fn] = (state, title, url) => { try { const s = String(url ?? ''); const i = s.indexOf('#'); orig(state, title, location.pathname + location.search + (i >= 0 ? s.slice(i) : location.hash)); } catch { /* ignore */ } };
}
// A small note so nobody mistakes this for the real thing
window.addEventListener('DOMContentLoaded', () => {
  const tag = document.createElement('div');
  tag.setAttribute('style', 'position:fixed;left:.7rem;bottom:.7rem;z-index:80;background:#1C1814;color:#F0E4C4;border:1px solid #B8933A;border-radius:999px;padding:.35rem .8rem;font:500 12px/1.2 Jost,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25)');
  tag.id = 'ep-preview-tag'; tag.textContent = TEXT[status];
  document.body.append(tag);
});
