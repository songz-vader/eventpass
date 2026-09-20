import { Router } from 'express';
import { z } from 'zod';
import { ApiError, wrap, parse } from '../lib/http.js';
import { logActivity, audit } from '../services/core.js';
import { admit, eventStats } from '../services/checkin.js';

export function checkinRoutes(ctx) {
  const r = Router();
  const db = ctx.db;
  const ownedEventId = async (req, raw) => {
    if (raw === undefined || raw === null || raw === '') return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || !await db.prepare('SELECT 1 FROM events WHERE id = ? AND user_id = ?').get(id, req.user.id)) throw new ApiError(404, 'not_found', 'Event not found.');
    return id;
  };

  r.post('/', wrap(async (req, res) => {
    const b = parse(z.object({ code: z.string().trim().min(1, 'Enter or scan a code.').max(20).transform((s) => s.toUpperCase()), event_id: z.any().optional() }), req.body);
    res.json(await admit(ctx, { userId: req.user.id, code: b.code, eventId: await ownedEventId(req, b.event_id) }));
  }));

  r.get('/stats', wrap(async (req, res) => res.json(await eventStats(ctx, req.user.id, await ownedEventId(req, req.query.event_id)))));

  r.get('/log', wrap(async (req, res) => {
    const eventId = await ownedEventId(req, req.query.event_id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = await db.prepare(`SELECT id, guest_id, guest_name, event_id, event_name, invite_type, ts, via FROM checkin_log WHERE user_id = ? ${eventId ? 'AND event_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
      .all(...(eventId ? [req.user.id, eventId, limit] : [req.user.id, limit]));
    res.json({ log: rows });
  }));

  // For a mistaken scan: puts the guest back to "pending" and removes the entry from the log.
  r.post('/undo', wrap(async (req, res) => {
    const { guest_id } = parse(z.object({ guest_id: z.coerce.number({ error: 'Choose a guest.' }).int() }), req.body);
    const g = await db.prepare('SELECT * FROM guests WHERE id = ? AND user_id = ?').get(guest_id, req.user.id);
    if (!g) throw new ApiError(404, 'not_found', 'Guest not found.');
    await db.tx(async (t) => {
      await t.run('UPDATE guests SET checked_in = 0, checked_in_at = NULL WHERE id = ? AND user_id = ?', [g.id, req.user.id]);
      await t.run('DELETE FROM checkin_log WHERE guest_id = ? AND user_id = ?', [g.id, req.user.id]);
    });
    await logActivity(ctx, req.user.id, `Check-in for "${g.name}" was undone`);
    await audit(ctx, req.user.id, 'checkin.undo', req, { guest: g.id });
    res.json({ ok: true });
  }));

  return r;
}
