import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVault } from './lib/vault.js';
import { ApiError, wrap } from './lib/http.js';
import { securityHeaders, originCheck } from './middleware/security.js';
import { loadSession, requireAuth, requireCsrf } from './middleware/session.js';
import { makeLimiter } from './middleware/limits.js';
import { publicRoutes } from './routes/public.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { accountRoutes } from './routes/account.js';
import { guestRoutes } from './routes/guests.js';
import { checkinRoutes } from './routes/checkin.js';
import { messagingRoutes } from './routes/messaging.js';
import { overviewRoutes } from './routes/overview.js';
import { webhookRoutes } from './routes/webhooks.js';
import { scannerLinkRoutes, scanRoutes } from './routes/scanner.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ config, db, fetch = globalThis.fetch, mailer }) {
  const ctx = { config, db, fetch, mailer, vault: createVault(config.encryptionKey), now: () => Date.now(), devOtps: [], jwks: new Map(), discovery: new Map() };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config));
  // The raw bytes of webhook bodies are kept because Meta signs them: the signature is checked against exactly what was sent.
  app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { if (req.url.startsWith('/webhooks/')) req.rawBody = buf; } }));
  app.use('/webhooks/at', express.urlencoded({ extended: false, limit: '16kb' }));
  app.use('/api/auth/oauth', express.urlencoded({ extended: false, limit: '16kb' }));   // Apple's form_post sign-in result
  app.use(originCheck(config));
  app.use(loadSession(ctx));

  const apiLimit = makeLimiter(config, { windowMs: config.rate.apiWindowMs, limit: config.rate.apiPerIp });
  app.use('/api', apiLimit);
  app.use('/api/public', publicRoutes(ctx));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/scan', scanRoutes(ctx));                                  // door staff: token-authenticated, no cookies involved
  app.use('/webhooks', makeLimiter(config, { windowMs: 60_000, limit: 300 }), webhookRoutes(ctx));

  const priv = express.Router();
  priv.use(requireAuth, requireCsrf);
  priv.use('/account', accountRoutes(ctx));
  priv.use('/events', eventRoutes(ctx));
  priv.use('/guests', guestRoutes(ctx));
  priv.use('/checkin', checkinRoutes(ctx));
  priv.use('/scanner-links', scannerLinkRoutes(ctx));
  priv.use('/messaging', messagingRoutes(ctx));
  priv.use('/overview', overviewRoutes(ctx));
  app.use('/api', priv);
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } }));

  // For hosting platforms and uptime monitors: answers only "up, and the database responds". Reveals nothing else.
  app.get('/healthz', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  }));

  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: config.isProd ? '1h' : 0 }));
  app.get(/^\/(?!api\/|webhooks\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'That request could not be read.' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'That request is too large.' } });
    console.error(`[error] ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  });

  return { app, ctx };
}
