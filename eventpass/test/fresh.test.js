import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { startTestServer, registerUser } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = ['users', 'events', 'guests', 'checkin_log', 'activity', 'channel_configs', 'message_log', 'scanner_links', 'sessions', 'oauth_identities', 'audit_log'];
const count = async (db, t) => (await db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c;

test('a brand new database is a blank canvas', async (t) => {
  await t.test('it is created with the full structure and not a single row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-fresh-'));
    const db = await openDb(path.join(dir, 'new.db'));
    for (const tbl of TABLES) assert.equal(await count(db, tbl), 0, `${tbl} starts empty`);
    await db.close();
  });

  await t.test('data written to it survives a restart (reopening does not wipe or re-seed)', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ep-fresh-')), 'kept.db');
    let db = await openDb(file);
    await db.prepare("INSERT INTO users (email, name, created_at) VALUES ('a@example.com', 'A', 1)").run();
    await db.close();
    db = await openDb(file);
    assert.equal(await count(db, 'users'), 1);
    for (const tbl of TABLES.filter((x) => x !== 'users')) assert.equal(await count(db, tbl), 0);
    await db.close();
  });

  await t.test('the first host, and the next people who join, each start with nothing', async () => {
    const s = await startTestServer();
    t.after(() => s.close());
    const first = await registerUser(s), second = await registerUser(s);
    for (const { c } of [first, second]) {
      assert.deepEqual((await c.get('/api/events')).body.events, []);
      assert.deepEqual((await c.get('/api/guests')).body.guests, []);
      assert.deepEqual((await c.get('/api/checkin/log')).body.log, []);
      assert.deepEqual((await c.get('/api/messaging/log')).body.rows, []);
      assert.deepEqual((await c.get('/api/scanner-links')).body.links, []);
      const o = (await c.get('/api/overview')).body;
      assert.deepEqual(o.stats, { events: 0, guests: 0, checked_in: 0, pending: 0, invites_sent: 0 });
      assert.equal(o.next_event, null); assert.deepEqual(o.activity, []);
      const ch = (await c.get('/api/messaging/channels')).body.channels;
      assert.ok(ch.every((x) => !x.configured), 'no messaging is pre-connected');
      assert.ok(ch.every((x) => Object.values(x.values).every((v) => v === '' || v === 'en' || /^[A-Z,]+$/.test(v))), 'no credentials are pre-filled');
    }
    // Then they start using it. Everything lands in the database, and stays each person's own.
    const ev = (await first.c.post('/api/events', { name: 'First Event', type: 'party' })).body.event;
    await first.c.post('/api/guests', { event_id: ev.id, name: 'Guest One', phone: '' });
    assert.equal(await count(s.db, 'events'), 1); assert.equal(await count(s.db, 'guests'), 1); assert.ok(await count(s.db, 'activity') >= 2);
    assert.deepEqual((await second.c.get('/api/events')).body.events, [], 'the second person still sees a blank canvas');
    await second.c.post('/api/events', { name: 'Second Event', type: 'party' });
    assert.equal(await count(s.db, 'events'), 2);
    assert.deepEqual((await first.c.get('/api/events')).body.events.map((e) => e.name), ['First Event']);
  });
});

test('the server reports whether it is up and can reach its database', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const r = await s.client().get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.ok(!r.text.includes('sqlite') && !r.text.includes('/'), 'reveals nothing about the machine');
  assert.equal((await s.client().get('/healthz')).headers.get('cache-control'), 'no-store');
});

test('reset-db wipes the database only when asked to, and is careful in production', async (t) => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reset-db.js'), ...args], { env: { ...process.env, NODE_ENV: 'development', ...env }, encoding: 'utf8' });
  const setup = async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ep-reset-')), 'x.db');
    const db = await openDb(file); await db.prepare("INSERT INTO users (email, name, created_at) VALUES ('a@example.com', 'A', 1)").run(); await db.close();
    return file;
  };
  await t.test('without --yes it only explains, and changes nothing', async () => {
    const file = await setup();
    const r = run([], { DATABASE_PATH: file });
    assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /--yes/);
    assert.ok(fs.existsSync(file));
  });
  await t.test('with --yes the database and its side files are removed, and the next start is blank', async () => {
    const file = await setup();
    const r = run(['--yes'], { DATABASE_PATH: file });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /blank/i);
    for (const f of [file, file + '-wal', file + '-shm']) assert.ok(!fs.existsSync(f), f);
    const db = await openDb(file); assert.equal(await count(db, 'users'), 0); await db.close();
  });
  await t.test('in production it refuses unless --force is added as well', async () => {
    const file = await setup();
    let r = run(['--yes'], { DATABASE_PATH: file, NODE_ENV: 'production', APP_URL: 'https://x.example', APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), ALLOW_NO_SMTP: 'true' });
    assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /production/i); assert.ok(fs.existsSync(file));
    r = run(['--yes', '--force'], { DATABASE_PATH: file, NODE_ENV: 'production', APP_URL: 'https://x.example', APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), ALLOW_NO_SMTP: 'true' });
    assert.equal(r.status, 0, r.stderr); assert.ok(!fs.existsSync(file));
  });
  await t.test('an in-memory or missing database is not an error', () => {
    const r = run(['--yes'], { DATABASE_PATH: path.join(os.tmpdir(), 'ep-does-not-exist', 'nope.db') });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /nothing to remove|blank/i);
  });
  void execFileSync;
});

test('backup makes a consistent copy of a live database and keeps only the newest ones', async (t) => {
  const run = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.js'), ...args], { env: { ...process.env, NODE_ENV: 'development', ...env }, encoding: 'utf8' });
  const mk = async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-bak-')); const file = path.join(dir, 'live.db'); const db = await openDb(file); await db.prepare("INSERT INTO users (email, name, created_at) VALUES ('a@example.com', 'Amina', 1)").run(); return { dir, file, db }; };

  await t.test('the copy opens and holds the same data, while the original keeps working', async () => {
    const { dir, file, db } = await mk();                                        // the "server" still has the database open
    const out = path.join(dir, 'out');
    const r = run([out], { DATABASE_PATH: file });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /eventpass-\d{4}-\d\d-\d\d-\d\d-\d\d\.db/);
    const [name] = fs.readdirSync(out);
    const copy = await openDb(path.join(out, name));
    assert.equal((await copy.prepare('SELECT name FROM users').get()).name, 'Amina'); await copy.close();
    await db.prepare("INSERT INTO users (email, name, created_at) VALUES ('b@example.com', 'B', 2)").run();
    assert.equal(await count(db, 'users'), 2); await db.close();
  });
  await t.test('older backups are pruned to the newest 14', async () => {
    const { dir, file, db } = await mk(); await db.close();
    const out = path.join(dir, 'out'); fs.mkdirSync(out);
    for (let i = 1; i <= 16; i++) fs.writeFileSync(path.join(out, `eventpass-2020-01-${String(i).padStart(2, '0')}-00-00.db`), 'x');
    fs.writeFileSync(path.join(out, 'notes-i-made.txt'), 'keep me');
    assert.equal(run([out], { DATABASE_PATH: file }).status, 0);
    const left = fs.readdirSync(out).filter((f) => /^eventpass-.*\.db$/.test(f));
    assert.equal(left.length, 14);
    assert.ok(!left.includes('eventpass-2020-01-01-00-00.db') && left.includes('eventpass-2020-01-16-00-00.db'));
    assert.ok(fs.existsSync(path.join(out, 'notes-i-made.txt')), 'files that are not backups are never touched');
  });
  await t.test('with no database it says so instead of creating an empty backup', () => {
    const r = run([], { DATABASE_PATH: path.join(os.tmpdir(), 'ep-nope', 'missing.db') });
    assert.equal(r.status, 1); assert.match(r.stderr + r.stdout, /no database/i);
  });
});
