import { logActivity } from './core.js';

const fmtClock = (ts) => new Date(ts + 3 * 3600_000).toISOString().slice(11, 16);   // East Africa Time, for the activity feed
const brief = (g) => ({ name: g.name, invite_type: g.invite_type, event_name: g.event_name });

// The one place a guest is admitted, used by the host's own check-in screen and by door-staff scanner links.
// The single UPDATE ... WHERE checked_in = 0 is what guarantees one admission per code, on either database, even when two doors
// scan the same code in the same instant: only one of them changes a row.
//   result: 'ok' | 'already' | 'wrong_event' | 'invalid'
export async function admit(ctx, { userId, code, eventId = null, via = null }) {
  const db = ctx.db;
  const g = await db.prepare('SELECT g.*, e.name AS event_name FROM guests g JOIN events e ON e.id = g.event_id WHERE g.code = ? AND g.user_id = ?').get(code, userId);
  if (!g) return { result: 'invalid' };
  if (eventId && g.event_id !== eventId) return { result: 'wrong_event', guest: brief(g) };
  const now = ctx.now();
  const won = await db.tx(async (t) => {
    const ok = (await t.run('UPDATE guests SET checked_in = 1, checked_in_at = ? WHERE id = ? AND user_id = ? AND checked_in = 0', [now, g.id, userId])).changes === 1;
    if (ok) await t.run('INSERT INTO checkin_log (user_id, event_id, guest_id, guest_name, event_name, code, invite_type, ts, via) VALUES (?,?,?,?,?,?,?,?,?)', [userId, g.event_id, g.id, g.name, g.event_name, g.code, g.invite_type, now, via]);
    return ok;
  });
  if (!won) return { result: 'already', guest: brief(g), checked_in_at: (await db.prepare('SELECT checked_in_at FROM guests WHERE id = ?').get(g.id))?.checked_in_at };
  await logActivity(ctx, userId, `"${g.name}" checked in at ${fmtClock(now)}${via ? ` (${via})` : ''}`);
  return { result: 'ok', guest: brief(g), checked_in_at: now };
}

export async function eventStats(ctx, userId, eventId) {
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(checked_in), 0) AS checked_in FROM guests WHERE user_id = ? ${eventId ? 'AND event_id = ?' : ''}`).get(...(eventId ? [userId, eventId] : [userId]));
  return { total: row.total, checked_in: row.checked_in, remaining: row.total - row.checked_in };
}
