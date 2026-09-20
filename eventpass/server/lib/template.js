import { mapLink, locationText } from './locations.js';

export const TEMPLATE_VARS = ['NAME', 'EVENT', 'CODE', 'TYPE', 'DATE', 'TIME', 'VENUE', 'LOCATION', 'MAP', 'LINK'];

export const DEFAULT_TEMPLATES = {
  sms: {
    en: 'Dear {NAME},\n\nYou are invited to {EVENT}.\nEntry code: {CODE} ({TYPE})\n{DATE}, {TIME}\n{LOCATION}\nMap: {MAP}\n\nShow this code at the entrance.\n- EventPass',
    sw: 'Habari {NAME},\n\nUmealikwa kwenye {EVENT}.\nNamba yako ya kuingia: {CODE}\nTarehe: {DATE}, saa {TIME}\nMahali: {LOCATION}\nRamani: {MAP}\n\nOnyesha namba hii mlangoni.\n- EventPass',
  },
  whatsapp: {
    en: "Hello {NAME}! 🎉\n\nYou're on the guest list for *{EVENT}*.\n\n🎟 Entry code: *{CODE}* ({TYPE})\n📅 {DATE}, {TIME}\n📍 {LOCATION}\n🗺 {MAP}\n\nYour invitation: {LINK}",
    sw: 'Habari {NAME}! 🎉\n\nUmealikwa kwenye *{EVENT}*.\n\n🎟 Namba ya kuingia: *{CODE}*\n📅 {DATE}, saa {TIME}\n📍 {LOCATION}\n🗺 {MAP}\n\nKadi yako ya mwaliko: {LINK}',
  },
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmtDate(d) {
  if (!d) return 'TBD';
  const dt = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return d;
  return `${DAYS[dt.getUTCDay()]}, ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

export function fmtTime(t) {
  if (!t) return 'TBD';
  const [h, m] = t.split(':');
  const hr = parseInt(h, 10);
  if (Number.isNaN(hr)) return t;
  return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

export function buildMessageVars(guest, ev, appUrl = '') {
  return {
    NAME: guest.name,
    EVENT: ev?.name || 'the event',
    CODE: guest.code,
    TYPE: guest.invite_type === 'double' ? 'Double Entry (Guest + 1)' : 'Single Entry',
    DATE: fmtDate(ev?.date),
    TIME: fmtTime(ev?.time),
    VENUE: ev?.venue || 'TBD',
    LOCATION: locationText(ev) || 'TBD',
    MAP: mapLink(ev || {}),
    LINK: appUrl ? `${appUrl.replace(/\/$/, '')}/i/${guest.code}` : '',
  };
}

// Function replacer on purpose: a guest named "A$&B" must not be interpreted as a regex replacement pattern.
export function renderTemplate(tmpl, vars) {
  return String(tmpl).replace(/\{([A-Z]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

const GSM_BASIC = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà']);
const GSM_EXT = new Set([...'^{}\\[~]|€\f']);

// Cost estimate: GSM-7 = 160 chars/segment (153 when concatenated); anything else (emoji, curly quotes) = Unicode, 70/67.
export function smsSegments(text) {
  let gsm = true, septets = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXT.has(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { length: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153), encoding: 'GSM-7' };
  const units = text.length; // UTF-16 code units, as UCS-2 SMS counts them
  return { length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67), encoding: 'UCS-2' };
}
