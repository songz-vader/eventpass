// Mobile-number connector: normalises any way a Tanzanian writes a number to E.164,
// rejects numbers SMS can't reach (landlines), and hints the operator from the TCRA prefix.
//
// Operator detection is BEST-EFFORT: Tanzania has mobile number portability, so a number can
// live on a different network than its prefix suggests. Never use it for billing/routing logic.

// Prefix table: TCRA National Numbering Plan (updated June 2020).
const TZ_OPERATORS = {
  '61': 'Halotel', '62': 'Halotel',
  '65': 'Tigo/Yas', '67': 'Tigo/Yas', '71': 'Tigo/Yas',
  '66': 'Smile',
  '68': 'Airtel', '69': 'Airtel', '78': 'Airtel',
  '73': 'TTCL',
  '74': 'Vodacom', '75': 'Vodacom', '76': 'Vodacom',
  '77': 'Zantel',
};
const TZ_MOBILE = /^\+255[67]\d{8}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Enter a phone number.' };
  let s = input.trim().replace(/\(0\)/g, '').replace(/[\s\-.()]/g, '');
  if (!s) return { ok: false, error: 'Enter a phone number.' };
  if (!/^\+?\d+$/.test(s)) return { ok: false, error: 'Phone numbers can only contain digits, spaces and a leading +.' };

  let e164;
  if (s.startsWith('+')) e164 = s;
  else if (s.startsWith('00')) e164 = '+' + s.slice(2);
  else if (s.startsWith('0')) e164 = '+255' + s.slice(1);
  else if (s.startsWith('255') && s.length === 12) e164 = '+' + s;
  else if (/^[67]\d{8}$/.test(s)) e164 = '+255' + s;
  else return { ok: false, error: 'Use a Tanzanian number like 0712 345 678, or include the country code with +.' };

  if (e164.startsWith('+255')) {
    if (!TZ_MOBILE.test(e164)) return { ok: false, error: 'That is not a Tanzanian mobile number. Mobile numbers look like 0712 345 678.' };
    return { ok: true, e164, country: 'TZ', national: '0' + e164.slice(4), operator: TZ_OPERATORS[e164.slice(4, 6)] || null };
  }
  if (!E164.test(e164)) return { ok: false, error: 'That does not look like a valid international number.' };
  return { ok: true, e164, country: 'INTL', national: e164, operator: null };
}

export function maskPhone(e164) {
  if (!e164) return '';
  if (e164.startsWith('+255') && e164.length === 13) return `+255 ${e164[4]}•• ••• ${e164.slice(-3)}`;
  return e164.slice(0, 4) + '•'.repeat(Math.max(0, e164.length - 7)) + e164.slice(-3);
}
