#!/usr/bin/env node
// Support tool for whoever runs the server:  npm run users -- <command> [email]
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';

const [cmd, email] = process.argv.slice(2);
const cfg = loadConfig();
const db = await openDb(cfg.databaseUrl || cfg.dbPath);
const find = async () => {
  if (!email) { console.error('Give the account\'s email address.'); process.exit(1); }
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!u) { console.error(`No account for ${email}.`); process.exit(1); }
  return u;
};

const commands = {
  async list() {
    const rows = await db.prepare(`SELECT u.email, u.name, u.email_verified v, u.totp_enabled + u.sms_mfa + u.wa_mfa AS mfa, u.locked_until,
      (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id) events, (SELECT COUNT(*) FROM guests g WHERE g.user_id = u.id) guests, u.created_at FROM users u ORDER BY u.id`).all();
    console.table(rows.map((r) => ({ email: r.email, name: r.name, verified: !!r.v, '2fa': r.mfa > 0, locked: r.locked_until > Date.now(), events: r.events, guests: r.guests, joined: new Date(r.created_at).toISOString().slice(0, 10) })));
  },
  async unlock() { const u = await find(); await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(u.id); console.log(`Unlocked ${u.email}.`); },
  async verify() { const u = await find(); await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(u.id); console.log(`Marked ${u.email} as verified.`); },
  async 'disable-2fa'() {
    const u = await find();
    await db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = -1, sms_mfa = 0, wa_mfa = 0 WHERE id = ?').run(u.id);
    await db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(u.id);
    console.log(`Turned off two-factor for ${u.email}. Only do this after confirming the person's identity.`);
  },
  async 'sign-out'() { const u = await find(); const n = (await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id)).changes; console.log(`Ended ${n} session(s) for ${u.email}.`); },
};

if (!commands[cmd]) {
  console.log('Usage: npm run users -- <command> [email]\n\n  list                 all accounts\n  unlock <email>       clear a sign-in lockout\n  verify <email>       mark the email address as verified\n  disable-2fa <email>  remove two-factor (locked-out host, identity confirmed)\n  sign-out <email>     end every session for the account');
  process.exit(cmd ? 1 : 0);
}
try { await commands[cmd](); } finally { await db.close(); }
