import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { ApiError, wrap, parse } from '../lib/http.js';
import { REGIONS, mapLink, locationText } from '../lib/locations.js';
import { TEMPLATE_VARS, DEFAULT_TEMPLATES, smsSegments } from '../lib/template.js';
import { platformCaps, channelSchema } from '../messaging/index.js';
import { providerList } from '../services/oauth.js';
import { TABS } from '../modules.js';
import { makeLimiter } from '../middleware/limits.js';
import { logActivity } from '../services/core.js';

export function publicRoutes(ctx) {
  const r = Router();
  const cfg = ctx.config;

  // Everything the front end needs to decide what to show. Add a backend capability here and the UI can pick it up.
  r.get('/config', (req, res) => {
    const caps = platformCaps(ctx);
    res.json({
      app: { name: 'EventPass', version: '1.0.0' },
      registration: cfg.allowRegistration,
      oauth: providerList(ctx),
      mfa: { totp: true, sms: caps.sms, whatsapp: caps.whatsapp, backup: true },
      email: ctx.mailer.enabled || !cfg.isProd,
      regions: REGIONS,
      templateVars: TEMPLATE_VARS,
      defaultTemplates: DEFAULT_TEMPLATES,
      channels: channelSchema().map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
      tabs: TABS.map(({ id, label, icon, builtin, title, sub, endpoint, columns, empty }) => ({ id, label, icon, builtin, title, sub, endpoint, columns, empty })),
      limits: cfg.limits,
    });
  });

  const lookup = makeLimiter(cfg, { windowMs: cfg.rate.publicWindowMs, limit: cfg.rate.publicPerIp, message: 'Too many attempts. Wait a few minutes before trying again.' });
  r.post('/invite', lookup, wrap(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,12}$/, 'That code is not valid.') }), req.body);
    const g = await ctx.db.prepare('SELECT * FROM guests WHERE code = ?').get(code);
    if (!g) throw new ApiError(404, 'invalid_code', 'That code was not found. Check it and try again.');
    const ev = await ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(g.event_id);
    if (!g.code_viewed) {
      await ctx.db.prepare('UPDATE guests SET code_viewed = 1 WHERE id = ?').run(g.id);
      await logActivity(ctx, g.user_id, `"${g.name}" viewed their invitation`);
    }
    res.json({
      guest: { name: g.name, invite_type: g.invite_type, code: g.code },
      event: ev && { name: ev.name, type: ev.type, date: ev.date, time: ev.time, venue: ev.venue, region: ev.region, district: ev.district, address: ev.address,
        location: locationText(ev), lat: ev.lat, lng: ev.lng, map_url: mapLink(ev), dress: ev.dress, note: ev.note },
    });
  }));

  // The QR on a guest's invitation. It only encodes the code they already typed, so nothing is looked up or revealed.
  r.get('/qr/:code.svg', wrap(async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(code)) throw new ApiError(400, 'invalid_code', 'That code is not valid.');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(await QRCode.toString(code, { type: 'svg', errorCorrectionLevel: 'H', margin: 1, color: { dark: '#1C1814', light: '#FFFFFF' } }));
  }));

  r.post('/sms-length', (req, res) => res.json(smsSegments(String(req.body?.text || '').slice(0, 2000))));
  return r;
}
