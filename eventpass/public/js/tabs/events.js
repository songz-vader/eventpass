import { h, mount } from '../lib/dom.js';
import { store, loadEvents, post, patch, del } from '../lib/api.js';
import { go } from '../lib/router.js';
import { pageHead, page, panel, badge, empty, modal, field, input, select, applyErrors, busy, toast, confirmDialog } from '../lib/ui.js';
import { fmtDate, fmtTime, plural } from '../lib/format.js';

export const EVENT_TYPES = [['wedding', 'Wedding'], ['birthday', 'Birthday'], ['corporate', 'Corporate event'], ['conference', 'Conference'], ['gala', 'Gala'], ['party', 'Party'], ['other', 'Other']];
const typeLabel = (t) => (EVENT_TYPES.find(([v]) => v === t) || [0, t])[1];

function eventForm(ev, onSaved) {
  const e = ev || {};
  const f = {
    name: input('name', { value: e.name || '', required: true, maxlength: '120' }),
    type: select('type', EVENT_TYPES, e.type || 'wedding'),
    date: input('date', { type: 'date', value: e.date || '' }),
    time: input('time', { type: 'time', value: e.time || '' }),
    venue: input('venue', { value: e.venue || '', maxlength: '160' }),
    region: select('region', [['', 'Choose a region']].concat(store.config.regions.map((r) => [r, r])), e.region || ''),
    district: input('district', { value: e.district || '', maxlength: '80' }),
    address: input('address', { value: e.address || '', maxlength: '200' }),
    lat: input('lat', { value: e.lat ?? '', inputmode: 'decimal', placeholder: '-6.8235' }),
    lng: input('lng', { value: e.lng ?? '', inputmode: 'decimal', placeholder: '39.2695' }),
    dress: input('dress', { value: e.dress || '', maxlength: '80' }),
    note: h('textarea', { name: 'note', maxlength: '500' }, e.note || ''),
  };
  const err = h('div', { class: 'formerr', hidden: true, role: 'alert' });
  const locate = h('button', { class: 'btn line sm', type: 'button', onclick: () => {
    if (!navigator.geolocation) { toast('This browser cannot share its location.', 'err'); return; }
    locate.disabled = true;
    navigator.geolocation.getCurrentPosition((p) => { f.lat.value = p.coords.latitude.toFixed(6); f.lng.value = p.coords.longitude.toFixed(6); locate.disabled = false; toast('Location filled in from this device.', 'ok'); },
      () => { locate.disabled = false; toast('Could not get your location. Allow it in the browser, or type the coordinates.', 'err'); }, { enableHighAccuracy: true, timeout: 10000 });
  } }, 'Use my current location');
  const form = h('form', { class: 'stack', novalidate: true }, err,
    field('Event name', f.name), h('div', { class: 'grid2' }, field('Type', f.type), field('Date', f.date)),
    h('div', { class: 'grid2' }, field('Start time', f.time), field('Dress code', f.dress)),
    field('Venue', f.venue), h('div', { class: 'grid2' }, field('Region', f.region), field('District', f.district)),
    field('Street or landmark', f.address),
    h('div', { class: 'grid3' }, field('Latitude', f.lat), field('Longitude', f.lng), h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Pin on the map'), locate)),
    h('p', { class: 'hint small muted' }, 'With coordinates, guests get a map link that opens the exact spot. Without them the link searches the venue and region.'),
    field('Message to guests (optional)', f.note));
  const save = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Saving…' }, ev ? 'Save changes' : 'Create event');
  const m = modal({ title: ev ? 'Edit event' : 'New event', body: form, wide: true, footer: [h('button', { class: 'btn line', type: 'button', onclick: () => m.close() }, 'Cancel'), save] });
  const submit = () => busy(save, async () => {
    err.hidden = true;
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    if (ev) await patch(`/api/events/${ev.id}`, body); else await post('/api/events', body);
    store.events = null; m.close(); toast(ev ? 'Event updated.' : 'Event created.', 'ok'); onSaved();
  }, { onError: (x) => { const g = applyErrors(form, x); err.textContent = g; err.hidden = !g; } });
  save.onclick = submit;
  form.addEventListener('submit', (x) => { x.preventDefault(); submit(); });
}

export default async function render(host) {
  const body = h('div');

  const removeEvent = async (e, redraw) => {
    if (!(await confirmDialog({ title: `Delete "${e.name}"?`, message: `This also removes its ${plural(e.guest_count, 'guest')} and their check-in records. It cannot be undone.`, confirm: 'Delete event', danger: true }))) return;
    try { await del(`/api/events/${e.id}`); store.events = null; toast('Event deleted.'); redraw(); } catch (x) { toast(x.message, 'err'); }
  };

  const row = (e, redraw) => {
    const mapLink = e.map_url?.startsWith('https://') ? h('div', h('a', { class: 'small', href: e.map_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open map')) : null;
    const when = e.date ? [fmtDate(e.date), h('div', { class: 'small muted' }, e.time ? fmtTime(e.time) : '')] : h('span', { class: 'muted' }, 'Not set');
    const where = [e.venue, e.region].filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'Not set');
    const actions = h('td', { class: 'act' },
      h('button', { class: 'btn line sm', type: 'button', onclick: () => go(`#/app/guests?event=${e.id}`) }, 'Guests'), ' ',
      h('button', { class: 'btn quiet sm', type: 'button', onclick: () => eventForm(e, redraw) }, 'Edit'), ' ',
      h('button', { class: 'btn danger sm', type: 'button', onclick: () => removeEvent(e, redraw) }, 'Delete'));
    return h('tr',
      h('td', h('strong', e.name), h('div', badge(typeLabel(e.type)))),
      h('td', when),
      h('td', where, mapLink),
      h('td', plural(e.guest_count, 'guest'), h('div', { class: 'small muted' }, `${e.checked_in_count} checked in`)),
      actions);
  };

  const draw = async () => {
    const events = await loadEvents(true);
    if (!events.length) {
      mount(body, empty('No events yet. An event holds the date, the place and your guest list.', h('button', { class: 'btn gold', type: 'button', onclick: () => eventForm(null, draw) }, 'Create your first event')));
      return;
    }
    const head = h('thead', h('tr', ['Event', 'When', 'Where', 'Guests', ''].map((t) => h('th', t))));
    mount(body, h('div', { class: 'tblwrap' }, h('table', head, h('tbody', events.map((e) => row(e, draw))))));
  };

  const newBtn = h('button', { class: 'btn gold', type: 'button', onclick: () => eventForm(null, draw) }, 'New event');
  mount(host, pageHead('Events', 'The occasions you are hosting', newBtn), page(panel('Your events', body)));
  await draw();
}
