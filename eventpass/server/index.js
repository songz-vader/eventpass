// Read settings from a .env file next to where the server is started (Node 22 can do this itself). Real environment variables win.
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createMailer } from './mailer.js';
import { createApp } from './app.js';
import { purgeExpired } from './maintenance.js';
import { platformCaps } from './messaging/index.js';
import { providerList } from './services/oauth.js';

const config = loadConfig();
const db = await openDb(config.databaseUrl || config.dbPath);
const mailer = createMailer(config);
const { app, ctx } = createApp({ config, db, mailer });

const server = app.listen(config.port, () => {
  const caps = platformCaps(ctx);
  const on = (b) => (b ? 'on' : 'off');
  console.log(`\nEventPass ${config.env} → ${config.appUrl}  (port ${config.port})`);
  console.log(`  database:         ${db.kind === 'postgres' ? 'PostgreSQL' : `SQLite file (${config.dbPath})`}`);
  console.log(`  email:            ${on(mailer.enabled)}${mailer.enabled ? '' : '   (links are printed here instead)'}`);
  console.log(`  account SMS:      ${on(caps.live.sms)}${caps.live.sms ? '' : config.devOtpEcho ? '   (codes are printed here instead)' : ''}`);
  console.log(`  account WhatsApp: ${on(caps.live.whatsapp)}`);
  console.log(`  sign in with:     ${providerList(ctx).filter((p) => p.enabled).map((p) => p.label).join(', ') || 'none configured'}`);
  console.log(`  webhooks:         whatsapp ${on(config.whatsapp.appSecret && config.whatsapp.verifyToken)}, africa's talking ${on(config.atWebhookSecret)}\n`);
  if (db.kind === 'sqlite' && config.isProd) console.warn('  ! Using a SQLite file in production. Make sure it is on a disk that survives restarts, or set DATABASE_URL to use PostgreSQL.\n');
  if (!config.encryptionKey) console.warn('  ! APP_ENCRYPTION_KEY is not set: hosts\' SMS/WhatsApp credentials cannot be saved. Run: npm run keygen\n');
});

await purgeExpired(ctx);
const sweep = setInterval(async () => { try { await purgeExpired(ctx); } catch (e) { console.error('[maintenance]', e.message); } }, 60 * 60_000);
sweep.unref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  clearInterval(sweep);
  server.close(async () => { try { await db.close(); } finally { process.exit(0); } });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
