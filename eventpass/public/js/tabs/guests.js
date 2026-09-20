import { h, mount } from '../lib/dom.js';
import { store, get, post, patch, del, loadEvents } from '../lib/api.js';
import { go, current } from '../lib/router.js';
import { pageHead, page, panel, badge, entryBadge, empty, modal, field, input, select, applyErrors, busy, toast, confirmDialog, copyText } from '../lib/ui.js';
import { debounce } from '../lib/dom.js';
import { passCard } from '../views/guest.js';

const CH_KIND = { sms: 'blue', whatsapp: 'wa' };

function parseList(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /name/i.test(lines[0]) && /phone|number|simu/i.test(lines[0])) lines.shift();   // a header row
  for (const line of lines) {
    const c = line.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, ''));
    rows.push({ name: c[0] || '', phone: c[1] || '', invite_type: /^(double|2|\+1|plus ?one)$/i.test(c[2] || '') ? 'double' : 'single' });
  }
  return rows;
}

function importModal(events, eventId, done) {
  const ev = select('event_id', events.map((e) => [e.id, e.name]), eventId || events[0]?.id);
  const area = h('textarea', { name: 'list', rows: '8', placeholder: 'Asha Mwakyusa, 0712 345 678\nJuma Salim, 0754 111 222, double\nMama Neema' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', 'aria-label': 'Choose a file' });
  file.addEventListener('change', async () => { if (file.files[0]) { area.value = await file.files[0].text(); update(); } });
  const count = h('p', { class: 'small muted' }, 'Nothing pasted yet.');
  const out = h('div');
  const update = () => { const n = parseList(area.value).length; count.textContent = n ? `${n} ${n === 1 ? 'guest' : 'guests'} found.` : 'Nothing pasted yet.'; };
  area.addEventListener('input', update);
  const go2 = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Importing…' }, 'Import guests');
  const m = modal({ title: 'Import a guest list', wide: true, body: [
    h('p', { class: 'muted' }, 'One guest per line: name, phone number, and "double" if they may bring one person. The phone number is optional. You can also choose a CSV file exported from a spreadsheet.'),
    field('Event', ev), field('Guests', area), file, count, out],
  footer: [h('button', { class: 'btn line', type: 'button', onclick: () => m.close() }, 'Close'), go2] });
  go2.onclick = () => busy(go2, async () => {
    const guests = parseList(area.value);
    if (!guests.length) { toast('Paste at least one guest first.', 'err'); return; }
    const r = await post('/api/guests/bulk', { event_id: Number(ev.value), guests });
    done();
    mount(out, h('div', { class: r.created ? 'formok' : 'formerr' }, `${r.created} added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`),
      r.skipped.length ? h('div', { class: 'tblwrap' }, h('table', h('thead', h('tr', ['Line', 'Name', 'Why'].map((t) => h('th', t)))), h('tbody', r.skipped.map((s) => h('tr', h('td', String(s.row)), h('td', s.name || '–'), h('td', s.reason)))))) : null,
      r.created ? h('p', { class: 'small muted' }, 'Invitations are not sent automatically for imported guests. Use "Send invitations" in the Messaging tab when you are ready.') : null);
  }, { onError: (e) => mount(out, h('div', { class: 'formerr' }, e.message)) });
}

function editModal(g, done) {
  const name = input('name', { value: g.name, maxlength: '100' });
  const phone = input('phone', { value: g.phone, type: 'tel', placeholder: '0712 345 678' });
  const type = select('invite_type', [['single', 'Single entry (one person)'], ['double', 'Double entry (guest and one more)']], g.invite_type);
  const err = h('div', { class: 'formerr', hidden: true });
  const form = h('form', { class: 'stack', novalidate: true }, err, field('Name', name), field('Phone', phone, { hint: 'Changing the number lets you send the invitation again.' }), field('Entry', type));
  const save = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Saving…' }, 'Save changes');
  const m = modal({ title: 'Edit guest', body: form, footer: [h('button', { class: 'btn line', type: 'button', onclick: () => m.close() }, 'Cancel'), save] });
  const submit = () => busy(save, async () => { await patch(`/api/guests/${g.id}`, { name: name.value, phone: phone.value, invite_type: type.value }); m.close(); toast('Guest updated.', 'ok'); done(); },
    { onError: (e) => { const t = applyErrors(form, e); err.textContent = t; err.hidden = !t; } });
  save.onclick = submit; form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

async function passModal(g, channels, done) {
  const events = await loadEvents();
  const event = events.find((e) => e.id === g.event_id) || { name: g.event_name };
  const tools = h('div', { class: 'stack', style: { gap: '.6rem' } });
  const msg = h('div', { class: 'row' });
  const m = modal({ title: 'Guest pass', wide: true, body: [passCard({ guest: g, event }, { mini: true }), tools, msg], footer: [h('button', { class: 'btn line', type: 'button', onclick: () => m.close() }, 'Close')] });

  const sendBtns = channels.map((c) => {
    const ok = c.configured && g.phone;
    const b = h('button', { class: `btn sm ${CH_KIND[c.id] || 'line'}`, type: 'button', disabled: !ok, 'data-busy': 'Sending…', title: ok ? '' : !g.phone ? 'This guest has no phone number' : `Set up ${c.label} in the Messaging tab first` }, `Send by ${c.label}`);
    b.onclick = () => busy(b, async () => { await post(`/api/guests/${g.id}/send`, { channel: c.id }); toast(`Invitation sent by ${c.label}.`, 'ok'); done(); });
    return b;
  });
  const download = h('a', { class: 'btn line sm', href: `/api/public/qr/${encodeURIComponent(g.code)}.svg`, download: `pass-${g.code}.svg` }, 'Download QR');
  const link = `${location.origin}/i/${g.code}`;
  const copyLink = h('button', { class: 'btn line sm', type: 'button', onclick: () => copyText(link, 'Invitation link copied') }, 'Copy invitation link');
  const copyMsg = h('button', { class: 'btn line sm', type: 'button', 'data-busy': 'Preparing…' }, 'Copy message');
  copyMsg.onclick = () => busy(copyMsg, async () => { const r = await get(`/api/guests/${g.id}/message?channel=${channels.find((c) => c.id === 'sms') ? 'sms' : channels[0].id}`); await copyText(r.text, 'Message copied'); });
  const wa = h('span');
  if (g.phone) get(`/api/guests/${g.id}/message?channel=whatsapp`).then((r) => { if (r.waLink) wa.replaceWith(h('a', { class: 'btn wa sm', href: r.waLink, target: '_blank', rel: 'noopener noreferrer' }, 'Open in WhatsApp')); }).catch(() => {});
  mount(tools, h('div', { class: 'row' }, sendBtns, wa), h('div', { class: 'row' }, copyMsg, copyLink, download));
  if (!channels.some((c) => c.configured)) mount(msg, h('p', { class: 'small muted' }, 'Sending buttons switch on once you add your SMS or WhatsApp details. ', h('button', { class: 'linkbtn', type: 'button', style: { color: 'var(--gold-deep)' }, onclick: () => { m.close(); go('#/app/messaging'); } }, 'Open Messaging')));
}

export default async function render(host, { q }) {
  const events = await loadEvents(true);
  const channels = (await get('/api/messaging/channels')).channels;
  let eventFilter = q.get('event') || '';
  let guests = [];

  const listBody = h('div');
  const evFilter = select('event', [['', 'All events']].concat(events.map((e) => [e.id, e.name])), eventFilter, { 'aria-label': 'Filter by event' });
  const search = input('q', { type: 'search', class: 'input', placeholder: 'Search name, code or phone', 'aria-label': 'Search guests', style: { maxWidth: '16rem' } });
  const exportLink = h('a', { class: 'btn line sm', href: '/api/guests/export.csv', download: 'eventpass-guests.csv' }, 'Export CSV');
  const total = h('span', { class: 'small muted' });

  const load = async () => {
    const qs = new URLSearchParams(); if (evFilter.value) qs.set('event_id', evFilter.value); if (search.value.trim()) qs.set('q', search.value.trim());
    exportLink.href = '/api/guests/export.csv' + (qs.toString() ? '?' + qs : '');
    guests = (await get('/api/guests?' + qs)).guests;
    total.textContent = `${guests.length} ${guests.length === 1 ? 'guest' : 'guests'}`;
    draw();
  };
  const refreshAll = async () => { try { store.events = null; await load(); } catch (e) { toast(e.message, 'err'); } };

  const remove = async (g) => {
    if (!(await confirmDialog({ title: `Remove ${g.name}?`, message: 'Their code will stop working straight away.', confirm: 'Remove guest', danger: true }))) return;
    try { await del(`/api/guests/${g.id}`); toast('Guest removed.'); await refreshAll(); } catch (e) { toast(e.message, 'err'); }
  };

  const sentCell = (g) => {
    const b = [g.sms_sent ? badge('SMS', 'blue') : null, g.wa_sent ? badge('WhatsApp', 'wa') : null].filter(Boolean);
    return b.length ? h('div', { class: 'row', style: { gap: '.3rem' } }, b) : h('span', { class: 'muted small' }, 'Not sent');
  };
  const row = (g) => h('tr',
    h('td', h('strong', g.name), g.phone ? h('div', { class: 'small muted' }, h('span', { class: 'mono' }, g.phone), g.operator ? ` (${g.operator})` : '') : null),
    h('td', g.event_name), h('td', h('span', { class: 'mono' }, g.code)), h('td', entryBadge(g.invite_type)), h('td', sentCell(g)),
    h('td', g.checked_in ? badge('Arrived', 'sage') : badge('Expected')),
    h('td', { class: 'act' },
      h('button', { class: 'btn line sm', type: 'button', onclick: () => passModal(g, channels, refreshAll) }, 'Pass'), ' ',
      h('button', { class: 'btn quiet sm', type: 'button', onclick: () => editModal(g, refreshAll) }, 'Edit'), ' ',
      h('button', { class: 'btn danger sm', type: 'button', 'aria-label': `Remove ${g.name}`, onclick: () => remove(g) }, 'Remove')));

  function draw() {
    if (guests.length) { mount(listBody, h('div', { class: 'tblwrap' }, h('table', h('thead', h('tr', ['Guest', 'Event', 'Code', 'Entry', 'Invitation', 'Status', ''].map((t) => h('th', t)))), h('tbody', guests.map(row))))); return; }
    mount(listBody, empty(search.value || evFilter.value ? 'No guests match that.' : 'No guests yet. Add the first one above, or import a list.'));
  }

  // ── add form ──
  const addEvent = select('event_id', events.map((e) => [e.id, e.name]), eventFilter || events[0]?.id);
  const name = input('name', { placeholder: 'Full name', maxlength: '100', autocomplete: 'off' });
  const phone = input('phone', { type: 'tel', placeholder: '0712 345 678', autocomplete: 'off' });
  const type = select('invite_type', [['single', 'Single entry'], ['double', 'Double entry']], 'single');
  const addBtn = h('button', { class: 'btn gold', type: 'submit', 'data-busy': 'Adding…' }, 'Add guest');
  const err = h('div', { class: 'formerr', hidden: true, role: 'alert' });
  const info = h('div', { class: 'note', hidden: true });
  const addForm = h('form', { novalidate: true, class: 'stack', style: { gap: '.7rem' }, onsubmit: (ev) => {
    ev.preventDefault(); err.hidden = true; info.hidden = true;
    busy(addBtn, async () => {
      const r = await post('/api/guests', { event_id: Number(addEvent.value), name: name.value, phone: phone.value, invite_type: type.value });
      const code = r.guest.code;
      if (r.sent.length) toast(`${r.guest.name} added. Invitation sent by ${r.sent.join(' and ').replace('sms', 'SMS').replace('whatsapp', 'WhatsApp')}.`, 'ok');
      else toast(`${r.guest.name} added. Code: ${code}`, 'ok');
      if (r.failed.length) { err.textContent = `Added, but the invitation was not sent: ${r.failed.map((f) => `${f.channel === 'sms' ? 'SMS' : 'WhatsApp'} (${f.error})`).join('; ')}`; err.hidden = false; }
      else if (phone.value && !r.sent.length) { info.replaceChildren('No invitation was sent because no message channel is switched on for automatic sending. Open the guest\'s pass to send it, or ', h('button', { class: 'linkbtn', type: 'button', style: { color: 'var(--gold-deep)' }, onclick: () => go('#/app/messaging') }, 'set up Messaging'), '.'); info.hidden = false; }
      name.value = ''; phone.value = ''; name.focus(); store.events = null; await load();
    }, { onError: (e) => { const t = applyErrors(addForm, e); err.textContent = t; err.hidden = !t; } });
  } }, err, info,
    h('div', { class: 'formrow' }, field('Event', addEvent), field('Guest name', name), field('Phone (optional)', phone), field('Entry', type), h('div', { class: 'field' }, h('span', { class: 'lbl', 'aria-hidden': 'true' }, '\u00a0'), addBtn)));

  evFilter.addEventListener('change', () => { eventFilter = evFilter.value; if (evFilter.value) addEvent.value = evFilter.value; load(); });
  search.addEventListener('input', debounce(() => load().catch((e) => toast(e.message, 'err')), 250));

  const importBtn = h('button', { class: 'btn line', type: 'button', onclick: () => importModal(events, Number(evFilter.value) || null, refreshAll) }, 'Import list');
  if (!events.length) {
    mount(host, pageHead('Guests', 'Everyone you are inviting'), page(panel('Add guests', empty('Create an event first, then add its guests here.', h('button', { class: 'btn gold', type: 'button', onclick: () => go('#/app/events') }, 'Create an event')))));
    return;
  }
  mount(host, pageHead('Guests', 'Everyone you are inviting', [importBtn, exportLink]),
    page(panel('Add a guest', h('div', { class: 'body' }, addForm)), panel('Guest list', listBody, [total, evFilter, search])));
  await load();
}
