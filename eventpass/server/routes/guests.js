import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { ApiError, wrap, parse } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { randomCode } from '../lib/tokens.js';
import { isUniqueViolation } from '../db.js';
import { logActivity } from '../services/core.js';
import { channelIds, getChannel, loadChannelConfig, sendGuestMessage, messageForGuest } from '../messaging/index.js';

const SELECT = `SELECT g.*, e.name AS event_name FROM guests g JOIN events e ON e.id = g.event_id`;

export const shapeGuest = (g) => g && ({
  id: g.id, event_id: g.event_id, event_name: g.event_name, name: g.name, phone: g.phone || '', operator: g.operator || null,
  invite_type: g.invite_type, code: g.code, checked_in: !!g.checked_in, checked_in_at: g.checked_in_at,
  sms_sent: !!g.sms_sent, wa_sent: !!g.wa_sent, code_viewed: !!g.code_viewed, created_at: g.created_at,
});

const nameField = z.string().trim().min(1, 'Enter the guest\'s name.').max(100, 'Keep the name under 100 characters.');
const typeField = z.enum(['single', 'double'], 'Choose single or double entry.');
const guestSchema = z.object({
  event_id: z.coerce.number({ error: 'Choose an event.' }).int().positive('Choose an event.'),
  name: nameField,
  phone: z.string().trim().max(30, 'That phone number is too long.').optional().nullable(),
  invite_type: typeField.default('single'),
});

function phoneOrThrow(raw) {
  if (!raw || !String(raw).trim()) return { phone: '', operator: null };
  const p = normalizePhone(String(raw));
  if (!p.ok) throw new ApiError(400, 'validation', p.error, { fields: { phone: p.error } });
  return { phone: p.e164, operator: p.operator };
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

// Spreadsheet apps run cells that start with = + - @ as formulas. A guest called "=HYPERLINK(...)" must stay text.
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+[\d ]+$/.test(s)) s = "'" + s;
  return /[",\n\r]|^'/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function guestRoutes(ctx) {
  const r = Router();
  const db = ctx.db;

  const ownEvent = async (req, id) => {
    const ev = await db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
    if (!ev) throw new ApiError(404, 'not_found', 'Event not found.');
    return ev;
  };
  const ownGuest = async (req, id) => {
    const g = await db.prepare(`${SELECT} WHERE g.id = ? AND g.user_id = ?`).get(Number(id), req.user.id);
    if (!g) throw new ApiError(404, 'not_found', 'Guest not found.');
    return g;
  };
  const guestCount = async (uid) => (await db.prepare('SELECT COUNT(*) c FROM guests WHERE user_id = ?').get(uid)).c;
  const assertRoom = async (uid, adding = 1) => {
    if (await guestCount(uid) + adding > ctx.config.limits.maxGuests) throw new ApiError(400, 'limit', `You can have up to ${ctx.config.limits.maxGuests} guests in total.`);
  };
  // `d` is the database or a transaction. Inside a transaction a failed INSERT would spoil it on PostgreSQL, so there the code is checked first.
  async function insertGuest(d, uid, ev, { name, phone, operator, invite_type }, { inTx = false } = {}) {
    for (let i = 0; i < 8; i++) {
      const code = randomCode(8);
      if (inTx && await d.get('SELECT 1 AS taken FROM guests WHERE code = ?', [code])) continue;
      try {
        return await d.insert('INSERT INTO guests (user_id, event_id, name, phone, operator, invite_type, code, created_at) VALUES (?,?,?,?,?,?,?,?)',
          [uid, ev.id, name, phone || null, operator, invite_type, code, ctx.now()]);
      } catch (e) { if (inTx || !isUniqueViolation(e)) throw e; }     // two guests drew the same code: draw again
    }
    throw new ApiError(500, 'server_error', 'Could not create a unique code. Please try again.');
  }

  function listFilters(req) {
    const where = ['g.user_id = ?']; const args = [req.user.id];
    if (req.query.event_id) { where.push('g.event_id = ?'); args.push(Number(req.query.event_id) || 0); }
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q) { where.push("(LOWER(g.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(g.code) LIKE LOWER(?) ESCAPE '\\' OR LOWER(g.phone) LIKE LOWER(?) ESCAPE '\\')"); const l = `%${likeEscape(q)}%`; args.push(l, l, l); }
    return { where: where.join(' AND '), args };
  }

  r.get('/', wrap(async (req, res) => {
    const { where, args } = listFilters(req);
    res.json({ guests: (await db.prepare(`${SELECT} WHERE ${where} ORDER BY g.id DESC LIMIT 5000`).all(...args)).map(shapeGuest) });
  }));

  r.get('/export.csv', wrap(async (req, res) => {
    const { where, args } = listFilters(req);
    const rows = await db.prepare(`${SELECT} WHERE ${where} ORDER BY e.name, g.name`).all(...args);
    const head = ['Name', 'Phone', 'Operator', 'Event', 'Code', 'Invite type', 'Checked in', 'SMS sent', 'WhatsApp sent'];
    const lines = [head.join(',')].concat(rows.map((g) => [g.name, g.phone, g.operator, g.event_name, g.code, g.invite_type === 'double' ? 'Double' : 'Single', g.checked_in ? 'Yes' : 'No', g.sms_sent ? 'Yes' : 'No', g.wa_sent ? 'Yes' : 'No'].map(csvCell).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="eventpass-guests.csv"');
    res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  }));

  r.post('/', wrap(async (req, res) => {
    const b = parse(guestSchema, req.body);
    const ev = await ownEvent(req, b.event_id);
    const { phone, operator } = phoneOrThrow(b.phone);
    await assertRoom(req.user.id);
    const id = await insertGuest(db, req.user.id, ev, { name: b.name, phone, operator, invite_type: b.invite_type });
    await logActivity(ctx, req.user.id, `"${b.name}" invited to "${ev.name}"`);

    // Send the invitation on every channel the host has set up and left on auto-send. A provider failure never blocks adding the guest.
    const sent = [], failed = [];
    if (phone) {
      for (const ch of channelIds()) {
        const cfg = await loadChannelConfig(ctx, req.user.id, ch);
        if (!cfg.configured || !cfg.autoSend) continue;
        const result = await sendGuestMessage(ctx, req.user.id, await db.prepare('SELECT * FROM guests WHERE id = ?').get(id), ev, ch);
        if (result.ok) sent.push(ch); else failed.push({ channel: ch, error: result.error });
      }
    }
    res.status(201).json({ guest: shapeGuest(await ownGuest(req, id)), sent, failed });
  }));

  r.post('/bulk', wrap(async (req, res) => {
    const max = ctx.config.limits.maxBulk;
    const b = parse(z.object({
      event_id: z.coerce.number({ error: 'Choose an event.' }).int().positive('Choose an event.'),
      guests: z.array(z.object({ name: z.any(), phone: z.any().optional(), invite_type: z.any().optional() })).min(1, 'Add at least one guest.').max(max, `You can import up to ${max} guests at a time.`),
    }), req.body);
    const ev = await ownEvent(req, b.event_id);
    const seen = new Set((await db.prepare('SELECT name, phone FROM guests WHERE event_id = ?').all(ev.id)).map((g) => `${g.name.toLowerCase()}|${g.phone || ''}`));
    let room = ctx.config.limits.maxGuests - await guestCount(req.user.id);
    const skipped = []; let created = 0;
    await db.tx(async (t) => {                                    // all rows or none: a failure half way leaves nothing behind
      for (const [i, row] of b.guests.entries()) {
        const skip = (reason) => skipped.push({ row: i + 1, name: typeof row.name === 'string' ? row.name.slice(0, 100) : '', reason });
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        if (!name) { skip('Missing name.'); continue; }
        if (name.length > 100) { skip('Name is too long.'); continue; }
        const type = row.invite_type === undefined || row.invite_type === '' || row.invite_type === null ? 'single' : String(row.invite_type).toLowerCase();
        if (!['single', 'double'].includes(type)) { skip('Invite type must be single or double.'); continue; }
        let phone = '', operator = null;
        if (row.phone && String(row.phone).trim()) {
          const p = normalizePhone(String(row.phone));
          if (!p.ok) { skip(p.error); continue; }
          phone = p.e164; operator = p.operator;
        }
        const key = `${name.toLowerCase()}|${phone}`;
        if (seen.has(key)) { skip('Duplicate of another guest in this event.'); continue; }
        if (room <= 0) { skip(`Guest limit of ${ctx.config.limits.maxGuests} reached.`); continue; }
        await insertGuest(t, req.user.id, ev, { name, phone, operator, invite_type: type }, { inTx: true });
        seen.add(key); room--; created++;
      }
    });
    if (created) await logActivity(ctx, req.user.id, `${created} guest${created === 1 ? '' : 's'} imported to "${ev.name}"`);
    res.json({ created, skipped });
  }));

  r.patch('/:id', wrap(async (req, res) => {
    const cur = await ownGuest(req, req.params.id);
    const b = parse(z.object({ name: nameField, phone: z.string().trim().max(30).optional().nullable(), invite_type: typeField }).partial(), req.body);
    const next = { name: b.name ?? cur.name, invite_type: b.invite_type ?? cur.invite_type, phone: cur.phone || '', operator: cur.operator };
    if ('phone' in b) Object.assign(next, phoneOrThrow(b.phone));
    const phoneChanged = next.phone !== (cur.phone || '');
    await db.prepare(`UPDATE guests SET name = ?, phone = ?, operator = ?, invite_type = ?, sms_sent = ?, wa_sent = ? WHERE id = ? AND user_id = ?`)
      .run(next.name, next.phone || null, next.operator, next.invite_type, phoneChanged ? 0 : cur.sms_sent, phoneChanged ? 0 : cur.wa_sent, cur.id, req.user.id);
    res.json({ guest: shapeGuest(await ownGuest(req, cur.id)) });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const g = await ownGuest(req, req.params.id);
    await db.prepare('DELETE FROM guests WHERE id = ? AND user_id = ?').run(g.id, req.user.id);
    await logActivity(ctx, req.user.id, `"${g.name}" removed`);
    res.json({ ok: true });
  }));

  r.get('/:id/qr.svg', wrap(async (req, res) => {
    const g = await ownGuest(req, req.params.id);
    const svg = await QRCode.toString(g.code, { type: 'svg', errorCorrectionLevel: 'H', margin: 1, color: { dark: '#1C1814', light: '#FFFFFF' } });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(svg);
  }));

  const channelParam = (v) => {
    if (!channelIds().includes(v)) throw new ApiError(400, 'validation', 'Choose SMS or WhatsApp.');
    return v;
  };

  r.get('/:id/message', wrap(async (req, res) => {
    const g = await ownGuest(req, req.params.id);
    const ch = channelParam(String(req.query.channel || ''));
    res.json(await messageForGuest(ctx, req.user.id, g, await ownEvent(req, g.event_id), ch));
  }));

  r.post('/:id/send', wrap(async (req, res) => {
    const g = await ownGuest(req, req.params.id);
    const ch = channelParam(String(req.body?.channel || ''));
    const result = await sendGuestMessage(ctx, req.user.id, await db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id), await ownEvent(req, g.event_id), ch);
    if (!result.ok) throw new ApiError(result.code ? 400 : 502, result.code || 'provider_error', result.error);
    await logActivity(ctx, req.user.id, `Invitation sent to "${g.name}" by ${getChannel(ch).label}`);
    res.json({ ok: true, guest: shapeGuest(await ownGuest(req, g.id)) });
  }));

  return r;
}
