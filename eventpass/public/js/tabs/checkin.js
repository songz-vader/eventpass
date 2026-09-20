import { h, mount } from '../lib/dom.js';
import { get, post, del, loadEvents } from '../lib/api.js';
import { go } from '../lib/router.js';
import { pageHead, page, panel, badge, empty, field, input, select, applyErrors, busy, toast, modal, confirmDialog, copyText, entryBadge } from '../lib/ui.js';
import { clock, timeAgo, fullTime } from '../lib/format.js';
import { cameraPanel } from '../lib/camera.js';
import { renderVerdict, idleVerdict, errorVerdict } from '../lib/verdict.js';

const DURATIONS = [[6, '6 hours'], [24, '1 day'], [72, '3 days'], [168, '7 days']];
const STATUS_KIND = { active: 'sage', expired: '', revoked: 'rose' };

function newLinkModal(events, defaultEvent, done) {
  const label = input('label', { value: 'Main gate', maxlength: '40' });
  const ev = select('event_id', events.map((e) => [e.id, e.name]), defaultEvent || events[0].id);
  const hours = select('hours', DURATIONS, 24);
  const err = h('div', { class: 'formerr', hidden: true, role: 'alert' });
  const form = h('form', { class: 'stack', novalidate: true }, err, field('Name for this link', label, { hint: 'Shown in the log next to every guest this person checks in, for example "Main gate" or "Sam".' }), field('Event', ev), field('Works for', hours));
  const make = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Creating…' }, 'Create link');
  const m = modal({ title: 'New staff link', body: form, footer: [h('button', { class: 'btn line', type: 'button', onclick: () => m.close() }, 'Cancel'), make], onClose: done });
  const submit = () => busy(make, async () => {
    const r = await post('/api/scanner-links', { event_id: Number(ev.value), label: label.value, hours: Number(hours.value) });
    const url = h('input', { class: 'input mono', readOnly: true, value: r.url, 'aria-label': 'Staff link', onfocus: (e) => e.target.select() });
    mount(m.box.querySelector('.body'),
      h('div', { class: 'note' }, 'Send this link to the person at the door, or let them scan the QR code below. Anyone who has it can check guests in for this event until it expires or you turn it off. You will not be able to see it again.'),
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '1.4rem' } },
        h('img', { src: r.qr, alt: 'QR code that opens the staff link', width: 190, height: 190, style: { border: '1px solid var(--stone)', borderRadius: '8px', background: '#fff' } }),
        h('div', { class: 'stack', style: { flex: 1, minWidth: '14rem', gap: '.6rem' } }, url, h('div', { class: 'row' }, h('button', { class: 'btn gold sm', type: 'button', onclick: () => copyText(r.url, 'Staff link copied') }, 'Copy link'),
          h('span', { class: 'small muted' }, `${r.link.label}, ${r.link.event_name}`)))),
      h('details', { class: 'small' }, h('summary', 'For a hardware scanner or your own app'),
        h('p', { class: 'muted', style: { margin: '.5rem 0' } }, 'Send each code to this address with the header below. It answers with ok, already, wrong_event or invalid.'),
        h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--warm)', padding: '.7rem', borderRadius: '6px' } }, `POST ${location.origin}/api/scan/checkin\nX-Scanner-Token: ${r.token}\nContent-Type: application/json\n\n{"code":"K7M2P9QX"}`)));
    mount(m.box.querySelector('footer'), h('button', { class: 'btn gold', type: 'button', onclick: () => m.close() }, 'Done'));
  }, { onError: (x) => { const t = applyErrors(form, x); err.textContent = t; err.hidden = !t; } });
  make.onclick = submit; form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

export default async function render(host, { q }) {
  const events = await loadEvents(true);
  if (!events.length) { mount(host, pageHead('Check-in', 'Welcome guests at the door'), page(panel('Nothing to check in yet', empty('Create an event and add guests first.', h('button', { class: 'btn gold', type: 'button', onclick: () => go('#/app/events') }, 'Create an event'))))); return; }

  const evSel = select('event', [['', 'All my events']].concat(events.map((e) => [e.id, e.name])), q.get('event') || '', { 'aria-label': 'Event at this door' });
  const code = h('input', { class: 'scan', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '20', placeholder: 'CODE', 'aria-label': 'Guest code' });
  const verdict = idleVerdict();
  const counts = h('div', { class: 'counts' });
  const logBox = h('div');
  const linksBox = h('div');

  const evQuery = () => (evSel.value ? `?event_id=${evSel.value}` : '');
  async function refresh() {
    const [st, lg] = await Promise.all([get('/api/checkin/stats' + evQuery()), get('/api/checkin/log' + evQuery() + (evSel.value ? '&' : '?') + 'limit=30')]);
    mount(counts, [['Expected', st.total], ['Arrived', st.checked_in], ['Still to come', st.remaining]].map(([l, n]) => h('div', h('b', String(n)), h('span', l))));
    mount(logBox, lg.log.length
      ? h('ul', { class: 'feed' }, lg.log.map((e) => h('li', h('span', h('strong', e.guest_name), ' ', entryBadge(e.invite_type), h('div', { class: 'small muted' }, e.event_name, e.via ? `, scanned by ${e.via}` : '')),
          h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, h('time', clock(e.ts)), h('button', { class: 'btn quiet sm', type: 'button', onclick: () => undo(e) }, 'Undo')))))
      : empty('No one has arrived yet.'));
  }

  async function undo(e) {
    if (!(await confirmDialog({ title: `Undo ${e.guest_name}'s check-in?`, message: 'They go back to "still to come" and their code works again.', confirm: 'Undo check-in' }))) return;
    try { await post('/api/checkin/undo', { guest_id: e.guest_id }); toast('Check-in undone.'); await refresh(); } catch (x) { toast(x.message, 'err'); }
    code.focus();
  }

  // One path for typed codes, barcode scanners and the camera.
  async function checkIn(raw) {
    const c = String(raw).replace(/\s+/g, '').toUpperCase();
    if (!c) return;
    try { renderVerdict(verdict, await post('/api/checkin', { code: c, event_id: evSel.value ? Number(evSel.value) : undefined })); await refresh(); }
    catch (x) { errorVerdict(verdict, x.message); }
  }

  const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (ev) => { ev.preventDefault(); const c = code.value; code.value = ''; await checkIn(c); code.focus(); } },
    code, h('button', { class: 'btn gold block', type: 'submit' }, 'Check in'));

  // ── camera ──
  const cam = cameraPanel({ onCode: checkIn });
  const camHolder = h('div', { hidden: true }, cam.el);
  const camBtn = h('button', { class: 'btn line', type: 'button', 'data-busy': 'Starting camera…' }, 'Scan with camera');
  const camOff = () => { camHolder.hidden = true; camBtn.hidden = false; code.focus(); };
  cam.el.addEventListener('camera:stopped', camOff);
  camBtn.onclick = () => busy(camBtn, async () => { camHolder.hidden = false; try { await cam.start(); camBtn.hidden = true; } catch (e) { camHolder.hidden = false; toast(e.message, 'err'); } });

  // ── door staff ──
  async function loadLinks() {
    const { links } = await get('/api/scanner-links');
    mount(linksBox, links.length
      ? h('div', { class: 'tblwrap' }, h('table', h('thead', h('tr', ['Name', 'Event', 'Status', 'Checked in', 'Expires', ''].map((t) => h('th', t)))),
          h('tbody', links.map((l) => h('tr', h('td', h('strong', l.label)), h('td', l.event_name), h('td', badge(l.status, STATUS_KIND[l.status])),
            h('td', String(l.scans), l.last_used_at ? h('div', { class: 'small muted' }, `last ${timeAgo(l.last_used_at)}`) : null),
            h('td', h('time', { title: fullTime(l.expires_at) }, l.status === 'active' ? fullTime(l.expires_at) : '–')),
            h('td', { class: 'act' }, l.status === 'active' ? h('button', { class: 'btn danger sm', type: 'button', onclick: async () => {
              if (!(await confirmDialog({ title: `Turn off "${l.label}"?`, message: 'Anyone using this link is stopped straight away.', confirm: 'Turn off', danger: true }))) return;
              try { await del(`/api/scanner-links/${l.id}`); toast('Staff link turned off.'); await loadLinks(); } catch (x) { toast(x.message, 'err'); }
            } }, 'Turn off') : null))))))
      : empty('No staff links yet. Make one so a volunteer can check guests in from their own phone, without your login.'));
  }

  evSel.addEventListener('change', () => { refresh().catch((e) => toast(e.message, 'err')); code.focus(); });
  const newLink = h('button', { class: 'btn gold', type: 'button', onclick: () => newLinkModal(events, Number(evSel.value) || null, () => loadLinks().catch(() => {})) }, 'New staff link');
  mount(host, pageHead('Check-in', 'Type a code, use a barcode scanner, or scan the QR code with the camera'),
    page(h('div', { class: 'door' },
      h('div', { class: 'stack' }, field('Event at this door', evSel), form, camBtn, camHolder, verdict),
      panel('Arrivals', h('div', h('div', { class: 'body' }, counts), logBox))),
    panel('Door staff', linksBox, newLink)));
  await Promise.all([refresh(), loadLinks()]);
  code.focus();
  const timer = setInterval(() => refresh().catch(() => {}), 15000);      // other doors' scans show up here too
  return () => { clearInterval(timer); cam.destroy(); };
}
