import { h, mount } from '../lib/dom.js';
import { store, get, post, patch, del } from '../lib/api.js';
import { go, current } from '../lib/router.js';
import { pageHead, page, panel, badge, field, input, select, applyErrors, busy, toast, modal, reauth, confirmDialog, copyText, empty } from '../lib/ui.js';
import { timeAgo, fullTime } from '../lib/format.js';
import { OAUTH_ERRORS } from '../views/auth.js';

const EVENTS = {
  login: 'Signed in', login_failed: 'Failed sign-in attempt', login_password_ok_mfa_needed: 'Password accepted, second step required', logout: 'Signed out', register: 'Account created',
  mfa_failed: 'Wrong two-step code', mfa_enabled: 'Two-step verification turned on', mfa_disabled: 'Two-step verification turned off', backup_code_used: 'Backup code used', backup_codes_regenerated: 'New backup codes created',
  password_changed: 'Password changed', password_reset: 'Password reset', password_reset_requested: 'Password reset requested', phone_verified: 'Mobile number verified', sessions_revoked: 'Other devices signed out',
  oauth_linked: 'Sign-in provider connected', oauth_unlinked: 'Sign-in provider disconnected', oauth_takeover_protection: 'Unverified sign-up cleared', email_verified: 'Email verified', reauth_failed: 'Failed identity check', 'checkin.undo': 'Check-in undone',
};

const section = (title, sub, ...kids) => panel(title, h('div', { class: 'body stack' }, sub ? h('p', { class: 'muted small' }, sub) : null, ...kids));
const errBox = () => h('div', { class: 'formerr', hidden: true, role: 'alert' });
const showErr = (box, form, e) => { const t = (form && applyErrors(form, e)) || (form ? '' : e.message); box.textContent = t; box.hidden = !t; };
const code = (name = 'code', ph = '123456') => h('input', { name, inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: ph, maxlength: '10' });

export function showBackupCodes(codes) {
  const text = codes.join('\n');
  const dl = h('a', { class: 'btn line sm', href: URL.createObjectURL(new Blob([`EventPass backup codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' })), download: 'eventpass-backup-codes.txt' }, 'Download');
  const m = modal({ title: 'Your backup codes', body: [
    h('div', { class: 'note' }, 'Save these somewhere safe now. They are shown only once. Each one lets you sign in if you lose your phone, and works a single time.'),
    h('div', { class: 'grid2' }, codes.map((c) => h('div', { class: 'mono', style: { fontSize: '1.05rem', padding: '.3rem 0' } }, c)))],
  footer: [h('button', { class: 'btn line sm', type: 'button', onclick: () => copyText(text, 'Backup codes copied') }, 'Copy all'), dl, h('button', { class: 'btn gold', type: 'button', onclick: () => m.close() }, 'I have saved them')], onClose: () => URL.revokeObjectURL(dl.href) });
}

export default async function render(host, { q, refreshUser }) {
  const draw = async () => {
    const user = await refreshUser();
    const [sessions, audit] = await Promise.all([get('/api/account/sessions'), get('/api/account/audit')]);
    mount(host, pageHead('Account', 'Your profile and how you sign in'), page(
      profile(user), password(user), phone(user), twoStep(user), providers(user), devices(sessions.sessions), data(user), history(audit.entries)));
  };
  const again = () => draw().catch((e) => toast(e.message, 'err'));

  // ── profile ──
  function profile(user) {
    const name = input('name', { value: user.name, maxlength: '80' });
    const err = errBox(); const btn = h('button', { class: 'btn gold', type: 'submit', 'data-busy': 'Saving…' }, 'Save name');
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: (e) => { e.preventDefault(); busy(btn, async () => { await patch('/api/account', { name: name.value }); toast('Saved.', 'ok'); await again(); }, { onError: (x) => showErr(err, form, x) }); } },
      err, field('Your name', name), h('div', { class: 'row' }, h('span', user.email), user.email_verified ? badge('Verified', 'sage') : badge('Not verified', 'gold')), h('div', btn));
    return section('Profile', null, form);
  }

  // ── password ──
  function password(user) {
    const cur = h('input', { name: 'current_password', type: 'password', autocomplete: 'current-password' });
    const nw = h('input', { name: 'new_password', type: 'password', autocomplete: 'new-password' });
    const err = errBox(); const btn = h('button', { class: 'btn gold', type: 'submit', 'data-busy': 'Saving…' }, user.has_password ? 'Change password' : 'Set a password');
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: (e) => { e.preventDefault(); busy(btn, async () => { await post('/api/account/password', { current_password: user.has_password ? cur.value : undefined, new_password: nw.value }); toast('Password saved. Your other devices were signed out.', 'ok'); await again(); }, { onError: (x) => showErr(err, form, x) }); } },
      err, user.has_password ? field('Current password', cur) : null, field('New password', nw, { hint: 'At least 10 characters. Avoid your name, email and common passwords.' }), h('div', btn));
    return section('Password', user.has_password ? null : 'You currently sign in through another provider. Adding a password gives you a second way in.', form);
  }

  // ── mobile number ──
  function phone(user) {
    const number = input('phone', { type: 'tel', placeholder: '0712 345 678', value: user.phone || '' });
    const chan = store.config.mfa.whatsapp ? select('channel', [['sms', 'Text message'], ['whatsapp', 'WhatsApp']], 'sms') : null;
    const c = code(); const err = errBox(); const ok = h('div', { class: 'formok', hidden: true });
    const sendBtn = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Sending…' }, user.phone && !user.phone_verified ? 'Send a new code' : 'Send code');
    const verifyBox = h('div', { class: 'stack', hidden: !(user.phone && !user.phone_verified) }, field('Code we sent you', c), h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Checking…', onclick: (e) => busy(e.currentTarget, async () => { await post('/api/account/phone/verify', { code: c.value }); toast('Mobile number verified.', 'ok'); await again(); }, { onError: (x) => showErr(err, null, x) }) }, 'Verify number'));
    sendBtn.onclick = () => busy(sendBtn, async () => { const r = await post('/api/account/phone', { phone: number.value, channel: chan?.value }); ok.textContent = `Code sent to ${r.to}${r.operator ? ` (${r.operator})` : ''}.`; ok.hidden = false; err.hidden = true; verifyBox.hidden = false; c.focus(); }, { onError: (x) => showErr(err, null, x) });
    if (user.phone_verified) {
      const rm = h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { const body = await reauth(user, { title: 'Remove mobile number', confirm: 'Remove number', danger: true, note: 'Text and WhatsApp two-step codes will be turned off too.' }); if (!body) return; try { await del('/api/account/phone', body); toast('Number removed.'); await again(); } catch (x) { toast(x.message, 'err'); } } }, 'Remove');
      return section('Mobile number', 'Used for two-step codes and to recover your account.', h('div', { class: 'row' }, h('strong', { class: 'mono' }, user.phone_masked), user.operator ? badge(user.operator) : null, badge('Verified', 'sage'), rm));
    }
    return section('Mobile number', 'Add a Tanzanian mobile number (or an international one starting with +) to use text or WhatsApp codes.', err, ok, field('Mobile number', number, { hint: 'For example 0712 345 678' }), chan ? field('Send the code by', chan) : null, h('div', sendBtn), verifyBox);
  }

  // ── two-step verification ──
  function twoStep(user) {
    const m = user.mfa;
    const rows = [];
    // authenticator app
    const totpBox = h('div');
    const totpAction = m.totp
      ? h('button', { class: 'btn danger sm', type: 'button', onclick: () => turnOff('totp', 'authenticator app') }, 'Turn off')
      : h('button', { class: 'btn gold sm', type: 'button', 'data-busy': 'Starting…' }, 'Set up');
    if (!m.totp) totpAction.onclick = () => busy(totpAction, async () => {
      const s = await post('/api/account/mfa/totp/setup');
      const c = code(); const err = errBox();
      const en = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Checking…' }, 'Turn on');
      mount(totpBox, h('div', { class: 'stack', style: { marginTop: '.8rem' } },
        h('p', 'Scan this with an authenticator app such as Google Authenticator, Microsoft Authenticator or Aegis. Then type the 6-digit code it shows.'),
        h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '1.4rem' } }, h('img', { src: s.qr, alt: 'QR code for your authenticator app', width: 180, height: 180, style: { border: '1px solid var(--stone)', borderRadius: '8px' } }),
          h('div', { class: 'stack', style: { gap: '.4rem' } }, h('span', { class: 'small muted' }, 'Or enter this key by hand:'), h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, s.secret.match(/.{1,4}/g).join(' ')))),
        err, field('6-digit code', c), h('div', en)));
      en.onclick = () => busy(en, async () => { const r = await post('/api/account/mfa/totp/enable', { code: c.value }); toast('Authenticator app is on.', 'ok'); if (r.backup_codes?.length) showBackupCodes(r.backup_codes); await again(); }, { onError: (x) => showErr(err, null, x) });
    });
    rows.push(mfaRow('Authenticator app', 'A code from an app on your phone. Works without signal.', m.totp, totpAction), totpBox);

    // text / WhatsApp
    for (const [id, label, avail] of [['sms', 'Text message', store.config.mfa.sms], ['whatsapp', 'WhatsApp', store.config.mfa.whatsapp]]) {
      const box = h('div');
      let action;
      if (m[id]) action = h('button', { class: 'btn danger sm', type: 'button', onclick: () => turnOff(id, label.toLowerCase()) }, 'Turn off');
      else if (!user.phone_verified) action = h('span', { class: 'small muted' }, 'Verify your number first');
      else if (!avail) action = h('span', { class: 'small muted' }, 'Not available right now');
      else {
        action = h('button', { class: 'btn gold sm', type: 'button', 'data-busy': 'Sending…' }, 'Set up');
        action.onclick = () => busy(action, async () => {
          const s = await post('/api/account/mfa/otp/send', { method: id });
          const c = code(); const err = errBox(); const en = h('button', { class: 'btn gold', type: 'button', 'data-busy': 'Checking…' }, 'Turn on');
          mount(box, h('div', { class: 'stack', style: { marginTop: '.8rem' } }, h('div', { class: 'formok' }, `We sent a code to ${s.to}.`), err, field('Code', c), h('div', en)));
          en.onclick = () => busy(en, async () => { const r = await post('/api/account/mfa/otp/enable', { method: id, code: c.value }); toast(`${label} codes are on.`, 'ok'); if (r.backup_codes?.length) showBackupCodes(r.backup_codes); await again(); }, { onError: (x) => showErr(err, null, x) });
        });
      }
      rows.push(mfaRow(label, `A 6-digit code sent to your verified number by ${id === 'sms' ? 'text message' : 'WhatsApp'}.`, m[id], action), box);
    }

    if (m.enabled) {
      const regen = h('button', { class: 'btn line sm', type: 'button', onclick: async () => { const body = await reauth(user, { title: 'Create new backup codes', confirm: 'Create codes', note: 'Your old codes will stop working.' }); if (!body) return; try { const r = await post('/api/account/mfa/backup-codes', body); showBackupCodes(r.backup_codes); await again(); } catch (x) { toast(x.message, 'err'); } } }, 'New codes');
      rows.push(mfaRow('Backup codes', `${m.backup_remaining} of 10 unused. One works if you lose your phone.`, m.backup_remaining > 0, regen));
    }
    return section('Two-step verification', m.enabled ? 'Signing in needs a code as well as your password or provider.' : 'Add a second check so a stolen password alone is not enough.', ...rows);
  }
  function mfaRow(title, sub, on, action) {
    return h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '1rem' } }, h('div', h('strong', title), on ? [' ', badge('On', 'sage')] : null, h('div', { class: 'small muted' }, sub)), action);
  }
  async function turnOff(method, label) {
    const body = await reauth(user0(), { title: `Turn off ${label}`, confirm: 'Turn off', danger: true });
    if (!body) return;
    try { await del(`/api/account/mfa/${method}`, body); toast(`${label[0].toUpperCase() + label.slice(1)} turned off.`); await again(); } catch (x) { toast(x.message, 'err'); }
  }
  const user0 = () => store.user;

  // ── connected sign-in providers ──
  function providers(user) {
    const list = (store.config.oauth || []).filter((p) => p.enabled || user.providers.some((x) => x.provider === p.id));
    if (!list.length) return null;
    const rows = list.map((p) => {
      const linked = user.providers.find((x) => x.provider === p.id);
      const action = linked
        ? h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { const body = await reauth(user0(), { title: `Disconnect ${p.label}`, confirm: 'Disconnect', danger: true }); if (!body) return; try { await del(`/api/account/providers/${p.id}`, body); toast(`${p.label} disconnected.`); await again(); } catch (x) { toast(x.message, 'err'); } } }, 'Disconnect')
        : h('a', { class: 'btn line sm', href: `/api/auth/oauth/${encodeURIComponent(p.id)}/start?mode=link` }, `Connect ${p.label}`);
      return h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('div', h('strong', p.label), linked ? [' ', badge('Connected', 'sage'), linked.email ? h('div', { class: 'small muted' }, linked.email) : null] : null), action);
    });
    return section('Sign in with', 'Connect an account to sign in without typing a password.', ...rows);
  }

  // ── devices ──
  function devices(list) {
    const others = list.filter((s) => !s.current);
    const all = others.length ? h('button', { class: 'btn line sm', type: 'button', onclick: async () => { if (!(await confirmDialog({ title: 'Sign out other devices?', message: `${others.length} other ${others.length === 1 ? 'device' : 'devices'} will be signed out.`, confirm: 'Sign them out' }))) return; try { await post('/api/account/sessions/revoke-others'); toast('Other devices signed out.', 'ok'); await again(); } catch (x) { toast(x.message, 'err'); } } }, 'Sign out all others') : null;
    return panel('Devices signed in', h('ul', { class: 'feed' }, list.map((s) => h('li', h('span', h('strong', s.device), s.current ? [' ', badge('This device', 'gold')] : null, h('div', { class: 'small muted' }, `${s.ip || 'Unknown address'}, last active ${timeAgo(s.last_seen)}`)),
      s.current ? null : h('button', { class: 'btn quiet sm', type: 'button', onclick: async () => { try { await del(`/api/account/sessions/${encodeURIComponent(s.id)}`); toast('Device signed out.'); await again(); } catch (x) { toast(x.message, 'err'); } } }, 'Sign out')))), all ? [all] : null);
  }

  // ── your data ──
  function data(user) {
    const rm = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      const body = await reauth(user0(), { title: 'Delete your account', confirm: 'Delete everything', danger: true, note: 'This permanently deletes your events, guests, check-in records and settings. It cannot be undone.' });
      if (!body) return;
      try { await del('/api/account', body); store.user = null; store.csrf = null; store.events = null; toast('Your account was deleted.'); delete document.getElementById('app').dataset.view; go('#/'); } catch (x) { toast(x.message, 'err'); }
    } }, 'Delete my account');
    return section('Your data', 'Download everything stored about you, or delete your account.', h('div', { class: 'row' }, h('a', { class: 'btn line', href: '/api/account/export', download: 'eventpass-export.json' }, 'Download my data'), rm));
  }

  // ── security history ──
  function history(entries) {
    return panel('Security history', entries.length ? h('div', { class: 'tblwrap' }, h('table', h('thead', h('tr', ['When', 'What happened', 'Device', 'Address'].map((t) => h('th', t)))),
      h('tbody', entries.map((e) => h('tr', h('td', h('time', { title: fullTime(e.ts) }, timeAgo(e.ts))), h('td', EVENTS[e.event] || e.event), h('td', e.device || '–'), h('td', { class: 'mono' }, e.ip || '–')))))) : empty('Nothing recorded yet.'));
  }

  const linked = q.get('linked'); const oerr = q.get('oauth_error');
  await draw();
  if (linked) toast(`${linked[0].toUpperCase() + linked.slice(1)} connected.`, 'ok');
  if (oerr) toast(OAUTH_ERRORS[oerr] || 'Could not connect that account.', 'err');
  if (linked || oerr) history_replace();
  function history_replace() { window.history.replaceState(null, '', location.pathname + '#/app/account'); }
}
