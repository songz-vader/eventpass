
const MIGRATIONS = [
`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  phone_operator TEXT,
  totp_secret_enc TEXT,
  totp_pending_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT -1,
  sms_mfa INTEGER NOT NULL DEFAULT 0,
  wa_mfa INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX users_phone_verified ON users(phone) WHERE phone_verified = 1;

CREATE TABLE oauth_identities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, subject)
);
CREATE INDEX oauth_user ON oauth_identities(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT, method TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE mfa_pending (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT, ua TEXT
);

CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  channel TEXT NOT NULL,
  destination TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX otp_lookup ON otp_codes(user_id, purpose, ref);

CREATE TABLE backup_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER
);
CREATE INDEX backup_user ON backup_codes(user_id);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  link_user_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  date TEXT, time TEXT, venue TEXT,
  region TEXT, district TEXT, address TEXT,
  lat REAL, lng REAL,
  dress TEXT, note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_user ON events(user_id);

CREATE TABLE guests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  operator TEXT,
  invite_type TEXT NOT NULL DEFAULT 'single',
  code TEXT NOT NULL UNIQUE,
  checked_in INTEGER NOT NULL DEFAULT 0,
  checked_in_at INTEGER,
  sms_sent INTEGER NOT NULL DEFAULT 0,
  wa_sent INTEGER NOT NULL DEFAULT 0,
  code_viewed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX guests_user ON guests(user_id);
CREATE INDEX guests_event ON guests(event_id);

CREATE TABLE checkin_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER,
  guest_id INTEGER,
  guest_name TEXT NOT NULL,
  event_name TEXT,
  code TEXT NOT NULL,
  invite_type TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX checkin_user ON checkin_log(user_id, ts);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  msg TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX activity_user ON activity(user_id, ts);

CREATE TABLE channel_configs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  config_enc TEXT NOT NULL,
  template TEXT,
  auto_send INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, channel)
);

CREATE TABLE message_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  guest_name TEXT,
  channel TEXT NOT NULL,
  to_phone TEXT,
  status TEXT NOT NULL,
  provider_ref TEXT,
  error TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX msglog_user ON message_log(user_id, ts);
CREATE INDEX msglog_ref ON message_log(provider_ref);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  ip TEXT, ua TEXT, meta TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX audit_user ON audit_log(user_id, ts);
`,
`
-- Door staff: a revocable, expiring link lets a volunteer's phone (or a hardware scanner) check guests in for ONE event, without a host login.
ALTER TABLE checkin_log ADD COLUMN via TEXT;

CREATE TABLE scanner_links (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  scans INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX scanner_user ON scanner_links(user_id);
CREATE INDEX scanner_event ON scanner_links(event_id);
`
];

// ── the database layer ──────────────────────────────────────────────────────────────────────────────────────────
// One small async interface over two engines, chosen by the address you give it:
//   postgres://…   → PostgreSQL (Neon, Render, Supabase, your own): what a hosted site should use
//   a file path    → SQLite: zero setup for developing and trying it out on your own computer
// Every query is written once, in plain SQL with ? placeholders, and runs on both.
//   db.get(sql, [params])     one row or undefined        db.all(sql, [params])   an array of rows
//   db.run(sql, [params])     → { changes }               db.insert(sql, [params]) → the new row's id
//   db.exec(sql)              several statements          db.tx(async (t) => …)   all-or-nothing; t has the same methods
//   db.prepare(sql).get/all/run(...params)                the same calls in a familiar shape
// Timestamps are stored as integer milliseconds and flags as 0/1, which both engines treat the same way.

const MIGRATION_LOCK = 727274;

// The schema above is written for SQLite. This turns it into the PostgreSQL equivalent.
export const toPostgres = (sql) => sql
  .replace(/\bINTEGER PRIMARY KEY\b/g, 'BIGSERIAL PRIMARY KEY')
  .replace(/\bINTEGER\b/g, 'BIGINT')
  .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
  .replace(/ COLLATE NOCASE/g, '');

// ? → $1, $2 … (skipping anything inside a quoted string)
export function numberPlaceholders(sql) {
  let n = 0, out = '', quoted = false;
  for (const c of sql) {
    if (c === "'") quoted = !quoted;
    out += c === '?' && !quoted ? '$' + (++n) : c;
  }
  return out;
}

export const isUniqueViolation = (e) => e?.code === '23505' || /UNIQUE constraint failed/i.test(e?.message || '');
export const isPostgresUrl = (s) => /^postgres(ql)?:\/\//i.test(String(s || ''));

function withPrepare(api) {
  api.prepare = (sql) => ({ get: (...p) => api.get(sql, p), all: (...p) => api.all(sql, p), run: (...p) => api.run(sql, p), insert: (...p) => api.insert(sql, p) });
  return api;
}

async function migrate(db, run, { sqlite }) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)'.replace('INTEGER', sqlite ? 'INTEGER' : 'BIGINT'));
  await db.tx(async (t) => {
    if (!sqlite) await t.exec(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);     // two servers starting together must not both migrate
    let v = (await t.get('SELECT v FROM schema_version'))?.v;
    if (v === undefined) { await t.run('INSERT INTO schema_version (v) VALUES (0)'); v = 0; }
    while (v < MIGRATIONS.length) { await t.exec(sqlite ? MIGRATIONS[v] : toPostgres(MIGRATIONS[v])); v += 1; await t.run('UPDATE schema_version SET v = ?', [v]); }
  });
}

async function openSqlite(file) {
  const { default: Database } = await import('better-sqlite3');
  const fs = await import('node:fs'), path = await import('node:path');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL'); raw.pragma('foreign_keys = ON'); raw.pragma('busy_timeout = 5000');
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { if (cache.size > 400) cache.clear(); s = raw.prepare(sql); cache.set(sql, s); } return s; };
  // These calls finish before returning to the event loop, so a transaction body that only awaits them cannot be interleaved with another request.
  const api = withPrepare({
    kind: 'sqlite', raw,
    async get(sql, p = []) { return stmt(sql).get(...p); },
    async all(sql, p = []) { return stmt(sql).all(...p); },
    async run(sql, p = []) { return { changes: stmt(sql).run(...p).changes }; },
    async insert(sql, p = []) { return Number(stmt(sql).run(...p).lastInsertRowid); },
    async exec(sql) { raw.exec(sql); },
    async tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = await fn(api); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    async close() { raw.close(); },
  });
  await migrate(api, null, { sqlite: true });
  return api;
}

async function openPostgres(url, { schema = null, dropSchemaOnClose = false } = {}) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v));       // BIGINT and COUNT(*) arrive as text by default
  pg.types.setTypeParser(1700, (v) => Number(v));     // NUMERIC, e.g. SUM()
  const base = { connectionString: url, max: Number(process.env.DATABASE_POOL_MAX || 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 };
  if (process.env.DATABASE_SSL === 'false') base.ssl = false;
  if (schema) {                                        // tests: each server gets its own private schema in one shared database
    const boot = new pg.Client(base); await boot.connect(); await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); await boot.end();
    base.options = `-c search_path=${schema}`;
  }
  const pool = new pg.Pool(base);
  pool.on('error', (e) => console.error('[db] an idle connection was dropped:', e.message));   // serverless Postgres closes idle connections: not fatal
  const bind = (q) => withPrepare({
    kind: 'postgres',
    async all(sql, p = []) { return (await q.query(numberPlaceholders(sql), p)).rows; },
    async get(sql, p = []) { return (await q.query(numberPlaceholders(sql), p)).rows[0]; },
    async run(sql, p = []) { return { changes: (await q.query(numberPlaceholders(sql), p)).rowCount }; },
    async insert(sql, p = []) { return Number((await q.query(numberPlaceholders(sql) + ' RETURNING id', p)).rows[0].id); },
    async exec(sql) { await q.query(sql); },
  });
  const api = bind(pool);
  api.pool = pool;
  api.tx = async (fn) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const r = await fn(bind(client)); await client.query('COMMIT'); return r; }
    catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; }
    finally { client.release(); }
  };
  api.close = async () => { await pool.end(); if (schema && dropSchemaOnClose) { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await c.end(); } };
  try { await migrate(api, null, { sqlite: false }); } catch (e) { await pool.end().catch(() => {}); throw e; }
  return api;
}

export async function openDb(target, opts = {}) {
  return isPostgresUrl(target) ? openPostgres(target, opts) : openSqlite(target);
}
