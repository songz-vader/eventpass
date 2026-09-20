// All configuration comes from environment variables (see .env.example). Nothing secret lives in code or in the browser.
import fs from 'node:fs';
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

// How many reverse proxies sit in front of the server. Express needs a NUMBER for a hop count: the string "1" would be read as an IP address.
function parseTrustProxy(v) {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) === 0 ? false : Number(s);
  if (s === 'false') return false;
  if (s === 'true') return true;
  return s;                                    // "loopback", or a list of proxy addresses and subnets
}

function readAppleKey(env) {
  if (env.APPLE_PRIVATE_KEY) return env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (env.APPLE_PRIVATE_KEY_PATH) {
    try { return fs.readFileSync(env.APPLE_PRIVATE_KEY_PATH, 'utf8'); }
    catch (e) { throw new Error(`APPLE_PRIVATE_KEY_PATH could not be read: ${e.message}`); }
  }
  return '';
}

// OAUTH_EXTRA='{"acme":{"label":"Acme","discovery":"https://id.acme.com/.well-known/openid-configuration","clientId":"…","clientSecret":"…"}}'
function parseExtraProviders(raw) {
  if (!raw) return {};
  let o;
  try { o = JSON.parse(raw); } catch { throw new Error('OAUTH_EXTRA must be valid JSON.'); }
  for (const [id, p] of Object.entries(o)) {
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(id) || ['google', 'microsoft', 'yahoo'].includes(id)) throw new Error(`OAUTH_EXTRA: "${id}" is not a usable provider id.`);
    if (!p || !p.label || !p.discovery || !p.clientId || !p.clientSecret) throw new Error(`OAUTH_EXTRA: "${id}" needs label, discovery, clientId and clientSecret.`);
  }
  return o;
}

export function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const port = Number(env.PORT || 3000);
  const appUrl = (env.APP_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');

  const cfg = {
    env: nodeEnv, isProd, port, appUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY ?? (isProd ? '1' : '0')),
    // DATABASE_URL (postgres://…) selects PostgreSQL, e.g. Neon. Without it, a SQLite file at DATABASE_PATH is used.
    databaseUrl: env.DATABASE_URL || '',
    dbPath: env.DATABASE_PATH || './data/eventpass.db',
    encryptionKey: env.APP_ENCRYPTION_KEY || '',
    allowRegistration: bool(env.ALLOW_REGISTRATION, true),
    session: { idleDays: Number(env.SESSION_IDLE_DAYS || 14), absoluteDays: Number(env.SESSION_MAX_DAYS || 30) },
    mail: { url: env.SMTP_URL || '', from: env.MAIL_FROM || 'EventPass <no-reply@localhost>', allowNone: bool(env.ALLOW_NO_SMTP, false) },
    // Platform-level messaging: used ONLY for account security messages (verification / login codes).
    // Hosts' guest invitations go through the hosts' own provider accounts, configured in the Messaging tab.
    platform: {
      sms: { username: env.PLATFORM_AT_USERNAME || '', apiKey: env.PLATFORM_AT_API_KEY || '', sender: env.PLATFORM_AT_SENDER || '' },
      whatsapp: { phoneId: env.PLATFORM_WA_PHONE_ID || '', token: env.PLATFORM_WA_TOKEN || '', otpTemplate: env.PLATFORM_WA_OTP_TEMPLATE || '', otpLang: env.PLATFORM_WA_OTP_LANG || 'en' },
    },
    whatsapp: {
      graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v25.0',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
    },
    atWebhookSecret: env.AT_WEBHOOK_SECRET || '',   // Africa's Talking delivery reports are unsigned, so the secret lives in the callback URL
    oauth: {
      google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
      microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '' },
      yahoo: { clientId: env.YAHOO_CLIENT_ID || '', clientSecret: env.YAHOO_CLIENT_SECRET || '' },
      // Sign in with Apple: a Services ID, your Team ID, a Key ID and the .p8 private key (paste it with \n for line breaks, or give a file path).
      apple: { clientId: env.APPLE_CLIENT_ID || '', teamId: env.APPLE_TEAM_ID || '', keyId: env.APPLE_KEY_ID || '', privateKey: readAppleKey(env) },
      extra: parseExtraProviders(env.OAUTH_EXTRA), // any other OpenID Connect provider, see .env.example
    },
    limits: { maxEvents: 100, maxGuests: 5000, maxBulk: 500, maxBroadcast: 300 },
    // Per-IP limits are generous on purpose: on Tanzanian mobile networks many phones share one public IP, and a full wedding of guests
    // opening their invitations at once must not lock each other out. Guessing is stopped by the code space (32^8) and per-account lockout.
    rate: { enabled: true, loginPerIp: 60, loginWindowMs: 15 * 60_000, apiPerIp: 600, apiWindowMs: 60_000, publicPerIp: 200, publicWindowMs: 10 * 60_000, otpSendPerIp: 20, otpWindowMs: 60 * 60_000 },
    lockout: { threshold: 8, baseMs: 15 * 60_000, maxMs: 60 * 60_000 },
    devOtpEcho: !isProd,
    fetchTimeoutMs: 15_000,
  };
  Object.assign(cfg, overrides);
  cfg.secureCookies = cfg.appUrl.startsWith('https://');
  cfg.cookieName = cfg.secureCookies ? '__Host-ep_session' : 'ep_session';

  if (isProd) {
    const problems = [];
    if (!cfg.appUrl.startsWith('https://')) problems.push('APP_URL must be an https:// URL in production (cookies are Secure-only).');
    if (!cfg.encryptionKey) problems.push('APP_ENCRYPTION_KEY is required (run: npm run keygen).');
    if (!cfg.mail.url && !cfg.mail.allowNone) problems.push('SMTP_URL is required so verification and password-reset emails can be sent (or set ALLOW_NO_SMTP=true to skip, not recommended).');
    if (problems.length) throw new Error('Invalid production configuration:\n - ' + problems.join('\n - '));
  }
  return cfg;
}
