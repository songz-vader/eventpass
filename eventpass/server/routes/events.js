import { Router } from 'express';
import { z } from 'zod';
import { ApiError, wrap, parse } from '../lib/http.js';
import { REGIONS, mapLink, validCoords } from '../lib/locations.js';
import { logActivity } from '../services/core.js';

const opt = (max) => z.string().trim().max(max, `Keep this under ${max} characters.`).optional().nullable();
const TYPES = ['wedding', 'birthday', 'corporate', 'conference', 'gala', 'party', 'other'];
const eventSchema = z.object({
  name: z.string().trim().min(1, 'Enter an event name.').max(120, 'Keep the name under 120 characters.'),
  type: z.enum(TYPES, 'Choose an event type.'),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a valid date.').or(z.literal('')).optional().nullable(),
  time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pick a valid time.').or(z.literal('')).optional().nullable(),
  venue: opt(160), district: opt(80), address: opt(200), dress: opt(80), note: opt(500),
  region: z.string().trim().refine((v) => v === '' || REGIONS.includes(v), 'Choose a region from the list.').optional().nullable(),
  lat: z.union([z.number(), z.string()]).optional().nullable(),
  lng: z.union([z.number(), z.string()]).optional().nullable(),
});

function normalizeCoords(b) {
  const has = (v) => v !== undefined && v !== null && v !== '';
  if (!has(b.lat) && !has(b.lng)) return { lat: null, lng: null };
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!has(b.lat) || !has(b.lng) || !validCoords(lat, lng)) throw new ApiError(400, 'validation', 'Enter both latitude and longitude as valid numbers.', { fields: { lat: 'Invalid coordinates.' } });
  return { lat, lng };
}

export const shapeEvent = (e) => e && ({ ...e, map_url: mapLink(e) });

export function eventRoutes(ctx) {
  const r = Router();
  const own = async (req, id) => {
    const ev = await ctx.db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(Number(id), req.user.id); // scoped to the caller: no way to read someone else's event by guessing an id
    if (!ev) throw new ApiError(404, 'not_found', 'Event not found.');
    return ev;
  };

  r.get('/', wrap(async (req, res) => {
    const rows = await ctx.db.prepare(`SELECT e.*,
        (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guest_count,
        (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id AND g.checked_in = 1) AS checked_in_count
      FROM events e WHERE e.user_id = ? ORDER BY (e.date IS NULL OR e.date = ''), e.date, e.id`).all(req.user.id);
    res.json({ events: rows.map(shapeEvent) });
  }));

  r.post('/', wrap(async (req, res) => {
    const b = parse(eventSchema, { type: 'other', ...req.body });
    const { lat, lng } = normalizeCoords(b);
    if ((await ctx.db.prepare('SELECT COUNT(*) c FROM events WHERE user_id = ?').get(req.user.id)).c >= ctx.config.limits.maxEvents) throw new ApiError(400, 'limit', `You can have up to ${ctx.config.limits.maxEvents} events.`);
    const id = await ctx.db.prepare(`INSERT INTO events (user_id, name, type, date, time, venue, region, district, address, lat, lng, dress, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .insert(req.user.id, b.name, b.type, b.date || '', b.time || '', b.venue || '', b.region || '', b.district || '', b.address || '', lat, lng, b.dress || '', b.note || '', ctx.now());
    await logActivity(ctx, req.user.id, `Event "${b.name}" created`);
    res.status(201).json({ event: shapeEvent(await own(req, id)) });
  }));

  r.patch('/:id', wrap(async (req, res) => {
    const cur = await own(req, req.params.id);
    const b = parse(eventSchema.partial(), req.body);
    const merged = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    const { lat, lng } = ('lat' in b || 'lng' in b) ? normalizeCoords(merged) : { lat: cur.lat, lng: cur.lng };
    await ctx.db.prepare(`UPDATE events SET name=?, type=?, date=?, time=?, venue=?, region=?, district=?, address=?, lat=?, lng=?, dress=?, note=? WHERE id=? AND user_id=?`)
      .run(merged.name, merged.type, merged.date || '', merged.time || '', merged.venue || '', merged.region || '', merged.district || '', merged.address || '', lat, lng, merged.dress || '', merged.note || '', cur.id, req.user.id);
    res.json({ event: shapeEvent(await own(req, cur.id)) });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const ev = await own(req, req.params.id);
    await ctx.db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(ev.id, req.user.id);
    await logActivity(ctx, req.user.id, `Event "${ev.name}" deleted`);
    res.json({ ok: true });
  }));
  return r;
}
