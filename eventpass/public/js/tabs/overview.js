import { h, mount } from '../lib/dom.js';
import { get } from '../lib/api.js';
import { go } from '../lib/router.js';
import { pageHead, page, panel, empty } from '../lib/ui.js';
import { fmtDate, fmtTime, timeAgo, daysUntil, whenLabel, plural } from '../lib/format.js';

export default async function render(host) {
  const d = await get('/api/overview');
  const s = d.stats, ev = d.next_event;
  const pct = s.guests ? Math.round((s.checked_in / s.guests) * 100) : 0;

  const hero = ev
    ? h('div', { class: 'hero' },
        h('div', { class: 'when' }, whenLabel(daysUntil(ev.date))),
        h('h2', ev.name),
        h('div', { class: 'meta' }, [fmtDate(ev.date), fmtTime(ev.time), [ev.venue, ev.region].filter(Boolean).join(', ')].filter(Boolean).join('  |  ')),
        h('div', { class: 'meta' }, plural(ev.guest_count, 'guest'), ' invited'),
        h('div', { class: 'row' },
          h('button', { class: 'btn gold', type: 'button', onclick: () => go(`#/app/guests?event=${ev.id}`) }, 'Manage guests'),
          h('button', { class: 'btn line', type: 'button', style: { color: '#faf8f4', borderColor: '#5a5148' }, onclick: () => go(`#/app/checkin?event=${ev.id}`) }, 'Open check-in')))
    : h('div', { class: 'hero' }, h('h2', s.events ? 'No upcoming events' : 'Start with your first event'),
        h('div', { class: 'meta' }, s.events ? 'Add a date to an event and it shows up here.' : 'Add the date and place, then invite your guests. Each gets a personal code and QR pass.'),
        h('div', { class: 'row' }, h('button', { class: 'btn gold', type: 'button', onclick: () => go('#/app/events') }, s.events ? 'Go to events' : 'Create an event')));

  const figures = panel('At a glance', h('div', { class: 'body' },
    h('div', { class: 'figures' },
      h('div', h('b', String(s.events)), h('span', s.events === 1 ? 'event' : 'events')),
      h('div', h('b', String(s.guests)), h('span', s.guests === 1 ? 'guest' : 'guests')),
      h('div', h('b', String(s.invites_sent)), h('span', 'invitations sent')),
      h('div', h('b', String(s.checked_in)), h('span', 'checked in'))),
    s.guests ? h('div', { style: { marginTop: '1.2rem' } }, h('div', { class: 'bar', style: { background: 'var(--stone)' } }, h('i', { style: { width: pct + '%' } })), h('p', { class: 'small muted', style: { marginTop: '.4rem' } }, `${pct}% of your guests have arrived`)) : null));

  const activity = panel('Recent activity', d.activity.length
    ? h('ul', { class: 'feed' }, d.activity.map((a) => h('li', h('span', a.msg), h('time', timeAgo(a.ts)))))
    : empty('Nothing has happened yet. Adding guests and checking them in will show up here.'));

  const tip = s.guests > 0 && s.invites_sent === 0
    ? h('div', { class: 'note' }, 'Your guests have not been sent their invitations yet. ', h('button', { class: 'linkbtn', type: 'button', style: { color: 'var(--gold-deep)' }, onclick: () => go('#/app/messaging') }, 'Set up SMS or WhatsApp'), ' to send them automatically, or open a guest\'s pass to share it yourself.')
    : null;

  mount(host, pageHead('Overview', 'Where things stand today'), page(tip, h('div', { class: 'next' }, hero, figures), activity));
}
