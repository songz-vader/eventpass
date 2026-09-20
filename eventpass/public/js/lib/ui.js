import { h, $, mount } from './dom.js';
import { ApiFail } from './api.js';

export function toast(msg, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4000);
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const entryBadge = (type) => (type === 'double' ? badge('Double entry', 'gold') : badge('Single entry'));

// Runs an async action while a button shows a spinner, and shows failures next to the form instead of losing them.
export async function busy(btn, fn, { onError } = {}) {
  if (btn?.disabled) return;
  const label = btn ? [...btn.childNodes] : [];
  if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin', 'aria-hidden': 'true' }), ' ', btn.dataset.busy || 'Working…'); }
  try { return await fn(); }
  catch (e) { if (onError) onError(e); else toast(e.message || 'Something went wrong.', 'err'); }
  finally { if (btn) { btn.replaceChildren(...label); btn.disabled = false; } }
}

export function field(label, input, { hint, error, id } = {}) {
  const fid = id || 'f' + Math.random().toString(36).slice(2, 8);
  input.id = input.id || fid;
  const wrap = h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('span', { class: 'hint' }, hint) : null, h('span', { class: 'err', hidden: true, role: 'alert' }));
  if (error) showFieldError(wrap, error);
  return wrap;
}
function showFieldError(wrap, msg) {
  const e = $('.err', wrap); e.textContent = msg || ''; e.hidden = !msg;
  const inp = $('input,select,textarea', wrap); if (inp) inp.setAttribute('aria-invalid', msg ? 'true' : 'false');
}
// Puts server-side field messages under the right inputs; returns a general message if nothing matched.
export function applyErrors(form, err) {
  for (const w of form.querySelectorAll('.field')) showFieldError(w, '');
  let matched = false;
  for (const [name, msg] of Object.entries(err.fields || {})) {
    const inp = form.querySelector(`[name="${name}"]`);
    const w = inp?.closest('.field');
    if (w) { showFieldError(w, msg); matched = true; }
  }
  return matched && Object.keys(err.fields || {}).length ? '' : err.message;
}
export const input = (name, attrs = {}) => h('input', { name, type: 'text', ...attrs });
export const select = (name, options, value, attrs = {}) => h('select', { name, value, ...attrs }, options.map(([v, l]) => h('option', { value: v }, l)));

export function modal({ title, body, footer, wide = false, onClose }) {
  const prev = document.activeElement;
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', h('h2', title), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'body' }, body), footer ? h('footer', footer) : null);
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, box);
  document.body.append(scrim);
  document.addEventListener('keydown', onKey);
  (box.querySelector('input:not([type=hidden]),select,textarea') || box.querySelector('button.x')).focus();
  return { close, box };
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal({ title, body: h('p', message), onClose: () => { if (!done) { done = true; resolve(false); } },
      footer: [h('button', { class: 'btn line', type: 'button', onclick: () => fin(false) }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'gold'}`, type: 'button', onclick: () => fin(true) }, confirm)] });
  });
}

// Sensitive changes ask the person to prove it is them: password if they have one, otherwise a two-step code.
export function reauth(user, { title = 'Confirm it\'s you', confirm = 'Confirm', danger = false, note } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const need = user.has_password ? 'password' : user.mfa?.enabled ? 'code' : null;
    const pw = h('input', { name: 'password', type: 'password', autocomplete: 'current-password' });
    const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
    const typed = h('input', { name: 'confirm', placeholder: 'DELETE', autocomplete: 'off' });
    const err = h('div', { class: 'formerr', hidden: true });
    const go = () => {
      const body = need === 'password' ? { password: pw.value } : need === 'code' ? { code: code.value.trim(), method: /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code.value.trim()) && code.value.trim().length > 6 ? 'backup' : 'totp' } : { confirm: typed.value.trim() };
      if (need === null && typed.value.trim() !== 'DELETE' && danger) { err.textContent = 'Type DELETE to confirm.'; err.hidden = false; return; }
      done = true; resolve(body); m.close();
    };
    const m = modal({ title, onClose: () => { if (!done) { done = true; resolve(null); } },
      body: [note ? h('p', note) : null,
        need === 'password' ? field('Your password', pw) : need === 'code' ? field('Authenticator or backup code', code, { hint: 'Open your authenticator app, or use one of your backup codes.' }) : danger ? field('Type DELETE to confirm', typed) : h('p', 'This will be applied straight away.'), err],
      footer: [h('button', { class: 'btn line', type: 'button', onclick: () => { done = true; resolve(null); m.close(); } }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'gold'}`, type: 'button', onclick: go }, confirm)] });
    for (const el of [pw, code, typed]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

export const empty = (text, action) => h('div', { class: 'empty' }, h('p', text), action || null);

export async function copyText(text, okMsg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(okMsg, 'ok'); }
  catch { toast('Could not copy automatically. Select the text and copy it.', 'err'); }
}

export function panel(title, body, actions) {
  return h('section', { class: 'panel' }, h('header', h('h2', title), actions ? h('div', { class: 'row' }, actions) : null), body);
}
export { mount, ApiFail };

export const pageHead = (title, sub, actions) => h('div', { class: 'page-head' }, h('div', h('h1', title), sub ? h('p', sub) : null), actions ? h('div', { class: 'row' }, actions) : null);
export const page = (...kids) => h('div', { class: 'page' }, ...kids);
