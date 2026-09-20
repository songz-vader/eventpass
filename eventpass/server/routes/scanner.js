import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { ApiError, wrap, parse } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/tokens.js';
import { audit, logActivity } from '../services/core.js';
import { admit, eventStats } from '../services/checkin.js';

const HOUR = 3_600_000;
const MAX_LIVE_LINKS = 20;

const statusOf = (l, now) => (l.revoked_at ? 'revoked' : l.expires_at <= now ? 'expired' : 'active');
const shape = (l, now) => ({ id: l.id, label: l.label, event_id: l.event_id, event_name: l.event_name, created_at: l.created_at, expires_at: l.expires_at, revoked_at: l.revoked_at, last_used_at: l.last_used_at, scans: l.scans, status: statusOf(l, now) });
const LIST = 'SELECT l.*, e.name AS event_name FROM scanner_links l JOIN events e ON e.id = l.event_id';

// ── host side: create, list and revoke links (needs the host's login) ──
export function scannerLinkRoutes(ctx) {
  const r = Router();
  const db = ctx.db;

  r.get('/', wrap(async (req, res) => {
    res.json({ links: (await db.prepare(`${LIST} WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 100`).all(req.user.id)).map((l) => shape(l, ctx.now())) });
  }));

  r.post('/', wrap(async (req, res) => {
    const b = parse(z.object({
      event_id: z.coerce.number({ error: 'Choose an event.' }).int(),
      label: z.string().trim().min(1, 'Name this link, for example "Main gate".').max(40, 'Keep the name under 40 characters.'),
      hours: z.coerce.number().int().min(1, 'Choose at least 1 hour.').max(168, 'A link can last up to 7 days.').default(24),
    }), req.body);
    const ev = await db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(b.event_id, req.user.id);
    if (!ev) throw new ApiError(404, 'not_found', 'Event not found.');
    const now = ctx.now();
    if ((await db.prepare('SELECT COUNT(*) c FROM scanner_links WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(req.user.id, now)).c >= MAX_LIVE_LINKS) {
      throw new ApiError(400, 'limit', `You can have up to ${MAX_LIVE_LINKS} live staff links. Revoke one you no longer need.`);
    }
    const token = randomToken(32);                                    // 256 bits; only its SHA-256 is stored, so a database leak reveals no working link
    const id = await db.prepare('INSERT INTO scanner_links (user_id, event_id, label, token_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)')
      .insert(req.user.id, ev.id, b.label, sha256(token), now, now + b.hours * HOUR);
    const url = `${ctx.config.appUrl}/#/scan/${token}`;                // in the fragment: never sent to a server, never in access logs
    await logActivity(ctx, req.user.id, `Staff link "${b.label}" created for "${ev.name}"`);
    await audit(ctx, req.user.id, 'scanner_link_created', req, { link: id, event: ev.id });
    res.status(201).json({
      link: shape(await db.prepare(`${LIST} WHERE l.id = ?`).get(id), now), token, url,
      qr: await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M', color: { dark: '#1C1814', light: '#FFFFFF' } }),
    });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const l = await db.prepare(`${LIST} WHERE l.id = ? AND l.user_id = ?`).get(Number(req.params.id), req.user.id);
    if (!l) throw new ApiError(404, 'not_found', 'Link not found.');
    if (!l.revoked_at) await db.prepare('UPDATE scanner_links SET revoked_at = ? WHERE id = ?').run(ctx.now(), l.id);
    await logActivity(ctx, req.user.id, `Staff link "${l.label}" revoked`);
    await audit(ctx, req.user.id, 'scanner_link_revoked', req, { link: l.id });
    res.json({ ok: true });
  }));

  return r;
}

// ── staff side: authenticated by the link's secret alone, and able to do exactly one thing at one event ──
// Send it as `Authorization: Bearer <token>` or `X-Scanner-Token: <token>`. Cookies and query strings are deliberately not accepted.
// The same API serves a volunteer's phone browser, a hardware scanner, or your own app.
export function scanRoutes(ctx) {
  const r = Router();
  const db = ctx.db;

  r.use(wrap(async (req, res, next) => {
    const auth = String(req.headers.authorization || '');
    const token = (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : String(req.headers['x-scanner-token'] || '')).trim();
    const bad = (code, msg) => next(new ApiError(401, code, msg));
    if (!token || token.length > 200) return bad('scanner_invalid', 'This staff link is not valid. Ask the host for a new one.');
    const l = await db.prepare(`${LIST.replace('e.name AS event_name', 'e.name AS event_name, e.date AS event_date, e.time AS event_time, e.venue AS event_venue')} WHERE l.token_hash = ?`).get(sha256(token));
    if (!l) return bad('scanner_invalid', 'This staff link is not valid. Ask the host for a new one.');
    if (l.revoked_at) return bad('scanner_revoked', 'The host has turned this staff link off.');
    if (l.expires_at <= ctx.now()) return bad('scanner_expired', 'This staff link has expired. Ask the host for a new one.');
    req.scanner = l;
    next();
  }));

  r.get('/info', wrap(async (req, res) => {
    const l = req.scanner;
    res.json({ label: l.label, expires_at: l.expires_at, event: { id: l.event_id, name: l.event_name, date: l.event_date, time: l.event_time, venue: l.event_venue }, stats: await eventStats(ctx, l.user_id, l.event_id) });
  }));

  r.post('/checkin', wrap(async (req, res) => {
    const l = req.scanner;
    const b = parse(z.object({ code: z.string().trim().min(1, 'Enter or scan a code.').max(20).transform((s) => s.toUpperCase()) }), req.body);
    const out = await admit(ctx, { userId: l.user_id, code: b.code, eventId: l.event_id, via: l.label });
    if (out.result === 'ok') await db.prepare('UPDATE scanner_links SET scans = scans + 1, last_used_at = ? WHERE id = ?').run(ctx.now(), l.id);
    res.json(out);
  }));

  r.get('/recent', wrap(async (req, res) => {
    const l = req.scanner;
    res.json({ log: await db.prepare('SELECT guest_name, invite_type, ts, via FROM checkin_log WHERE user_id = ? AND event_id = ? ORDER BY id DESC LIMIT 15').all(l.user_id, l.event_id) });
  }));

  return r;
}
