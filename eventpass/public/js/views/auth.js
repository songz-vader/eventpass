import { h, mount } from '../lib/dom.js';
import { store, get, post } from '../lib/api.js';
import { go, replace, current } from '../lib/router.js';
import { busy, field, applyErrors, toast } from '../lib/ui.js';

export const OAUTH_ERRORS = {
  cancelled: 'Sign-in was cancelled.',
  invalid_state: 'That sign-in link expired or was opened in a different browser. Please try again.',
  provider_error: 'The sign-in provider could not finish. Please try again in a moment.',
  invalid_token: 'We could not verify the provider\'s response. Please try again.',
  email_unverified: 'That account has no verified email address, so it cannot be used here. Register with your email and a password, or use a different account.',
  registration_closed: 'New sign-ups are closed right now.',
  provider_disabled: 'That sign-in option is not available.',
  identity_in_use: 'That account is already connected to a different EventPass account.',
  session_changed: 'Your session changed during sign-in. Please try again.',
  login_required: 'Please sign in first.',
};
export const oauthMessage = (code) => OAUTH_ERRORS[code] || 'Sign-in did not complete. Please try again.';

export function finishLogin(res) {
  store.user = res.user; store.csrf = res.csrf; store.events = null; store.mfaToken = null;
  go('#/app/overview');
}

const wordmark = (size = '3.4rem') => h('div', { class: 'wordmark', style: { fontSize: size } }, 'Event', h('em', 'Pass'));
const scene = (...kids) => h('div', { class: 'scene' }, ...kids);
const msgBox = (kind = 'formerr') => h('div', { class: kind, role: 'alert', hidden: true });
const show = (box, text, kind) => { box.textContent = text; box.hidden = !text; if (kind) box.className = kind; };
const link = (text, hash) => h('button', { type: 'button', class: 'linkbtn', onclick: () => go(hash) }, text);

export function landing(root) {
  mount(root, scene(h('div', { class: 'stack', style: { alignItems: 'center', textAlign: 'center', gap: '2rem' } },
    wordmark('clamp(3.6rem,12vw,6rem)'),
    h('p', { style: { color: '#c9bda9', maxWidth: '30ch' } }, 'Invite your guests, send them a personal code, and welcome them at the door.'),
    h('div', { class: 'doors' },
      h('button', { class: 'door-card', type: 'button', onclick: () => go('#/login') }, h('h2', 'I\'m hosting'), h('p', 'Create events, invite guests and check them in.')),
      h('button', { class: 'door-card', type: 'button', onclick: () => go('#/invite') }, h('h2', 'I have a code'), h('p', 'Open your personal invitation.'))))));
}

function oauthButtons(verb) {
  const list = (store.config.oauth || []).filter((p) => p.enabled);
  if (!list.length) return null;
  return [h('div', { class: 'oauth' }, list.map((p) => h('a', { class: 'btn', href: `/api/auth/oauth/${encodeURIComponent(p.id)}/start` }, h('span', { class: 'g', 'aria-hidden': 'true' }, p.label[0]), `${verb} with ${p.label}`))), h('div', { class: 'divider' }, 'or use email')];
}

export function loginView(root) {
  const q = current().q;
  const err = msgBox(); if (q.get('oauth_error')) show(err, oauthMessage(q.get('oauth_error')));
  const email = h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn gold block', type: 'submit', 'data-busy': 'Signing in…' }, 'Sign in');
  const form = h('form', { class: 'card-dark', novalidate: true, onsubmit: (e) => {
    e.preventDefault(); show(err, '');
    busy(btn, async () => {
      const res = await post('/api/auth/login', { email: email.value, password: pw.value });
      if (res.mfa_required) { store.mfaToken = res.mfa_token; go('#/mfa'); } else finishLogin(res);
    }, { onError: (e2) => show(err, applyErrors(form, e2) || e2.message) });
  } },
    wordmark(), h('h1', 'Host sign-in'), oauthButtons('Continue'), err,
    field('Email', email), field('Password', pw), btn,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } }, link('Forgot password?', '#/forgot'), store.config.registration ? link('Create an account', '#/register') : null),
    link('Back', '#/'));
  mount(root, scene(form)); email.focus();
}

export function registerView(root) {
  const err = msgBox();
  if (!store.config.registration) { mount(root, scene(h('div', { class: 'card-dark' }, wordmark(), h('h1', 'Sign-ups are closed'), h('p', { class: 'muted', style: { color: '#c9bda9' } }, 'New accounts are not being accepted right now.'), link('Back to sign-in', '#/login')))); return; }
  const name = h('input', { name: 'name', autocomplete: 'name', required: true });
  const email = h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true });
  const phone = h('input', { name: 'phone', type: 'tel', autocomplete: 'tel', placeholder: '0712 345 678' });
  const pw = h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true });
  const btn = h('button', { class: 'btn gold block', type: 'submit', 'data-busy': 'Creating account…' }, 'Create account');
  const form = h('form', { class: 'card-dark', novalidate: true, onsubmit: (e) => {
    e.preventDefault(); show(err, '');
    busy(btn, async () => { finishLogin(await post('/api/auth/register', { name: name.value, email: email.value, password: pw.value, phone: phone.value.trim() || undefined })); toast('Account created. Check your email to verify it.', 'ok'); },
      { onError: (e2) => show(err, applyErrors(form, e2) || e2.message) });
  } },
    wordmark(), h('h1', 'Create your host account'), oauthButtons('Sign up'), err,
    field('Your name', name), field('Email', email, { hint: 'We send a verification link here.' }),
    field('Mobile number (optional)', phone, { hint: 'Used for two-step verification. You can add it later.' }),
    field('Password', pw, { hint: 'At least 10 characters. A few random words works well.' }), btn,
    link('I already have an account', '#/login'));
  mount(root, scene(form)); name.focus();
}

export function forgotView(root) {
  const email = h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true });
  const out = msgBox('formok'); const err = msgBox();
  const btn = h('button', { class: 'btn gold block', type: 'submit', 'data-busy': 'Sending…' }, 'Send reset link');
  const form = h('form', { class: 'card-dark', novalidate: true, onsubmit: (e) => { e.preventDefault(); show(err, ''); busy(btn, async () => { const r = await post('/api/auth/password/forgot', { email: email.value }); show(out, r.message); }, { onError: (e2) => show(err, applyErrors(form, e2) || e2.message) }); } },
    wordmark(), h('h1', 'Reset your password'), h('p', { style: { color: '#c9bda9' } }, 'Enter your email and we will send you a link that works for one hour.'), err, out, field('Email', email), btn, link('Back to sign-in', '#/login'));
  mount(root, scene(form)); email.focus();
}

export function resetView(root, token) {
  const pw = h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true });
  const again = h('input', { name: 'again', type: 'password', autocomplete: 'new-password', required: true });
  const err = msgBox(); const out = msgBox('formok');
  const btn = h('button', { class: 'btn gold block', type: 'submit', 'data-busy': 'Saving…' }, 'Set new password');
  const form = h('form', { class: 'card-dark', novalidate: true, onsubmit: (e) => {
    e.preventDefault(); show(err, '');
    if (pw.value !== again.value) { show(err, 'The two passwords do not match.'); return; }
    busy(btn, async () => { await post('/api/auth/password/reset', { token, password: pw.value }); form.replaceChildren(wordmark(), h('h1', 'Password changed'), h('p', { style: { color: '#c9bda9' } }, 'You were signed out everywhere. Sign in with your new password.'), h('button', { class: 'btn gold block', type: 'button', onclick: () => go('#/login') }, 'Go to sign-in')); },
      { onError: (e2) => show(err, applyErrors(form, e2) || e2.message) });
  } }, wordmark(), h('h1', 'Choose a new password'), err, out, field('New password', pw, { hint: 'At least 10 characters.' }), field('Repeat it', again), btn);
  mount(root, scene(form)); pw.focus();
}

export function verifyView(root, token) {
  const card = h('div', { class: 'card-dark' }, wordmark(), h('h1', 'Checking your link…'));
  mount(root, scene(card));
  post('/api/auth/email/verify', { token }).then(() => {
    if (store.user) store.user.email_verified = true;
    card.replaceChildren(wordmark(), h('h1', 'Email verified'), h('p', { style: { color: '#c9bda9' } }, 'Thank you. Your address is confirmed.'), h('button', { class: 'btn gold block', type: 'button', onclick: () => go(store.user ? '#/app/overview' : '#/login') }, store.user ? 'Open my workspace' : 'Sign in'));
  }).catch((e) => card.replaceChildren(wordmark(), h('h1', 'That link did not work'), h('p', { style: { color: '#c9bda9' } }, e.message), link(store.user ? 'Back to my workspace' : 'Back to sign-in', store.user ? '#/app/overview' : '#/login')));
}

const METHOD_LABEL = { totp: 'Authenticator app', sms: 'Text message', whatsapp: 'WhatsApp', backup: 'Backup code' };

export function mfaView(root) {
  const { parts } = current();
  if (parts[1]) { store.mfaToken = parts[1]; replace('#/mfa'); }        // the token from a provider redirect should not linger in the address bar
  const token = store.mfaToken;
  if (!token) { go('#/login'); return; }
  const card = h('div', { class: 'card-dark' }, wordmark(), h('h1', 'Two-step check'), h('p', { style: { color: '#c9bda9' } }, 'Loading…'));
  mount(root, scene(card));
  post('/api/auth/mfa/info', { mfa_token: token }).then(({ methods, to }) => draw(methods, to)).catch((e) => {
    store.mfaToken = null;
    card.replaceChildren(wordmark(), h('h1', 'Sign-in timed out'), h('p', { style: { color: '#c9bda9' } }, e.message), h('button', { class: 'btn gold block', type: 'button', onclick: () => go('#/login') }, 'Start again'));
  });

  function draw(methods, to, method = methods[0]) {
    const err = msgBox();
    const code = h('input', { name: 'code', inputmode: method === 'backup' ? 'text' : 'numeric', autocomplete: 'one-time-code', placeholder: method === 'backup' ? 'XXXX-XXXX' : '123456', required: true });
    const btn = h('button', { class: 'btn gold block', type: 'submit', 'data-busy': 'Checking…' }, 'Verify and sign in');
    const needsSend = method === 'sms' || method === 'whatsapp';
    const sent = h('div', { class: 'formok', hidden: true });
    const sendBtn = needsSend ? h('button', { class: 'btn line block', type: 'button', 'data-busy': 'Sending…', onclick: () => busy(sendBtn, async () => { await post('/api/auth/mfa/send', { mfa_token: token, method }); show(sent, `Code sent to ${to}.`, 'formok'); code.focus(); }, { onError: (e) => show(err, e.message) }) }, `Send a code to ${to || 'my phone'}`) : null;
    const form = h('form', { class: 'card-dark', novalidate: true, onsubmit: (e) => {
      e.preventDefault(); show(err, '');
      busy(btn, async () => finishLogin(await post('/api/auth/mfa/verify', { mfa_token: token, method, code: code.value })),
        { onError: (e2) => { if (e2.code === 'mfa_expired') { store.mfaToken = null; toast(e2.message, 'err'); go('#/login'); } else show(err, e2.message); } });
    } },
      wordmark(), h('h1', 'Two-step check'),
      h('p', { style: { color: '#c9bda9' } }, method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : method === 'backup' ? 'Enter one of your backup codes. Each works once.' : 'We will text or message a 6-digit code to the number on your account.'),
      err, sendBtn, sent, field(method === 'backup' ? 'Backup code' : 'Code', code), btn,
      methods.length > 1 ? h('div', { class: 'row' }, methods.filter((m) => m !== method).map((m) => h('button', { type: 'button', class: 'linkbtn', onclick: () => draw(methods, to, m) }, `Use ${METHOD_LABEL[m].toLowerCase()} instead`))) : null,
      link('Cancel', '#/login'));
    card.replaceWith(form); mount(root, scene(form)); code.focus();
  }
}
