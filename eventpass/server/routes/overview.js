import { Router } from 'express';
import { shapeEvent } from './events.js';
import { wrap } from '../lib/http.js';

export function overviewRoutes(ctx) {
  const r = Router();
  r.get('/', wrap(async (req, res) => {
    const uid = req.user.id, db = ctx.db;
    const one = async (sql, ...a) => await db.prepare(sql).get(...a);
    const guests = await one('SELECT COUNT(*) total, COALESCE(SUM(checked_in), 0) checked FROM guests WHERE user_id = ?', uid);
    const today = new Date(ctx.now() + 3 * 3600_000).toISOString().slice(0, 10);   // "today" in East Africa Time
    const next = await db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guest_count
      FROM events e WHERE e.user_id = ? AND e.date >= ? AND e.date != '' ORDER BY e.date, e.time LIMIT 1`).get(uid, today);
    res.json({
      stats: {
        events: (await one('SELECT COUNT(*) c FROM events WHERE user_id = ?', uid)).c,
        guests: guests.total, checked_in: guests.checked, pending: guests.total - guests.checked,
        invites_sent: (await one('SELECT COUNT(*) c FROM guests WHERE user_id = ? AND (sms_sent = 1 OR wa_sent = 1)', uid)).c,
      },
      next_event: next ? shapeEvent(next) : null,
      activity: await db.prepare('SELECT id, msg, ts FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(uid),
    });
  }));
  return r;
}
