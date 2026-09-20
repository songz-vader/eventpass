#!/usr/bin/env node
// Deletes the database so the next start is a blank canvas:   npm run reset-db -- --yes
// Stop the server first. In production it also needs --force, because this erases every host's events, guests and settings.
import fs from 'node:fs';
import path from 'node:path';

try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

const args = new Set(process.argv.slice(2));
const url = process.env.DATABASE_URL || '';
const file = process.env.DATABASE_PATH || './data/eventpass.db';
const prod = process.env.NODE_ENV === 'production';

if (/^postgres(ql)?:\/\//i.test(url)) {
  const where = (() => { try { const u = new URL(url); return `${u.hostname}${u.pathname}`; } catch { return 'the database in DATABASE_URL'; } })();
  if (!args.has('--yes')) {
    console.error(`This permanently deletes every table and row in the PostgreSQL database at:\n  ${where}\nEvery account, event, guest and setting in it is lost.\nStop the server, then run again with --yes to confirm:  npm run reset-db -- --yes`);
    process.exit(1);
  }
  if (prod && !args.has('--force')) {
    console.error('NODE_ENV is production. Add --force as well if you really mean to erase the live database:  npm run reset-db -- --yes --force');
    process.exit(1);
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === 'false' ? false : undefined });
  await client.connect();
  try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); } finally { await client.end(); }
  console.log(`Emptied ${where}.\nThe next start creates the tables again, blank.`);
  process.exit(0);
}

if (file === ':memory:') { console.log('The database is in memory, so there is nothing to remove. The next start is blank.'); process.exit(0); }
const target = path.resolve(file);
const files = [target, target + '-wal', target + '-shm'];

if (!args.has('--yes')) {
  console.error(`This permanently deletes the database at:\n  ${target}\nEvery account, event, guest and setting in it is lost.\nStop the server, then run again with --yes to confirm:  npm run reset-db -- --yes`);
  process.exit(1);
}
if (prod && !args.has('--force')) {
  console.error('NODE_ENV is production. Add --force as well if you really mean to erase the live database:  npm run reset-db -- --yes --force');
  process.exit(1);
}

const removed = files.filter((f) => { if (!fs.existsSync(f)) return false; fs.rmSync(f); return true; });
console.log(removed.length ? `Removed ${removed.map((f) => path.basename(f)).join(', ')} from ${path.dirname(target)}.` : `Nothing to remove at ${target}.`);
console.log('The next start creates a new, blank database.');
