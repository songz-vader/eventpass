import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the artifact runtime's shared database: paths → JSON, with live snapshots, like claude.use('db').
function makeStore() {
  const docs = new Map(), subs = new Set();
  const store = { docs, failWrites: null, writes: 0 };
  const col = (path) => path.split('/').slice(0, -1).join('/');
  const inCol = (name) => [...docs].filter(([p]) => col(p) === name);
  const docSnap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path), metadata: { fromCache: false, hasPendingWrites: false } });
  const deliver = (s) => {
    if (s.doc) return s.next(docSnap(s.doc));
    const now = new Map(inCol(s.name).map(([p, v]) => [p, JSON.stringify(v)]));
    const changes = [];
    for (const [p, j] of now) if (!s.last.has(p)) changes.push({ type: 'added', doc: docSnap(p), oldIndex: -1, newIndex: 0 }); else if (s.last.get(p) !== j) changes.push({ type: 'modified', doc: docSnap(p), oldIndex: 0, newIndex: 0 });
    for (const [p, j] of s.last) if (!now.has(p)) changes.push({ type: 'removed', doc: { id: p.split('/').pop(), exists: true, data: () => JSON.parse(j), metadata: {} }, oldIndex: 0, newIndex: -1 });
    s.last = now;
    s.next({ docs: inCol(s.name).map(([p]) => docSnap(p)), size: now.size, empty: !now.size, docChanges: () => changes, metadata: {} });
  };
  const notify = (path) => { for (const s of subs) if (s.doc === path || s.name === col(path)) queueMicrotask(() => deliver(s)); };
  const gate = () => { if (store.failWrites) throw { code: store.failWrites, message: 'refused' }; store.writes++; };
  const doc = (path) => ({ id: path.split('/').pop(), path,
    get: async () => docSnap(path), set: async (d) => { gate(); docs.set(path, JSON.parse(JSON.stringify(d))); notify(path); }, delete: async () => { gate(); docs.delete(path); notify(path); },
    onSnapshot(next) { const s = { doc: path, next }; subs.add(s); queueMicrotask(() => deliver(s)); return () => subs.delete(s); } });
  store.db = { doc, collection: (name) => ({ path: name, doc: (id) => doc(`${name}/${id}`), get: async () => ({ docs: inCol(name).map(([p]) => docSnap(p)) }),
    onSnapshot(next) { const s = { name, next, last: new Map() }; subs.add(s); queueMicrotask(() => deliver(s)); return () => subs.delete(s); } }) };
  return store;
}

function openPage(html, { store = null, user = null, url = 'https://preview.example/artifacts/abc123' } = {}) {
  const problems = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e.detail?.stack || e.message)));
  vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));
  vc.on('warn', (...a) => problems.push('console.warn: ' + a.join(' ')));       // includes "[preview] no mock for …"
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
    w.Response = Response; w.TextEncoder = TextEncoder;
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    if (user) w.localStorage.setItem('ep_preview_user', user);
    if (store) w.claude = { use: async (name) => (name === 'db' ? store.db : null) };
  } });
  const { window } = dom, doc = window.document;
  const $ = (s, r = doc) => r.querySelector(s), $$ = (s, r = doc) => [...r.querySelectorAll(s)];
  // visible text only: the inline script would otherwise match every phrase the app contains
  const text = () => [...doc.body.children].filter((e) => !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(e.tagName)).map((e) => e.textContent).join(' ').replace(/\s+/g, ' ');
  const byText = (s, re, r = doc) => $$(s, r).find((e) => re.test(e.textContent));
  const p = {
    window, doc, $, $$, text, byText, problems,
    async waitFor(fn, what, ms = 4000) { const end = Date.now() + ms; for (;;) { try { const v = fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() > end) throw new Error(`Timed out: ${what} [hash ${window.location.hash}, heading "${$('.page-head h1')?.textContent}", rows ${$$('tbody tr').length}, modal ${!!$('.modal')}]\n${text().slice(0, 300)}\n${problems.join('\n')}`); await sleep(15); } },
    set: (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); },
    submit: (f) => f.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    click: (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })),
    flush: async () => { await sleep(30); await window.__EP_DEMO__.flush(); },
    async tab(label, head) { p.click(byText('.tab', new RegExp(`^\\W*${label}$`))); await p.waitFor(() => byText('.page-head h1', new RegExp(head || label)) && !/Loading…/.test($('#tabhost').textContent), label); },
    async register(name, email = `${name.toLowerCase().replace(/\W/g, '')}@example.co.tz`) {
      await p.waitFor(() => /I'm hosting/.test(text()), 'landing');
      p.click(byText('.door-card', /hosting/)); await p.waitFor(() => $('form input[name=email]'), 'login');
      p.click(byText('button.linkbtn', /Create an account/)); await p.waitFor(() => $('form input[name=name]'), 'register');
      const f = $('form'); p.set($('[name=name]', f), name); p.set($('[name=email]', f), email); p.set($('[name=password]', f), 'tembo-anakula-mihogo-7'); p.submit(f);
      await p.waitFor(() => $('.shell'), 'workspace');
    },
    async addEvent(name) {
      await p.tab('Events'); await p.waitFor(() => byText('button', /Create your first event|New event/), 'events page');
      p.click(byText('button', /Create your first event|New event/)); await p.waitFor(() => $('.modal form'), 'event form');
      p.set($('.modal [name=name]'), name); p.set($('.modal [name=date]'), '2099-12-12'); p.set($('.modal [name=venue]'), 'Mlimani City');
      p.click(byText('.modal footer button', /Create event/)); await p.waitFor(() => !$('.modal') && byText('tbody tr', new RegExp(name)), 'event listed');
    },
    async addGuest(name, phone = '') {
      await p.tab('Guests'); const f = await p.waitFor(() => $('form.stack'), 'guest form');
      p.set($('[name=name]', f), name); p.set($('[name=phone]', f), phone); p.submit(f);
      await p.waitFor(() => byText('tbody tr', new RegExp(name)), 'guest listed');
    },
  };
  return p;
}

// The stand-alone page must start as a blank canvas, keep what people do in a shared store, and stay self-contained.
test('the stand-alone page starts blank and keeps activity in its shared store', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ep-preview-')), 'preview.html');
  execFileSync(process.execPath, [path.join(ROOT, 'demo', 'build.mjs'), file], { stdio: 'pipe' });
  const html = fs.readFileSync(file, 'utf8');
  const store = makeStore();
  const pages = [];
  const open = (o) => { const pg = openPage(html, o); pages.push(pg); return pg; };
  t.after(() => pages.forEach((pg) => pg.window.close()));

  await t.test('the file is self-contained and contains no pre-filled people or events', () => {
    assert.ok(!/<script[^>]+src=/.test(html) && !/<link[^>]+href="\/(css|js)\//.test(html));
    for (const seed of ['Mama Neema Joseph', 'Dr. Edson Lyimo', 'Kilimanjaro Tech Summit', 'atsk_demo_key', 'amina@example.co.tz']) assert.ok(!html.includes(seed), `no "${seed}" baked in`);
  });

  let A;
  await t.test('a first visitor sees an empty canvas everywhere, and the store is empty too', async () => {
    A = open({ store });
    await A.register('Amina Hassan');
    await A.waitFor(() => /Start with your first event/.test(A.text()), 'blank overview');
    assert.match(A.$('#ep-preview-tag').textContent, /Saved in this page's shared store/);
    await A.tab('Events'); await A.waitFor(() => /No events yet/.test(A.text()), 'no events');
    await A.tab('Guests'); await A.waitFor(() => /Create an event first/.test(A.text()), 'no guests');
    await A.tab('Check-in'); await A.waitFor(() => /Create an event and add guests first/.test(A.text()), 'nothing to check in');
    await A.tab('Messaging'); await A.waitFor(() => /Not connected yet/.test(A.text()), 'no messaging set up');
    await A.tab('Messages', 'Message log'); await A.waitFor(() => /Nothing sent yet/.test(A.text()), 'empty log');
    await A.tab('Account'); await A.waitFor(() => /Amina Hassan/.test(A.$('input[name=name]')?.value || ''), 'own profile');
    assert.equal(store.docs.size, 0, 'nothing has been written to the store yet');
  });

  await t.test('what a person does is written to the store, and typed API keys are not', async () => {
    await A.addEvent('Harusi ya Test');
    await A.addGuest('Zawadi Test', '0754 111 222');
    await A.tab('Messaging'); await A.waitFor(() => A.$('form.stack [name=username]'), 'sms form');
    const f = A.$('form.stack'); A.set(A.$('[name=username]', f), 'sandbox'); A.set(A.$('[name=apiKey]', f), 'atsk_TESTSECRET_1234'); A.submit(f);
    await A.waitFor(() => /Connected to Africa's Talking/.test(A.text()), 'connected');
    await A.addGuest('Baraka Sent', '0712 333 444');
    await A.flush();
    const keys = [...store.docs.keys()];
    assert.ok(keys.some((k) => k.startsWith('events/')) && keys.filter((k) => k.startsWith('guests/')).length === 2 && keys.some((k) => k.startsWith('activity/')));
    assert.ok([...store.docs.values()].some((d) => d.name === 'Harusi ya Test'));
    assert.ok([...store.docs.values()].some((d) => d.name === 'Baraka Sent' && d.sms_sent === true), 'the simulated auto-send is recorded');
    assert.ok(!JSON.stringify([...store.docs]).includes('TESTSECRET'), 'the API key never reaches the shared store');
    assert.equal(store.docs.get('channels/sms').config.username, 'sandbox');
  });

  let B;
  await t.test('a second person joins, sees the same workspace, and each sees the other\'s changes', async () => {
    B = open({ store });
    await B.register('Baraka Mushi');
    await B.waitFor(() => /Harusi ya Test/.test(B.text()), 'the event made by the first person');
    await B.tab('Guests'); await B.waitFor(() => B.$$('tbody tr').length === 2, 'both guests');
    await B.addGuest('Rehema From B');
    await B.flush();
    await A.tab('Guests'); await A.waitFor(() => A.$$('tbody tr').length === 3 && A.byText('tbody tr', /Rehema From B/), 'B\'s guest appears for A');
    await A.tab('Overview'); await A.waitFor(() => /"Rehema From B" invited to "Harusi ya Test" \(Baraka Mushi\)/.test(A.text()), 'activity shows who did it');
  });

  await t.test('reloading keeps the person signed in and the data in place; keys must be entered again', async () => {
    const A2 = open({ store, user: A.window.localStorage.getItem('ep_preview_user') });
    await A2.waitFor(() => A2.$('.shell') && /Harusi ya Test/.test(A2.text()), 'straight back into the workspace');
    await A2.tab('Messaging'); await A2.waitFor(() => /Not connected yet/.test(A2.text()), 'key was not kept');
    assert.equal(A2.$('[name=username]').value, 'sandbox', 'non-secret settings were kept');
  });

  await t.test('door staff links work across people, and the store holds only a hash of the secret', async () => {
    await A.tab('Guests'); await A.waitFor(() => A.$$('tbody tr').length === 3, 'guests');
    const code = A.$('tbody tr:nth-child(1) td:nth-child(3) .mono').textContent;
    await A.tab('Check-in'); await A.waitFor(() => A.byText('button', /^New staff link$/), 'check-in');
    A.click(A.byText('button', /^New staff link$/)); await A.waitFor(() => A.$('.modal input[name=label]'), 'form');
    A.click(A.byText('.modal footer button', /Create link/)); await A.waitFor(() => A.$('.modal input[readonly]'), 'link made');
    const token = A.$('.modal input[readonly]').value.split('#/scan/')[1];
    A.click(A.byText('.modal footer button', /^Done$/));
    await A.flush();
    assert.ok(!JSON.stringify([...store.docs]).includes(token), 'the secret is not stored');
    assert.ok([...store.docs].some(([k, v]) => k.startsWith('links/') && /^[0-9a-f]{64}$/.test(v.token_hash)));
    await B.waitFor(() => true, 'B ready');
    B.window.location.hash = '#/scan/' + token;
    await B.waitFor(() => B.$('.scan-wrap h1') && /Harusi ya Test/.test(B.$('.scan-wrap h1').textContent), 'B opens the scanner page');
    B.set(B.$('.scan-wrap input.scan'), code); B.submit(B.$('.scan-wrap form'));
    await B.waitFor(() => B.$('.scan-wrap .verdict').dataset.state === 'ok', 'B admits a guest');
    await B.flush();
    await A.tab('Check-in'); await A.waitFor(() => A.$$('.counts b')[1]?.textContent === '1', 'A sees the arrival');
    assert.match(A.text(), /scanned by/);
  });

  await t.test('a viewer who cannot write is told their changes are not saved, and can still look around', async () => {
    const ro = makeStore(); ro.failWrites = 'invalid_argument';
    const C = open({ store: ro });
    await C.register('Read Only');
    await C.addEvent('Only Here');
    await C.flush();
    await C.waitFor(() => /not being saved/.test(C.$('#ep-preview-tag').textContent), 'read-only notice');
    assert.equal(ro.docs.size, 0);
  });

  await t.test('opened outside claude.ai there is no shared store: it works, and says a reload starts blank', async () => {
    const D = open({});
    await D.register('No Store');
    await D.addEvent('Memory Only');
    assert.match(D.$('#ep-preview-tag').textContent, /Not saved/);
  });

  await t.test('buttons that need the real server explain themselves instead of leaving the page', async () => {
    await A.tab('Account'); await A.waitFor(() => A.byText('a', /Connect Apple/), 'providers');
    const ev = new A.window.MouseEvent('click', { bubbles: true, cancelable: true }); A.byText('a', /Connect Apple/).dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    await A.waitFor(() => /works in the real app/.test(A.$('#toasts').textContent), 'explanation');
    assert.equal(A.window.location.pathname, '/artifacts/abc123', 'the hosting address is left alone');
  });

  for (const [i, pg] of pages.entries()) assert.deepEqual(pg.problems, [], `page ${i}: no errors, and no call the mock does not know`);
});
