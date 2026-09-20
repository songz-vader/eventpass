#!/usr/bin/env node
// Makes a safe copy of the database while the server keeps running:   npm run backup   (or:  npm run backup -- /some/folder)
// Uses SQLite's own online backup, so the copy is consistent even if someone is checking guests in at that moment.
// Keeps the newest 14 backups in the folder and never touches any other file there.
import fs from 'node:fs';
import path from 'node:path';

try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('This site uses PostgreSQL, which is backed up differently:\n  - Neon keeps a history you can restore from (Branches / Restore in its dashboard).\n  - Or make your own copy any time:  pg_dump "$DATABASE_URL" > eventpass-backup.sql');
  process.exit(1);
}

const KEEP = 14;
const file = path.resolve(process.env.DATABASE_PATH || './data/eventpass.db');
if (!fs.existsSync(file)) { console.error(`No database found at ${file}, so there is nothing to back up.`); process.exit(1); }

const dir = path.resolve(process.argv[2] || path.join(path.dirname(file), 'backups'));
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');           // 2026-09-20-14-05 (UTC)
const dest = path.join(dir, `eventpass-${stamp}.db`);

const { default: Database } = await import('better-sqlite3');
const db = new Database(file, { fileMustExist: true });
try { await db.backup(dest); } finally { db.close(); }
console.log(`Backed up to ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);

const mine = fs.readdirSync(dir).filter((f) => /^eventpass-\d{4}-\d\d-\d\d-\d\d-\d\d\.db$/.test(f)).sort();
for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) fs.rmSync(path.join(dir, old));
if (mine.length > KEEP) console.log(`Removed ${mine.length - KEEP} older backup(s); keeping the newest ${KEEP}.`);
