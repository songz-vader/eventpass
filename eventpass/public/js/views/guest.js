import { h, mount } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { go } from '../lib/router.js';
import { fmtDate, fmtTime } from '../lib/format.js';
import { busy, copyText } from '../lib/ui.js';

const safeUrl = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

export function passCard({ guest, event }, { mini = false } = {}) {
  const ev = event || {};
  const where = [ev.venue, ev.district, ev.region].filter(Boolean).join(', ') || 'Venue to be confirmed';
  const map = safeUrl(ev.map_url);
  return h('article', { class: `pass${mini ? ' mini' : ''}`, 'data-type': ev.type || 'other' },
    h('div', { class: 'main-part' },
      h('div', { class: 'for' }, 'You are invited'),
      h('div', { class: 'name' }, guest.name),
      h('div', { class: 'evname' }, ev.name || 'Your event'),
      h('dl',
        h('div', h('dt', 'Date'), h('dd', fmtDate(ev.date))),
        h('div', h('dt', 'Time'), h('dd', fmtTime(ev.time))),
        h('div', { class: 'wide' }, h('dt', 'Where'), h('dd', where, map ? [' ', h('a', { href: map, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Open map')] : null)),
        ev.dress ? h('div', h('dt', 'Dress code'), h('dd', ev.dress)) : null,
        h('div', h('dt', 'Entry'), h('dd', guest.invite_type === 'double' ? 'You and one guest' : 'One person'))),
      ev.note ? h('p', { class: 'quote' }, ev.note) : null),
    h('div', { class: 'perf', 'aria-hidden': 'true' }),
    h('div', { class: 'stub' },
      h('div', h('small', 'Show this at the entrance'), h('div', { class: 'code' }, guest.code)),
      h('img', { src: `/api/public/qr/${encodeURIComponent(guest.code)}.svg`, alt: `QR code for ${guest.code}`, width: 116, height: 116 })));
}

export function guestView(root, { code = '' } = {}) {
  const showEntry = (err = '', prefill = '') => {
    const inp = h('input', { class: 'codein', name: 'code', placeholder: '········', maxlength: '12', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Invitation code', value: prefill });
    const msg = h('div', { class: 'formerr', role: 'alert', hidden: !err }, err);
    const btn = h('button', { class: 'btn gold block', type: 'submit', 'data-busy': 'Opening…' }, 'Open my invitation');
    const form = h('form', { class: 'card-dark', onsubmit: (e) => { e.preventDefault(); lookup(inp.value, btn, msg); } },
      h('div', { class: 'wordmark', style: { fontSize: '3.2rem' } }, 'Event', h('em', 'Pass')),
      h('p', { class: 'muted', style: { color: '#c9bda9' } }, 'Type the code from your invitation message.'), inp, msg, btn,
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('button', { type: 'button', class: 'linkbtn', onclick: () => { history.pushState(null, '', '/'); go('#/'); } }, 'Home'),
        h('button', { type: 'button', class: 'linkbtn', onclick: () => { history.pushState(null, '', '/'); go('#/login'); } }, 'Host sign-in')));
    mount(root, h('div', { class: 'scene' }, form));
    inp.focus();
  };

  async function lookup(raw, btn, msg) {
    const c = String(raw || '').trim();
    if (!c) { if (msg) { msg.textContent = 'Enter your code.'; msg.hidden = false; } return; }
    await busy(btn, async () => {
      const data = await post('/api/public/invite', { code: c });
      showPass(data);
    }, { onError: (e) => { if (msg) { msg.textContent = e.message; msg.hidden = false; } else showEntry(e.message, c); } });
  }

  function showPass(data) {
    mount(root, h('div', { class: 'scene' }, h('div', { class: 'stack', style: { alignItems: 'center', width: '100%' } },
      passCard(data),
      h('div', { class: 'row' },
        h('button', { class: 'btn line', type: 'button', style: { color: '#faf8f4', borderColor: '#5a5148' }, onclick: () => copyText(data.guest.code, 'Code copied') }, 'Copy code'),
        h('button', { class: 'linkbtn', type: 'button', onclick: () => { history.replaceState(null, '', '/'); showEntry(); } }, 'Use a different code')))));
  }

  if (code) { showEntry('', code); lookup(code, null, null); } else showEntry();
}
