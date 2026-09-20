import { h, mount, debounce } from '../lib/dom.js';
import { store, get, post, put, loadEvents } from '../lib/api.js';
import { pageHead, page, panel, badge, field, input, select, applyErrors, busy, toast } from '../lib/ui.js';

const SAMPLE = { NAME: 'Asha Mwakyusa', EVENT: 'Harusi ya Neema na Juma', CODE: 'K7M2P9QX', TYPE: 'Single Entry', DATE: 'Saturday, 12 December 2026', TIME: '4:00 PM', VENUE: 'Mlimani City', LOCATION: 'Mlimani City, Kinondoni, Dar es Salaam', MAP: 'https://www.google.com/maps/search/?api=1&query=Mlimani+City', LINK: 'https://events.example.co.tz/i/K7M2P9QX' };
const sample = (t) => t.replace(/\{([A-Z]+)\}/g, (m, k) => SAMPLE[k] ?? m);
const KIND = { sms: 'sms', whatsapp: 'wa' };

function channelPanel(c, replace) {
  const inputs = {};
  const form = h('form', { class: 'stack', novalidate: true });
  const err = h('div', { class: 'formerr', hidden: true, role: 'alert' });

  const fieldEls = c.fields.map((f) => {
    const saved = c.values[f.key];
    const el = h('input', { name: f.key, type: f.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', maxlength: String(f.maxLength || 300), value: f.secret ? '' : saved || '', placeholder: f.secret && c.hasSecret?.[f.key] ? saved : f.placeholder || '' });
    inputs[f.key] = el;
    return field(f.label, el, { hint: f.secret && c.hasSecret?.[f.key] ? 'Saved. Leave this blank to keep it.' : undefined });
  });

  const tmpl = h('textarea', { name: 'template', rows: '9', maxlength: '1000', spellcheck: 'true' }, c.template);
  const meter = h('p', { class: 'small muted' });
  const updateMeter = debounce(async () => {
    if (c.id !== 'sms') { meter.textContent = `${sample(tmpl.value).length} characters in a typical message.`; return; }
    try { const r = await post('/api/public/sms-length', { text: sample(tmpl.value) }); meter.textContent = `A typical message is ${r.length} characters: ${r.segments} SMS ${r.segments === 1 ? 'part' : 'parts'} (${r.encoding}).${r.encoding === 'UCS-2' ? ' Emoji or curly quotes make messages shorter per part and cost more.' : ''}`; } catch { meter.textContent = ''; }
  }, 300);
  tmpl.addEventListener('input', updateMeter); updateMeter();
  const insert = (v) => { const a = tmpl.selectionStart ?? tmpl.value.length, b = tmpl.selectionEnd ?? a; tmpl.setRangeText(`{${v}}`, a, b, 'end'); tmpl.focus(); updateMeter(); };
  const chips = h('div', { class: 'chips', 'aria-label': 'Insert a detail' }, store.config.templateVars.map((v) => h('button', { class: 'chip', type: 'button', onclick: () => insert(v) }, `{${v}}`)));
  const defaults = store.config.defaultTemplates?.[c.id];
  const langs = defaults ? h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Start from:'), [['en', 'English'], ['sw', 'Kiswahili']].map(([k, l]) => h('button', { class: 'btn quiet sm', type: 'button', onclick: () => { tmpl.value = defaults[k]; updateMeter(); } }, l))) : null;
  const auto = h('input', { type: 'checkbox', name: 'autoSend', checked: c.autoSend });
  const testTo = h('input', { name: 'to', type: 'tel', placeholder: '0712 345 678', autocomplete: 'off' });

  const save = h('button', { class: 'btn gold', type: 'submit', 'data-busy': 'Saving…' }, 'Save settings');
  const test = h('button', { class: 'btn line', type: 'button', 'data-busy': 'Sending…' }, 'Send test message');
  test.onclick = () => busy(test, async () => { const r = await post(`/api/messaging/channels/${c.id}/test`, { to: testTo.value }); toast(`Test sent to ${r.to}.`, 'ok'); }, { onError: (e) => { err.textContent = applyErrors(form, e) || e.message; err.hidden = false; } });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault(); err.hidden = true;
    busy(save, async () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      const r = await put(`/api/messaging/channels/${c.id}`, { values, template: tmpl.value, autoSend: auto.checked });
      toast(`${c.label} settings saved.`, 'ok'); replace(r.channel);
    }, { onError: (e) => { err.textContent = applyErrors(form, e) || e.message; err.hidden = false; } });
  });

  form.append(
    h('div', { class: 'status-line' }, h('span', { class: `dot${c.configured ? ' on' : ''}` }), h('span', c.configured ? `Connected to ${c.provider}.` : `Not connected yet. Add your ${c.provider} details below.`)),
    err, h('div', { class: 'grid2' }, fieldEls),
    h('ul', { class: 'helplist' }, c.help.map((t) => h('li', t))),
    h('div', { class: 'stack', style: { gap: '.5rem' } }, field('Invitation message', tmpl), chips, langs, meter),
    h('label', { class: 'check' }, auto, h('span', 'Send this automatically when I add a guest with a phone number')),
    h('div', { class: 'row' }, save),
    h('hr', { style: { border: 0, borderTop: '1px solid var(--stone)' } }),
    h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { style: { minWidth: '14rem' } }, field('Send a test to', testTo)), test));
  return form;
}

function broadcastPanel(channels, events) {
  const ready = channels.filter((c) => c.configured);
  const out = h('div');
  if (!ready.length) return panel('Send invitations', h('div', { class: 'body' }, h('p', { class: 'muted' }, 'Connect SMS or WhatsApp above, then you can send invitations to everyone who has not had one yet.')));
  const ch = select('channel', ready.map((c) => [c.id, c.label]), ready[0].id);
  const ev = select('event_id', [['', 'All my events']].concat(events.map((e) => [e.id, e.name])), '');
  const again = h('input', { type: 'checkbox', name: 'resend' });
  const btn = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Sending…' }, 'Send invitations');
  btn.onclick = () => busy(btn, async () => {
    const r = await post('/api/messaging/broadcast', { channel: ch.value, event_id: ev.value ? Number(ev.value) : undefined, resend: again.checked });
    const lines = [`${r.sent} sent`, r.failed ? `${r.failed} failed` : null, r.already_sent ? `${r.already_sent} skipped (already sent)` : null, r.skipped_no_phone ? `${r.skipped_no_phone} skipped (no phone number)` : null].filter(Boolean);
    mount(out, h('div', { class: r.failed ? 'note' : 'formok' }, lines.join(', '), '.'),
      r.remaining ? h('p', { class: 'small' }, `${r.remaining} more are waiting. Press Send invitations again to continue.`) : null,
      r.errors?.length ? h('ul', { class: 'helplist' }, r.errors.map((x) => h('li', `${x.guest}: ${x.error}`))) : null);
  }, { onError: (e) => mount(out, h('div', { class: 'formerr' }, e.message)) });
  return panel('Send invitations', h('div', { class: 'body stack' },
    h('p', { class: 'muted' }, 'Sends the invitation to every guest who has a phone number and has not received it on this channel yet.'),
    h('div', { class: 'grid2' }, field('Channel', ch), field('Event', ev)),
    h('label', { class: 'check' }, again, h('span', 'Also send again to guests who already received it')), h('div', btn), out));
}

export default async function render(host) {
  const [{ channels }, events] = await Promise.all([get('/api/messaging/channels'), loadEvents()]);
  let active = channels[0].id;
  const list = channels.slice();
  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Message channel' });
  const body = h('div', { class: 'body' });
  const bcast = h('div');
  const draw = () => {
    mount(tabs, list.map((c) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(c.id === active), onclick: () => { active = c.id; draw(); } }, `${c.icon || ''} ${c.label}`.trim(), ' ', c.configured ? badge('on', 'sage') : null)));
    const c = list.find((x) => x.id === active);
    mount(body, channelPanel(c, (fresh) => { list[list.findIndex((x) => x.id === fresh.id)] = fresh; draw(); }));
    mount(bcast, broadcastPanel(list, events));
  };
  mount(host, pageHead('Messaging', 'How invitations reach your guests'),
    page(h('div', { class: 'note' }, 'Invitations are sent from your own SMS and WhatsApp accounts, so the messages, costs and sender name are yours. Your keys are stored encrypted and are never shown again in full.'),
      panel('Channels', h('div', h('div', { class: 'body', style: { paddingBottom: 0 } }, tabs), body)), bcast));
  draw();
}
