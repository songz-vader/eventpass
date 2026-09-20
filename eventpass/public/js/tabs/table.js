import { h, mount } from '../lib/dom.js';
import { store, get } from '../lib/api.js';
import { pageHead, page, panel, badge, empty, busy, input } from '../lib/ui.js';
import { timeAgo, fullTime } from '../lib/format.js';

// Draws any tab the server describes as { endpoint, columns[{ key, label, type }] }.
const STATUS_KIND = { failed: 'rose', delivered: 'sage', read: 'sage', sent: 'blue' };

function cell(col, row) {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return h('span', { class: 'muted' }, '–');
  switch (col.type) {
    case 'time': return h('time', { title: fullTime(v) }, timeAgo(v));
    case 'mono': return h('span', { class: 'mono' }, v);
    case 'channel': { const c = (store.config.channels || []).find((x) => x.id === v); return badge(c ? c.label : v, v === 'whatsapp' ? 'wa' : v === 'sms' ? 'blue' : ''); }
    case 'status': return badge(v, STATUS_KIND[v] || '');
    default: return String(v);
  }
}

export default async function render(host, { def }) {
  const body = h('div');
  const search = input('q', { type: 'search', placeholder: 'Filter…', class: 'input', 'aria-label': 'Filter rows', style: { maxWidth: '14rem' } });
  let rows = [];
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q ? rows.filter((r) => def.columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q))) : rows;
    mount(body, shown.length
      ? h('div', { class: 'tblwrap' }, h('table', h('thead', h('tr', def.columns.map((c) => h('th', c.label)))), h('tbody', shown.map((r) => h('tr', def.columns.map((c) => h('td', cell(c, r))))))))
      : empty(rows.length ? 'Nothing matches that filter.' : def.empty || 'Nothing here yet.'));
  };
  const load = async () => { const d = await get(def.endpoint); rows = Array.isArray(d) ? d : d.rows || Object.values(d).find(Array.isArray) || []; draw(); };
  const refresh = h('button', { class: 'btn line sm', type: 'button', 'data-busy': 'Refreshing…', onclick: () => busy(refresh, load) }, 'Refresh');
  search.addEventListener('input', draw);
  await load();
  mount(host, pageHead(def.title || def.label, def.sub), page(panel(def.title || def.label, body, [search, refresh])));
}
