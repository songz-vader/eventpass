import { rateLimit } from 'express-rate-limit';

// In-memory counters (fine for one server process). If you scale to several instances, swap in a shared store (e.g. Redis).
export function makeLimiter(cfg, { windowMs, limit, message = 'Too many requests. Please wait a moment and try again.', skipSuccessful = false }) {
  if (!cfg.rate.enabled) return (req, res, next) => next();
  return rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: skipSuccessful,
    handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message, retry_after: Math.ceil(windowMs / 1000) } }),
  });
}
