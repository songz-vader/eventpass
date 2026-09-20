import { $, h, mount } from './lib/dom.js';
import { store, get } from './lib/api.js';
import { go, current } from './lib/router.js';
import { toast } from './lib/ui.js';
import { guestView } from './views/guest.js';
import { landing, loginView, registerView, forgotView, resetView, verifyView, mfaView } from './views/auth.js';
import { workspace } from './views/workspace.js';
import { scanView } from './views/scan.js';

const app = $('#app');

let leave = null;                       // a view can hand back a function that releases what it holds (camera, timers)
function route() {
  if (leave) { try { leave(); } catch { /* the view is already gone */ } leave = null; }
  const out = dispatch();
  if (typeof out === 'function') leave = out;
}

function dispatch() {
  const invite = location.pathname.match(/^\/i\/([A-Za-z0-9]{6,12})\/?$/);   // the link inside every invitation message
  if (invite) { delete app.dataset.view; return guestView(app, { code: invite[1] }); }
  if (!window.__EP_DEMO__ && location.pathname !== '/') history.replaceState(null, '', '/' + location.hash);

  const { parts, q } = current();
  const [a, b] = parts;
  if (a === 'app') {
    if (!store.user) return go('#/login');
    return workspace(app, b || 'overview', q);
  }
  delete app.dataset.view;
  if (a === 'scan' && b) return scanView(app, b);                       // door staff: works with or without a host login
  if (a === 'verify' && b) return verifyView(app, b);
  if (a === 'reset' && b) return resetView(app, b);
  if (a === 'invite') return guestView(app, {});
  if (store.user && ['login', 'register', 'forgot', '', undefined].includes(a)) return go('#/app/overview');
  if (a === 'login') return loginView(app);
  if (a === 'register') return registerView(app);
  if (a === 'forgot') return forgotView(app);
  if (a === 'mfa') return mfaView(app);
  return landing(app);
}

async function boot() {
  try {
    store.config = await get('/api/public/config');
    const s = await get('/api/auth/session');
    if (s.authenticated) { store.user = s.user; store.csrf = s.csrf; }
  } catch (e) {
    mount(app, h('div', { class: 'scene' }, h('div', { class: 'card-dark' }, h('h1', 'Cannot reach EventPass'), h('p', { style: { color: '#c9bda9' } }, e.message), h('button', { class: 'btn gold', type: 'button', onclick: () => location.reload() }, 'Try again'))));
    return;
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  window.addEventListener('ep:signedout', () => { store.user = null; store.csrf = null; store.events = null; delete app.dataset.view; toast('You were signed out. Please sign in again.'); go('#/login'); });
  route();
}
boot();
