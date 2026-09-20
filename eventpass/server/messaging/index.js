import * as at from './africastalking.js';
import * as wa from './whatsapp.js';
import { buildMessageVars, renderTemplate, DEFAULT_TEMPLATES } from '../lib/template.js';

// The channel registry drives BOTH the API and the front end: /api/messaging/channels serialises these definitions and
// the Messaging tab renders one sub-tab + form per entry. Add a channel here and it appears in the UI with no front-end change.
const CHANNELS = {
  sms: {
    ...at.definition,
    send: (ctx, cfg, { to, text }) => at.sendSms({ fetch: ctx.fetch, timeoutMs: ctx.config.fetchTimeoutMs, username: cfg.username, apiKey: cfg.apiKey, sender: cfg.sender, to, text }),
    flag: 'sms_sent',
  },
  whatsapp: {
    ...wa.definition,
    send: (ctx, cfg, { to, text, vars }) => {
      let template = null;
      if (cfg.templateName) {
        const names = String(cfg.templateParams || 'NAME,EVENT,CODE,DATE,LOCATION').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        template = { name: cfg.templateName, lang: cfg.templateLang || 'en', params: names.map((n) => vars?.[n] ?? '') };
      }
      return wa.sendWhatsApp({ fetch: ctx.fetch, timeoutMs: ctx.config.fetchTimeoutMs, graphVersion: ctx.config.whatsapp.graphVersion, phoneId: cfg.phoneId, token: cfg.token, to, text, template });
    },
    flag: 'wa_sent',
  },
};

export const channelIds = () => Object.keys(CHANNELS);
export const getChannel = (id) => CHANNELS[id] || null;

export function channelSchema() {
  return Object.values(CHANNELS).map(({ id, label, provider, icon, accent, fields, help, supportsTemplates }) => ({ id, label, provider, icon, accent, fields, help, supportsTemplates }));
}

export async function loadChannelConfig(ctx, userId, channelId) {
  const ch = CHANNELS[channelId];
  const row = await ctx.db.prepare('SELECT * FROM channel_configs WHERE user_id = ? AND channel = ?').get(userId, channelId);
  let config = {};
  if (row) { try { config = JSON.parse(ctx.vault.decrypt(row.config_enc)); } catch { config = {}; } }
  return { config, template: row?.template || '', autoSend: row ? !!row.auto_send : true, configured: !!ch?.isConfigured(config), updatedAt: row?.updated_at || null };
}

export async function saveChannelConfig(ctx, userId, channelId, { values = {}, template, autoSend }) {
  const ch = CHANNELS[channelId];
  const existing = await loadChannelConfig(ctx, userId, channelId);
  const next = { ...existing.config };
  for (const f of ch.fields) {
    if (!(f.key in values)) continue;
    const v = String(values[f.key] ?? '').trim().slice(0, f.maxLength || 300);
    if (f.secret && v === '') continue;         // blank secret field = keep what is stored
    next[f.key] = v;
  }
  const tmpl = template !== undefined ? String(template).slice(0, 1000) : existing.template;
  const auto = autoSend !== undefined ? (autoSend ? 1 : 0) : (existing.autoSend ? 1 : 0);
  await ctx.db.prepare(`INSERT INTO channel_configs (user_id, channel, config_enc, template, auto_send, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, channel) DO UPDATE SET config_enc = excluded.config_enc, template = excluded.template, auto_send = excluded.auto_send, updated_at = excluded.updated_at`)
    .run(userId, channelId, ctx.vault.encrypt(JSON.stringify(next)), tmpl, auto, ctx.now());
}

// What the browser is allowed to see: secrets are reduced to "•••• last4" and are never sent back in full.
export async function describeChannel(ctx, userId, channelId) {
  const ch = CHANNELS[channelId];
  const { config, template, autoSend, configured } = await loadChannelConfig(ctx, userId, channelId);
  const values = {};
  for (const f of ch.fields) {
    const v = config[f.key] ?? f.default ?? '';
    values[f.key] = f.secret ? (v ? '••••' + String(v).slice(-4) : '') : v;
  }
  return { id: channelId, configured, autoSend, template: template || DEFAULT_TEMPLATES[channelId]?.en || DEFAULT_TEMPLATES.sms.en, values, hasSecret: Object.fromEntries(ch.fields.filter((f) => f.secret).map((f) => [f.key, !!config[f.key]])) };
}

async function logMessage(ctx, { userId, guest, channel, to, result }) {
  await ctx.db.prepare('INSERT INTO message_log (user_id, guest_id, guest_name, channel, to_phone, status, provider_ref, error, ts) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(userId, guest?.id ?? null, guest?.name ?? null, channel, to, result.ok ? 'sent' : 'failed', result.ref || null, result.ok ? null : String(result.error || '').slice(0, 300), ctx.now());
}

export async function sendGuestMessage(ctx, userId, guest, ev, channelId) {
  const ch = CHANNELS[channelId];
  if (!ch) return { ok: false, error: 'Unknown channel.' };
  const { config, template, configured } = await loadChannelConfig(ctx, userId, channelId);
  if (!configured) return { ok: false, code: 'not_configured', error: `${ch.label} is not set up yet. Add your ${ch.provider} details in the Messaging tab.` };
  if (!guest.phone) return { ok: false, code: 'no_phone', error: 'This guest has no phone number.' };
  const vars = buildMessageVars(guest, ev, ctx.config.appUrl);
  const text = renderTemplate(template || DEFAULT_TEMPLATES[channelId]?.en || DEFAULT_TEMPLATES.sms.en, vars);
  const result = await ch.send(ctx, config, { to: guest.phone, text, vars });
  await logMessage(ctx, { userId, guest, channel: channelId, to: guest.phone, result });
  if (result.ok) await ctx.db.prepare(`UPDATE guests SET ${ch.flag} = 1 WHERE id = ? AND user_id = ?`).run(guest.id, userId);
  return result;
}

export async function sendTestMessage(ctx, userId, channelId, to) {
  const ch = CHANNELS[channelId];
  const { config, template, configured } = await loadChannelConfig(ctx, userId, channelId);
  if (!configured) return { ok: false, code: 'not_configured', error: 'Save your credentials first.' };
  const guest = { name: 'Test Guest', code: 'TESTCODE', invite_type: 'single' };
  const ev = { name: 'Test Event', venue: 'Test Venue', region: 'Dar es Salaam' };
  const vars = buildMessageVars(guest, ev, ctx.config.appUrl);
  const text = renderTemplate(template || DEFAULT_TEMPLATES[channelId]?.en, vars);
  const result = await ch.send(ctx, config, { to, text, vars });
  await logMessage(ctx, { userId, guest: null, channel: channelId, to, result });
  return result;
}

export async function messageForGuest(ctx, userId, guest, ev, channelId) {
  const { template } = await loadChannelConfig(ctx, userId, channelId);
  const vars = buildMessageVars(guest, ev, ctx.config.appUrl);
  const text = renderTemplate(template || DEFAULT_TEMPLATES[channelId]?.en || DEFAULT_TEMPLATES.sms.en, vars);
  const waLink = guest.phone ? `https://wa.me/${guest.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}` : null;
  return { text, waLink };
}

// ── Platform messaging: account-security codes only (sent from YOUR account, not the host's) ──
export function platformCaps(ctx) {
  const p = ctx.config.platform;
  const sms = !!(p.sms.username && p.sms.apiKey);
  const whatsapp = !!(p.whatsapp.phoneId && p.whatsapp.token && p.whatsapp.otpTemplate);
  return { sms: sms || ctx.config.devOtpEcho, whatsapp: whatsapp || ctx.config.devOtpEcho, live: { sms, whatsapp } };
}

export async function sendPlatformOtp(ctx, { channel, to, code }) {
  const p = ctx.config.platform;
  if (channel === 'sms' && p.sms.username && p.sms.apiKey) {
    return at.sendSms({ fetch: ctx.fetch, timeoutMs: ctx.config.fetchTimeoutMs, username: p.sms.username, apiKey: p.sms.apiKey, sender: p.sms.sender, to,
      text: `Your EventPass code is ${code}. It expires in 10 minutes. Never share it with anyone.` });
  }
  if (channel === 'whatsapp' && p.whatsapp.phoneId && p.whatsapp.token && p.whatsapp.otpTemplate) {
    return wa.sendWhatsAppOtp({ fetch: ctx.fetch, timeoutMs: ctx.config.fetchTimeoutMs, graphVersion: ctx.config.whatsapp.graphVersion, phoneId: p.whatsapp.phoneId, token: p.whatsapp.token, to, code, templateName: p.whatsapp.otpTemplate, lang: p.whatsapp.otpLang });
  }
  if (ctx.config.devOtpEcho) {          // local development only: no provider configured, so show the code in the server log
    ctx.devOtps.push({ channel, to, code, at: ctx.now() });
    if (ctx.config.env !== 'test') console.log(`\n[dev otp] ${channel} → ${to}: ${code}\n`);
    return { ok: true, dev: true };
  }
  return { ok: false, error: 'unavailable' };
}
