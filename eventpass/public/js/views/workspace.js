import { h, mount, $, $$ } from '../lib/dom.js';
import { store, post } from '../lib/api.js';
import { go } from '../lib/router.js';
import { busy, toast, pageHead, page } from '../lib/ui.js';

// A built-in tab has a hand-made screen. Any other tab the server lists (endpoint + columns) is drawn by the generic table,
// so a new backend feature can appear here without changing this file.
const BUILTIN = {
  overview: () => import('../tabs/overview.js'),
  events: () => import('../tabs/events.js'),
  guests: () => import('../tabs/guests.js'),
  checkin: () => import('../tabs/checkin.js'),
  messaging: () => import('../tabs/messaging.js'),
  account: () => import('../tabs/account.js'),
};

let cleanup = null;
let token = 0;

export async function workspace(root, tabId, q) {
  const tabs = store.config.tabs;
  const def = tabs.find((t) => t.id === tabId) || tabs[0];
  if (def.id !== tabId) { history.replaceState(null, '', `${location.pathname}#/app/${def.id}`); }

  if (root.dataset.view !== 'workspace') buildShell(root, tabs);
  $$('.tab', root).forEach((b) => (b.dataset.id === def.id ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  refreshBanner();

  const outer = $('#tabhost', root);
  const mine = ++token;
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* tab already gone */ } }
  cleanup = null;
  // Every load draws into its own container. If the person has moved on by the time a slow tab finishes, it draws into a container
  // that is no longer on the page, so it can never paint over the tab they are looking at now.
  const host = h('div');
  outer.replaceChildren(host);
  mount(host, pageHead(def.title || def.label, def.sub || ''), page(h('p', { class: 'muted' }, 'Loading…')));
  try {
    let mod;
    if (def.builtin && BUILTIN[def.id]) mod = await BUILTIN[def.id]();
    else mod = await import('../tabs/table.js');
    if (mine !== token) return;                        // the person already moved on
    const out = await mod.default(host, { def, q, refreshUser });
    if (mine === token && typeof out === 'function') cleanup = out;
  } catch (e) {
    if (mine !== token) return;
    mount(host, pageHead(def.label), page(h('div', { class: 'formerr' }, e.message || 'This screen could not be loaded.'), h('div', h('button', { class: 'btn line', type: 'button', onclick: () => workspace(root, tabId, q) }, 'Try again'))));
  }
}

function buildShell(root, tabs) {
  root.dataset.view = 'workspace';
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' }, tabs.map((t) => h('button', { class: 'tab', type: 'button', 'data-id': t.id, onclick: () => go(`#/app/${t.id}`) }, h('span', { class: 'ic', 'aria-hidden': 'true' }, t.icon || '•'), t.label)));
  const who = h('div', { class: 'who' }, h('b', { id: 'who-name' }, store.user.name || store.user.email), h('span', { id: 'who-email', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, store.user.email),
    h('button', { type: 'button', onclick: signOut }, 'Sign out'));
  mount(root, h('div', { class: 'shell' },
    h('aside', { class: 'rail' }, h('div', { class: 'brand' }, 'Event', h('em', 'Pass')), nav, who),
    h('div', { class: 'main' }, h('div', { id: 'banner' }), h('main', { id: 'tabhost' }))));
}

function refreshBanner() {
  const box = $('#banner'); if (!box) return;
  box.replaceChildren();
  if (store.user && !store.user.email_verified) {
    const b = h('button', { class: 'btn sm line', type: 'button', 'data-busy': 'Sending…' }, 'Send the link again');
    b.onclick = () => busy(b, async () => { await post('/api/auth/email/resend'); toast('Verification email sent.', 'ok'); });
    box.append(h('div', { class: 'banner' }, h('span', `Please verify ${store.user.email}. We sent you a link.`), b));
  }
}

async function refreshUser() {
  const { get } = await import('../lib/api.js');
  const s = await get('/api/auth/session');
  if (s.authenticated) { store.user = s.user; store.csrf = s.csrf; }
  const n = $('#who-name'); if (n) n.textContent = store.user.name || store.user.email;
  refreshBanner();
  return store.user;
}

async function signOut() {
  try { await post('/api/auth/logout'); } catch { /* signing out locally either way */ }
  store.user = null; store.csrf = null; store.events = null;
  const root = $('#app'); delete root.dataset.view;
  go('#/');
}
