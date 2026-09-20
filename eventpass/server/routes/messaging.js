import { Router } from 'express';
import { z } from 'zod';
import { ApiError, wrap, parse } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { logActivity } from '../services/core.js';
import { channelSchema, channelIds, getChannel, describeChannel, saveChannelConfig, loadChannelConfig, sendGuestMessage, sendTestMessage } from '../messaging/index.js';

export function messagingRoutes(ctx) {
  const r = Router();
  const db = ctx.db;
  const channel = (id) => {
    if (!getChannel(id)) throw new ApiError(404, 'not_found', 'Unknown channel.');
    return id;
  };

  // Each entry carries the form definition (fields, help text) AND this host's current values, so the front end
  // can draw a settings form for any channel the server knows about without being changed.
  r.get('/channels', wrap(async (req, res) => {
    res.json({ channels: await Promise.all(channelSchema().map(async (def) => ({ ...def, ...await describeChannel(ctx, req.user.id, def.id) }))) });
  }));

  r.put('/channels/:id', wrap(async (req, res) => {
    const id = channel(req.params.id);
    const b = parse(z.object({
      values: z.record(z.string(), z.any()).optional(),
      template: z.string().max(1000, 'Keep the message under 1000 characters.').optional(),
      autoSend: z.boolean().optional(),
    }), req.body);
    await saveChannelConfig(ctx, req.user.id, id, b);
    await logActivity(ctx, req.user.id, `${getChannel(id).label} settings updated`);
    res.json({ channel: { ...channelSchema().find((c) => c.id === id), ...await describeChannel(ctx, req.user.id, id) } });
  }));

  r.post('/channels/:id/test', wrap(async (req, res) => {
    const id = channel(req.params.id);
    const { to } = parse(z.object({ to: z.string().trim().min(1, 'Enter a phone number to send the test to.').max(30) }), req.body);
    if (!(await loadChannelConfig(ctx, req.user.id, id)).configured) throw new ApiError(400, 'not_configured', 'Save your credentials first, then send a test.');
    const p = normalizePhone(to);
    if (!p.ok) throw new ApiError(400, 'validation', p.error, { fields: { to: p.error } });
    const result = await sendTestMessage(ctx, req.user.id, id, p.e164);
    if (!result.ok) throw new ApiError(result.code ? 400 : 502, result.code || 'provider_error', result.error);
    res.json({ ok: true, to: p.e164 });
  }));

  // Message the guests who have not had this channel yet (or everyone, with resend). Capped per call so one request cannot run for minutes.
  r.post('/broadcast', wrap(async (req, res) => {
    const b = parse(z.object({ channel: z.string(), event_id: z.any().optional(), resend: z.boolean().optional() }), req.body);
    if (!channelIds().includes(b.channel)) throw new ApiError(400, 'validation', 'Choose SMS or WhatsApp.');
    const ch = getChannel(b.channel);
    let eventId = null;
    if (b.event_id !== undefined && b.event_id !== null && b.event_id !== '') {
      eventId = Number(b.event_id);
      if (!Number.isInteger(eventId) || !await db.prepare('SELECT 1 FROM events WHERE id = ? AND user_id = ?').get(eventId, req.user.id)) throw new ApiError(404, 'not_found', 'Event not found.');
    }
    if (!(await loadChannelConfig(ctx, req.user.id, b.channel)).configured) throw new ApiError(400, 'not_configured', `${ch.label} is not set up yet. Add your ${ch.provider} details first.`);
    const guests = await db.prepare(`SELECT * FROM guests WHERE user_id = ? ${eventId ? 'AND event_id = ?' : ''} ORDER BY id`).all(...(eventId ? [req.user.id, eventId] : [req.user.id]));
    const out = { sent: 0, failed: 0, skipped_no_phone: 0, already_sent: 0, remaining: 0, errors: [] };
    const todo = [];
    for (const g of guests) {
      if (!g.phone) out.skipped_no_phone++;
      else if (g[ch.flag] && !b.resend) out.already_sent++;
      else todo.push(g);
    }
    const batch = todo.slice(0, ctx.config.limits.maxBroadcast);
    out.remaining = todo.length - batch.length;
    const events = new Map();
    const evOf = async (id) => { if (!events.has(id)) events.set(id, await db.prepare('SELECT * FROM events WHERE id = ?').get(id)); return events.get(id); };
    for (let i = 0; i < batch.length; i += 5) {                       // five at a time: quicker than one by one, gentle on the provider
      await Promise.all(batch.slice(i, i + 5).map(async (g) => {
        const result = await sendGuestMessage(ctx, req.user.id, g, await evOf(g.event_id), b.channel);
        if (result.ok) out.sent++;
        else { out.failed++; if (out.errors.length < 5) out.errors.push({ guest: g.name, error: result.error }); }
      }));
    }
    if (out.sent) await logActivity(ctx, req.user.id, `${out.sent} invitation${out.sent === 1 ? '' : 's'} sent by ${ch.label}`);
    res.json(out);
  }));

  // Feeds the generic "Messages" tab (see modules.js).
  r.get('/log', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json({ rows: await db.prepare('SELECT id, guest_id, guest_name, channel, to_phone, status, error, ts FROM message_log WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit) });
  }));

  return r;
}
