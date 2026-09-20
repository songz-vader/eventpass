import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { startTestServer, uniqueEmail, GOOD_PASSWORD } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Runs the real front end (public/index.html + public/js/main.js) in a simulated browser against the real server.
// It clicks and types like a person would, so broken imports, wrong element ids or API mismatches show up here.
test('the front end works end to end', async (t) => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const none = { clientId: '', clientSecret: '' };
  const s = await startTestServer({ config: { oauth: { google: none, microsoft: none, yahoo: none, apple: { clientId: 'com.example.web', teamId: 'TEAM123456', keyId: 'KEYID12345', privateKey: await exportPKCS8(privateKey) }, extra: {} } } });
  t.after(() => s.close());

  const problems = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => problems.push(`jsdomError: ${e.detail?.stack || e.message}`));
  vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '').replace(/<link[^>]*(fonts|app\.css)[^>]*>/g, '');
  const dom = new JSDOM(html, { url: s.url + '/', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const jar = new Map();
  const nodeFetch = globalThis.fetch;                         // the real network; the page gets a cookie-keeping wrapper around it
  const browserFetch = async (url, init = {}) => {
    const u = new URL(url, s.url + '/');
    const headers = { ...(init.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if ((init.method || 'GET') !== 'GET') headers.origin = s.url;
    const res = await nodeFetch(u, { ...init, headers, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = sc.split(';'); const [k, ...v] = pair.split('='); const val = v.join('=');
      if (!val || attrs.some((a) => /^\s*max-age=0/i.test(a))) jar.delete(k.trim()); else jar.set(k.trim(), val);
    }
    return res;
  };
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement, HashChangeEvent: window.HashChangeEvent, CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history, fetch: browserFetch });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  // jsdom has no camera or media playback: give the page just enough to behave like a phone browser.
  window.HTMLMediaElement.prototype.play = async () => {};
  Object.defineProperty(window.HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });
  process.on('unhandledRejection', (e) => problems.push('unhandledRejection: ' + (e?.stack || e)));

  const doc = window.document;
  const $ = (sel, root = doc) => root.querySelector(sel);
  const $$ = (sel, root = doc) => [...root.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, what, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) {
      try { const v = fn(); if (v) return v; } catch { /* not ready */ }
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}\n--- page text ---\n${doc.body.textContent.replace(/\s+/g, ' ').slice(0, 600)}\n--- problems ---\n${problems.join('\n')}`);
      await sleep(15);
    }
  }
  const text = () => doc.body.textContent.replace(/\s+/g, ' ');
  const byText = (sel, re, root = doc) => $$(sel, root).find((el) => re.test(el.textContent));
  const set = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const goTab = async (label, expectHead) => { click(byText('.tab', new RegExp(`^\\W*${label}$`))); await waitFor(() => byText('.page-head h1', new RegExp(expectHead || label)) && !/Loading…/.test($('#tabhost').textContent), `${label} page`); };

  await import(pathToFileURL(path.join(ROOT, 'js', 'main.js')).href);

  await t.test('landing offers the two doors', async () => {
    await waitFor(() => /I'm hosting/.test(text()) && /I have a code/.test(text()), 'landing');
  });

  const email = uniqueEmail('ui');
  await t.test('a host can register and lands in the workspace', async () => {
    click(byText('.door-card', /hosting/));
    await waitFor(() => $('form input[name=email]'), 'login form');
    const apple = $('.oauth a[href="/api/auth/oauth/apple/start"]');
    assert.ok(apple, 'Sign in with Apple is offered because its credentials are configured');
    assert.match(apple.textContent, /Continue with Apple/);
    assert.equal($$('.oauth a').length, 1, 'providers without credentials are not shown');
    click(byText('button.linkbtn', /Create an account/));
    await waitFor(() => $('form input[name=name]'), 'register form');
    const f = $('form');
    set($('[name=name]', f), 'Neema Joseph'); set($('[name=email]', f), email); set($('[name=password]', f), GOOD_PASSWORD);
    submit(f);
    await waitFor(() => $('.shell .rail'), 'workspace shell');
    assert.ok($$('.tab').length >= 7, 'a tab for every entry the server lists, including the generic Messages tab');
    assert.ok(byText('.tab', /Messages/), 'server-declared tab appears without front-end code');
    await waitFor(() => /Start with your first event/.test(text()), 'empty overview');
    assert.match(text(), /Please verify/, 'unverified email banner');
  });

  await t.test('events: create one with a place', async () => {
    await goTab('Events');
    click(byText('button', /Create your first event|New event/));
    await waitFor(() => $('.modal form'), 'event form');
    const f = $('.modal form');
    set($('[name=name]', f), 'Harusi ya Neema & Juma');
    set($('[name=date]', f), '2099-12-12'); set($('[name=time]', f), '16:00');
    set($('[name=venue]', f), 'Mlimani City'); set($('[name=region]', f), 'Dar es Salaam');
    click(byText('.modal footer button', /Create event/));
    await waitFor(() => /Harusi ya Neema & Juma/.test($('.page').textContent) && !$('.modal'), 'event in the list');
    assert.match(text(), /Mlimani City, Dar es Salaam/);
  });

  await t.test('switching tabs quickly never lets a slow tab paint over the one you chose last', async () => {
    for (const label of ['Guests', 'Check-in', 'Overview', 'Events']) click(byText('.tab', new RegExp(`^\\W*${label}$`)));
    await waitFor(() => byText('.page-head h1', /Events/) && !/Loading…/.test($('#tabhost').textContent), 'last tab wins');
    await sleep(400);                                                          // let every earlier request finish
    assert.equal($$('.page-head').length, 1, 'one page only');
    assert.match($('.page-head h1').textContent, /Events/);
    assert.match($('.tab[aria-current=page]').textContent, /Events/);
  });

  let code;
  await t.test('guests: add one, names are shown as text (no HTML injection)', async () => {
    await goTab('Guests');
    const f = $('form.stack');
    set($('[name=name]', f), 'Asha <img src=x onerror="window.__pwned=1">'); set($('[name=phone]', f), '0754 123 456');
    submit(f);
    await waitFor(() => $$('tbody tr').length === 1, 'guest row');
    assert.match($('tbody').textContent, /Asha <img src=x/, 'shown literally');
    assert.equal($('tbody img'), null, 'not parsed as an element');
    assert.equal(window.__pwned, undefined);
    code = $('tbody tr td:nth-child(3) .mono').textContent;
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.match(text(), /\+255754123456/, 'phone normalised by the server');
  });

  await t.test('guests: the pass shows the invitation and QR', async () => {
    click(byText('tbody button', /^Pass$/));
    await waitFor(() => $('.modal .pass'), 'pass modal');
    assert.equal($('.modal .pass img').getAttribute('src'), `/api/public/qr/${code}.svg`);
    assert.match($('.modal').textContent, /Harusi ya Neema & Juma/);
    assert.ok(byText('.modal button', /Send by SMS/).disabled, 'sending is off until SMS is set up');
    click($('.modal button.x'));
    await waitFor(() => !$('.modal'), 'modal closed');
  });

  await t.test('guests: import a pasted list and search', async () => {
    click(byText('button', /^Import list$/));
    await waitFor(() => $('.modal textarea'), 'import modal');
    set($('.modal textarea'), 'Name, Phone\nJuma Salim, 0712 000 111, double\nBad Row, 12\nMama Neema');
    click(byText('.modal footer button', /Import guests/));
    await waitFor(() => /2 added, 1 skipped/.test($('.modal').textContent), 'import result');
    click(byText('.modal footer button', /^Close$/));
    await waitFor(() => $$('tbody tr').length === 3, 'three guests');
    set($('input[type=search]'), 'juma');
    await waitFor(() => $$('tbody tr').length === 1, 'search narrows the list');
    set($('input[type=search]'), '');
    await waitFor(() => $$('tbody tr').length === 3, 'search cleared');
  });

  await t.test('check-in: admit, already-in, wrong code', async () => {
    await goTab('Check-in');
    const f = $('form.stack'); const inp = $('input.scan');
    set(inp, code.toLowerCase()); submit(f);
    await waitFor(() => $('.verdict').dataset.state === 'ok', 'admitted');
    assert.match($('.verdict').textContent, /Admit 1 person/);
    set(inp, code); submit(f);
    await waitFor(() => $('.verdict').dataset.state === 'already', 'already in');
    set(inp, 'NOPE2222'); submit(f);
    await waitFor(() => $('.verdict').dataset.state === 'invalid', 'invalid');
    await waitFor(() => /Arrived/.test(text()) && $$('.counts b')[1]?.textContent === '1', 'arrival count');
    click(byText('.feed button', /Undo/));
    await waitFor(() => byText('.modal button', /Undo check-in/), 'undo confirmation');
    click(byText('.modal button', /Undo check-in/));
    await waitFor(() => $$('.counts b')[1]?.textContent === '0', 'undone');
  });

  const api = async (p) => (await browserFetch(p)).json();

  await t.test('camera: a browser with no camera says so instead of failing silently', async () => {
    click(byText('button', /^Scan with camera$/));
    await waitFor(() => /cannot use the camera/.test(doc.querySelector('#toasts').textContent), 'explanation');
  });

  await t.test('camera: a QR code held up to it checks the guest in, then the camera lets go', async () => {
    const juma = (await api('/api/guests')).guests.find((g) => g.name === 'Juma Salim');
    let stopped = 0;
    const track = { stop: () => { stopped++; }, getCapabilities: () => ({}), applyConstraints: async () => {} };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia: async () => stream }, configurable: true });
    window.__qr = `https://events.example.co.tz/i/${juma.code}`;               // the invitation link form works too
    window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code']; } async detect() { return window.__qr ? [{ rawValue: window.__qr }] : []; } };
    click(byText('button', /^Scan with camera$/));
    await waitFor(() => $('.verdict').dataset.state === 'ok' && /Juma Salim/.test($('.verdict').textContent), 'admitted by camera');
    assert.match($('.verdict').textContent, /Admit 2 people/, 'Juma has a double entry');
    window.__qr = 'https://evil.example/login';                                  // not one of ours
    await waitFor(() => /not an EventPass guest code/.test(text()), 'foreign QR refused');
    window.__qr = null;
    click(byText('button', /^Stop camera$/));
    await waitFor(() => byText('button', /^Scan with camera$/) && !byText('button', /^Scan with camera$/).hidden, 'button back');
    assert.ok(stopped >= 1, 'camera tracks were released');
    delete window.BarcodeDetector;
  });

  let staffToken;
  await t.test('door staff: create a link from the page', async () => {
    click(byText('button', /^New staff link$/));
    await waitFor(() => $('.modal input[name=label]'), 'new link form');
    set($('.modal [name=label]'), 'Gate A');
    click(byText('.modal footer button', /Create link/));
    await waitFor(() => $('.modal input[readonly]'), 'link created');
    const url = $('.modal input[readonly]').value;
    assert.match(url, /\/#\/scan\/[A-Za-z0-9_-]{40,}$/);
    assert.match($('.modal img').getAttribute('src'), /^data:image\/png;base64,/);
    assert.match($('.modal pre').textContent, /POST .*\/api\/scan\/checkin\nX-Scanner-Token: /, 'the API connector details are shown once');
    staffToken = url.split('/#/scan/')[1];
    click(byText('.modal footer button', /^Done$/));
    await waitFor(() => !$('.modal') && byText('tr', /Gate A/), 'link listed');
    assert.match(byText('tr', /Gate A/).textContent, /active/);
  });

  await t.test('door staff: the link opens a scanner page that works without a login', async () => {
    const mama = (await api('/api/guests')).guests.find((g) => g.name === 'Mama Neema');
    window.location.hash = `#/scan/${staffToken}`;
    await waitFor(() => $('.scan-wrap') && /Harusi ya Neema & Juma/.test($('.scan-wrap h1').textContent), 'scanner page');
    assert.match($('.scan-wrap').textContent, /Gate A/);
    assert.equal($('.shell'), null, 'no host workspace here');
    set($('.scan-wrap input.scan'), mama.code); submit($('.scan-wrap form'));
    await waitFor(() => $('.scan-wrap .verdict').dataset.state === 'ok' && /Mama Neema/.test($('.scan-wrap .verdict').textContent), 'admitted by staff');
    await waitFor(() => /Mama Neema/.test($('.scan-wrap .feed')?.textContent || ''), 'recent list');
  });

  await t.test('door staff: the host sees who scanned, and can turn the link off', async () => {
    window.location.hash = '#/app/checkin';
    await waitFor(() => $('.door') && /scanned by Gate A/.test(text()), 'log shows the scanner');
    click(byText('tr', /Gate A/).querySelector('button'));
    await waitFor(() => byText('.modal button', /^Turn off$/), 'confirmation');
    click(byText('.modal button', /^Turn off$/));
    await waitFor(() => /revoked/.test(byText('tr', /Gate A/).textContent), 'revoked');
    window.location.hash = `#/scan/${staffToken}`;
    await waitFor(() => /turned this staff link off/.test(text()), 'revoked link explained');
    window.location.hash = '#/app/checkin';
    await waitFor(() => $('.door'), 'back to the host');
  });

  await t.test('messaging: channels come from the server, saving connects one, a test message goes out', async () => {
    await goTab('Messaging');
    await waitFor(() => byText('.seg button', /SMS/) && byText('.seg button', /WhatsApp/), 'both channels');
    const f = $('form.stack');
    set($('[name=username]', f), 'sandbox'); set($('[name=apiKey]', f), 'atsk_ui_test_key_1234');
    submit(f);
    await waitFor(() => /Connected to Africa's Talking/.test(text()), 'connected');
    assert.equal($('[name=apiKey]').value, '', 'the saved key is never put back in the form');
    assert.equal($('[name=apiKey]').getAttribute('placeholder'), '••••1234');
    set($('[name=to]'), '0712 345 678');
    click(byText('button', /Send test message/));
    await waitFor(() => /Test sent to \+255712345678/.test(doc.querySelector('#toasts').textContent), 'test sent');
    assert.ok(s.fetch.calls.some((c) => c.url.includes('sandbox.africastalking.com') && c.body.to === '+255712345678'));
  });

  await t.test('the server-declared Messages tab is drawn by the generic table', async () => {
    await goTab('Messages', 'Message log');
    await waitFor(() => $$('tbody tr').length >= 1, 'a log row');
    assert.match($('tbody').textContent, /sent/);
  });

  await t.test('account: every section renders', async () => {
    await goTab('Account');
    await waitFor(() => /Security history/.test(text()), 'account page');
    for (const label of ['Profile', 'Password', 'Mobile number', 'Two-step verification', 'Devices signed in', 'Your data']) assert.match(text(), new RegExp(label), label);
    assert.match(text(), /This device/);
    assert.match(text(), /Sign in with/);
    assert.ok(byText('a', /Connect Apple/), 'Apple can be connected from settings');
  });

  await t.test('a guest opens their invitation from the link in the message', async () => {
    window.history.pushState(null, '', `/i/${code}`);
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await waitFor(() => $('.pass .name'), 'invitation');
    assert.match($('.pass .name').textContent, /^Asha </);
    assert.match($('.pass').textContent, /Mlimani City, Dar es Salaam/);
    assert.equal($('.pass img').getAttribute('src'), `/api/public/qr/${code}.svg`);
    assert.equal($('.pass').dataset.type, 'wedding');
  });

  await t.test('signing out returns to the landing page', async () => {
    window.history.pushState(null, '', '/#/app/overview');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await waitFor(() => $('.who button'), 'workspace');
    click($('.who button'));
    await waitFor(() => /I have a code/.test(text()) && !$('.shell'), 'landing');
    const me = await (await browserFetch('/api/auth/session')).json();
    assert.equal(me.authenticated, false);
  });

  await t.test('signing back in with the password works, and a wrong password says so', async () => {
    click(byText('.door-card', /hosting/));
    await waitFor(() => $('form input[name=password]'), 'login form');
    let f = $('form');
    set($('[name=email]', f), email); set($('[name=password]', f), 'not-my-password-1'); submit(f);
    await waitFor(() => /Incorrect email or password/.test($('.formerr')?.textContent || ''), 'wrong password message');
    set($('[name=password]', f), GOOD_PASSWORD); submit(f);
    await waitFor(() => $('.shell'), 'workspace again');
  });

  assert.deepEqual(problems, [], 'no script errors or rejected promises while using the app');
});
