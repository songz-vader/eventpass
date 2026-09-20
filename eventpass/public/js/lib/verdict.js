import { h, mount } from './dom.js';
import { clock } from './format.js';
import { beep } from './camera.js';

const admit = (type) => (type === 'double' ? 'Admit 2 people' : 'Admit 1 person');

// The big coloured answer at the door. The colour, the words and a tone/buzz all say the same thing, so it can be read at a glance.
export function renderVerdict(el, r, { sound = true } = {}) {
  const say = (state, mark, title, sub, type, tone) => {
    el.dataset.state = state;
    mount(el, h('div', { class: 'mark', 'aria-hidden': 'true' }, mark), h('div', { class: 'big' }, title), sub ? h('div', sub) : null, type ? h('div', { class: 'admit' }, admit(type)) : null);
    if (sound) beep(tone);
  };
  if (r.result === 'ok') say('ok', '\u2713', r.guest.name, `Welcome to ${r.guest.event_name}`, r.guest.invite_type, 'ok');
  else if (r.result === 'already') say('already', '!', r.guest.name, `Already checked in at ${clock(r.checked_in_at)}`, r.guest.invite_type, 'warn');
  else if (r.result === 'wrong_event') say('wrong_event', '\u2192', r.guest.name, `This pass is for ${r.guest.event_name}. Not admitted here.`, null, 'warn');
  else say('invalid', '\u2715', 'Code not found', 'Check the code and try again.', null, 'bad');
}
export const idleVerdict = () => h('div', { class: 'verdict', 'data-state': 'idle', role: 'status' }, h('div', { class: 'mark', 'aria-hidden': 'true' }, '\u25CB'), h('div', 'Type or scan a code'));
export function errorVerdict(el, message) {
  el.dataset.state = 'invalid';
  mount(el, h('div', { class: 'mark', 'aria-hidden': 'true' }, '\u2715'), h('div', { class: 'big' }, 'Could not check in'), h('div', message));
  beep('bad');
}
