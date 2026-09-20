// WhatsApp via Meta's Cloud API.
// Business-initiated messages (an invite to someone who has not messaged you in the last 24h) MUST use a pre-approved
// template. Plain-text sends only work inside a 24h customer-service window, so text mode is a fallback, not the default.
export const definition = {
  id: 'whatsapp',
  label: 'WhatsApp',
  provider: 'Meta Cloud API',
  icon: '💬',
  accent: 'wa',
  fields: [
    { key: 'phoneId', label: 'Phone number ID', type: 'text', required: true, placeholder: '1234567890', maxLength: 40 },
    { key: 'token', label: 'Access token', type: 'password', secret: true, required: true, placeholder: 'EAAB…', maxLength: 1000 },
    { key: 'templateName', label: 'Approved template name', type: 'text', placeholder: 'invite_code', maxLength: 80 },
    { key: 'templateLang', label: 'Template language', type: 'text', placeholder: 'en', maxLength: 10, default: 'en' },
    { key: 'templateParams', label: 'Template variables, in order', type: 'text', placeholder: 'NAME,EVENT,CODE,DATE,LOCATION', maxLength: 120, default: 'NAME,EVENT,CODE,DATE,LOCATION' },
  ],
  help: [
    'Needs a WhatsApp Business Account on Meta\'s Cloud API. Copy the Phone number ID and a permanent access token from your Meta app.',
    'Create a message template in WhatsApp Manager, wait for approval, then enter its name here. The variables you list fill {{1}}, {{2}}… in order.',
    'Without a template, messages are sent as plain text. WhatsApp only delivers those to guests who messaged your number in the last 24 hours.',
    'Every guest also has a "Open in WhatsApp" link that needs no setup at all.',
  ],
  isConfigured: (c) => !!(c.phoneId && c.token),
  supportsTemplates: true,
};

const ERRORS = {
  190: 'The WhatsApp access token is invalid or expired. Generate a new one in Meta.',
  100: 'WhatsApp rejected the request. Check the Phone number ID.',
  131030: 'This number is not on your test recipient list (test numbers only reach approved recipients).',
  131047: 'Outside the 24-hour window. Use an approved template to message this guest.',
  131026: 'The message could not be delivered. The guest may not use WhatsApp.',
  132001: 'That template name does not exist (or is not approved in this language).',
  132000: 'The number of template variables does not match the template.',
  132012: 'A template variable has the wrong format.',
  133010: 'This WhatsApp number is not registered yet.',
};

export const friendlyError = (code, title) => ERRORS[code] || `WhatsApp: ${title || 'delivery failed'}`;

export const cleanParam = (v) => (String(v ?? '').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-');
const digits = (p) => String(p).replace(/\D/g, '');

async function post({ fetch, timeoutMs = 15000, graphVersion, phoneId, token, payload }) {
  try {
    const res = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    const id = data?.messages?.[0]?.id;
    if (id) return { ok: true, ref: id };
    const code = data?.error?.code;
    return { ok: false, error: ERRORS[code] || `WhatsApp error: ${data?.error?.message || 'HTTP ' + res.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'WhatsApp did not respond in time.' : 'Could not reach WhatsApp.' };
  }
}

export function sendWhatsApp({ fetch, timeoutMs, graphVersion, phoneId, token, to, text, template }) {
  const payload = template?.name
    ? {
        messaging_product: 'whatsapp', to: digits(to), type: 'template',
        template: {
          name: template.name, language: { code: template.lang || 'en' },
          components: template.params?.length ? [{ type: 'body', parameters: template.params.map((t) => ({ type: 'text', text: cleanParam(t) })) }] : [],
        },
      }
    : { messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text, preview_url: true } };
  return post({ fetch, timeoutMs, graphVersion, phoneId, token, payload });
}

// Login / verification codes use an approved AUTHENTICATION template (body = the code, plus the copy-code button).
export function sendWhatsAppOtp({ fetch, timeoutMs, graphVersion, phoneId, token, to, code, templateName, lang }) {
  const payload = {
    messaging_product: 'whatsapp', to: digits(to), type: 'template',
    template: {
      name: templateName, language: { code: lang || 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };
  return post({ fetch, timeoutMs, graphVersion, phoneId, token, payload });
}
