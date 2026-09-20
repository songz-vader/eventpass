import { h, mount } from '../lib/dom.js';
import { scanApi } from '../lib/api.js';
import { clock } from '../lib/format.js';
import { cameraPanel } from '../lib/camera.js';
import { renderVerdict, idleVerdict, errorVerdict } from '../lib/verdict.js';
import { entryBadge } from '../lib/ui.js';

// The page a volunteer opens from a staff link. It needs no login: the link's secret (in the address, after #) is the credential.
export function scanView(root, token) {
  const call = (m, p, b) => scanApi(token, m, p, b);
  const title = h('h1', 'Door check-in'), sub = h('p', { class: 'muted', style: { color: '#c9bda9' } }, 'Opening…');
  const counts = h('div', { class: 'counts' }), recent = h('div'), verdict = idleVerdict();
  const code = h('input', { class: 'scan', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '20', placeholder: 'CODE', 'aria-label': 'Guest code' });
  let timer = null;

  async function refresh() {
    const [info, rec] = await Promise.all([call('GET', '/api/scan/info'), call('GET', '/api/scan/recent')]);
    title.textContent = info.event.name;
    sub.textContent = `${info.label}. Link works until ${new Date(info.expires_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.`;
    mount(counts, [['Expected', info.stats.total], ['Arrived', info.stats.checked_in], ['Still to come', info.stats.remaining]].map(([l, n]) => h('div', h('b', String(n)), h('span', l))));
    mount(recent, rec.log.length ? h('ul', { class: 'feed' }, rec.log.map((e) => h('li', h('span', h('strong', e.guest_name), ' ', entryBadge(e.invite_type), e.via ? h('div', { class: 'small muted' }, e.via) : null), h('time', clock(e.ts))))) : null);
  }

  function dead(e) {
    clearInterval(timer); cam.destroy();
    mount(root, h('div', { class: 'scene' }, h('div', { class: 'card-dark' }, h('div', { class: 'wordmark', style: { fontSize: '3rem' } }, 'Event', h('em', 'Pass')),
      h('h1', 'This staff link is not working'), h('p', { style: { color: '#c9bda9' } }, e.message || 'Ask the host for a new one.'))));
  }

  async function checkIn(raw) {
    const c = String(raw).replace(/\s+/g, '').toUpperCase();
    if (!c) return;
    try { renderVerdict(verdict, await call('POST', '/api/scan/checkin', { code: c })); await refresh(); }
    catch (e) { if (e.status === 401) return dead(e); errorVerdict(verdict, e.message); }
  }

  const cam = cameraPanel({ onCode: checkIn });
  const camHolder = h('div', { hidden: true }, cam.el);
  const camBtn = h('button', { class: 'btn gold block', type: 'button' }, 'Scan with camera');
  camBtn.onclick = async () => { camHolder.hidden = false; try { await cam.start(); camBtn.hidden = true; } catch { /* the panel shows why */ } };
  cam.el.addEventListener('camera:stopped', () => { camHolder.hidden = true; camBtn.hidden = false; });
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => { e.preventDefault(); const c = code.value; code.value = ''; await checkIn(c); code.focus(); } }, code, h('button', { class: 'btn line block', type: 'submit' }, 'Check in typed code'));

  mount(root, h('div', { class: 'scene', style: { alignItems: 'flex-start' } }, h('div', { class: 'scan-wrap' },
    h('div', { class: 'wordmark', style: { fontSize: '2rem' } }, 'Event', h('em', 'Pass')), title, sub, counts, camBtn, camHolder, form, verdict, recent)));
  refresh().then(() => code.focus()).catch(dead);
  timer = setInterval(() => refresh().catch((e) => { if (e.status === 401) dead(e); }), 15000);
  return () => { clearInterval(timer); cam.destroy(); };          // leaving the page releases the camera and stops polling
}
