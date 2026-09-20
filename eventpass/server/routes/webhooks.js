import { Router } from 'express';
import crypto from 'node:crypto';
import { ApiError, wrap } from '../lib/http.js';
import { safeEqual } from '../lib/tokens.js';
import { getChannel } from '../messaging/index.js';
import { friendlyError as waError } from '../messaging/whatsapp.js';
import { friendlyError as atError } from '../messaging/africastalking.js';

const RANK = { sent: 1, delivered: 2, read: 3 };

// Delivery receipts only ever move a message forward (sent → delivered → read); a late "sent" cannot undo "read".
// A failure report applies to messages that were not yet delivered, and frees the guest to be messaged again.
export async function applyDeliveryStatus(ctx, ref, status, error) {
  if (!ref) return false;
  const row = await ctx.db.prepare('SELECT * FROM message_log WHERE provider_ref = ? ORDER BY id DESC LIMIT 1').get(ref);
  if (!row) return false;
  if (status === 'failed') {
    if ((RANK[row.status] || 0) >= RANK.delivered) return false;
    await ctx.db.prepare("UPDATE message_log SET status = 'failed', error = ? WHERE id = ?").run(String(error || 'Delivery failed.').slice(0, 300), row.id);
    const flag = getChannel(row.channel)?.flag;
    if (flag && row.guest_id) await ctx.db.prepare(`UPDATE guests SET ${flag} = 0 WHERE id = ? AND user_id = ?`).run(row.guest_id, row.user_id);
    return true;
  }
  if (!RANK[status] || (RANK[row.status] || 0) >= RANK[status]) return false;
  await ctx.db.prepare('UPDATE message_log SET status = ?, error = NULL WHERE id = ?').run(status, row.id);
  return true;
}

export function webhookRoutes(ctx) {
  const r = Router();
  const cfg = ctx.config;

  // Meta calls this once when you save the webhook in the developer dashboard.
  r.get('/whatsapp', (req, res, next) => {
    if (!cfg.whatsapp.verifyToken) return next(new ApiError(404, 'not_found', 'Not found.'));
    const ok = req.query['hub.mode'] === 'subscribe' && typeof req.query['hub.verify_token'] === 'string' && safeEqual(req.query['hub.verify_token'], cfg.whatsapp.verifyToken);
    if (!ok) return next(new ApiError(403, 'forbidden', 'Verification failed.'));
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? '').slice(0, 200));
  });

  r.post('/whatsapp', wrap(async (req, res) => {
    if (!cfg.whatsapp.appSecret) throw new ApiError(404, 'not_found', 'Not found.');
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const expected = 'sha256=' + crypto.createHmac('sha256', cfg.whatsapp.appSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    if (!sig || !req.rawBody || !safeEqual(sig, expected)) throw new ApiError(401, 'bad_signature', 'Signature check failed.');
    for (const entry of req.body?.entry || []) for (const change of entry.changes || []) for (const s of change.value?.statuses || []) {
      const err = s.errors?.[0];
      await applyDeliveryStatus(ctx, s.id, s.status, err ? waError(err.code, err.title) : null);
    }
    res.json({ ok: true });                                            // always 200 once authenticated, or Meta keeps retrying
  }));

  // Africa's Talking delivery reports are not signed, so the callback URL itself carries a secret: /webhooks/at/<AT_WEBHOOK_SECRET>
  r.post('/at/:secret', wrap(async (req, res) => {
    if (!cfg.atWebhookSecret) throw new ApiError(404, 'not_found', 'Not found.');
    if (!safeEqual(String(req.params.secret), cfg.atWebhookSecret)) throw new ApiError(401, 'bad_secret', 'Not authorised.');
    const { id, status, failureReason } = req.body || {};
    const s = String(status || '').toLowerCase();
    if (s === 'success') await applyDeliveryStatus(ctx, id, 'delivered');
    else if (s === 'failed' || s === 'rejected') await applyDeliveryStatus(ctx, id, 'failed', atError(failureReason));
    res.json({ ok: true });
  }));

  return r;
}
