// SMS via Africa's Talking. Sandbox accounts (username "sandbox") MUST use the sandbox host — the old front-end
// posted sandbox credentials to the live host, which can never succeed.
const LIVE = 'https://api.africastalking.com/version1/messaging';
const SANDBOX = 'https://api.sandbox.africastalking.com/version1/messaging';

export const definition = {
  id: 'sms',
  label: 'SMS',
  provider: "Africa's Talking",
  icon: '📱',
  accent: 'blue',
  fields: [
    { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'your_username or sandbox', maxLength: 60 },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, placeholder: '••••••••••••••••', maxLength: 200 },
    { key: 'sender', label: 'Sender ID (optional)', type: 'text', placeholder: 'EventPass', maxLength: 11 },
  ],
  help: [
    "Create an API key in your Africa's Talking dashboard under Settings → API Key.",
    'Use the username "sandbox" to test without spending credits. Sandbox messages appear in their simulator, not on real phones.',
    'A custom Sender ID usually has to be registered and approved before it works on Tanzanian networks. Leave it blank to use the default.',
  ],
  isConfigured: (c) => !!(c.username && c.apiKey),
  supportsTemplates: false,
};

const FRIENDLY = {
  InvalidSenderId: 'That Sender ID has not been approved for your account.',
  InsufficientBalance: "Your Africa's Talking balance is too low to send this message.",
  InvalidPhoneNumber: 'The provider says this phone number is invalid.',
  UserInBlacklist: 'This number has opted out of messages.',
  RiskHold: 'The provider is holding this message for a risk review.',
  UnsupportedNumberType: 'This number type cannot receive SMS.',
};

export const friendlyError = (reason) => FRIENDLY[reason] || `SMS not delivered: ${reason || 'unknown reason'}`;

export async function sendSms({ fetch, timeoutMs = 15000, username, apiKey, sender, to, text }) {
  const body = new URLSearchParams({ username, to, message: text });
  if (sender) body.set('from', sender);
  try {
    const res = await fetch(username === 'sandbox' ? SANDBOX : LIVE, {
      method: 'POST',
      headers: { apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, error: "Africa's Talking rejected the username or API key." };
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    const rec = data?.SMSMessageData?.Recipients?.[0];
    if (rec && [100, 101, 102].includes(rec.statusCode)) return { ok: true, ref: rec.messageId || null, cost: rec.cost || null };
    const status = rec?.status || data?.SMSMessageData?.Message || `HTTP ${res.status}`;
    return { ok: false, error: FRIENDLY[status] || `SMS not sent: ${status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? "Africa's Talking did not respond in time." : "Could not reach Africa's Talking." };
  }
}
