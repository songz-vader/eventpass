import helmet from 'helmet';
import { ApiError } from '../lib/http.js';

export function securityHeaders(cfg) {
  const h = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],                                   // no inline scripts, no eval
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        ...(cfg.secureCookies ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: cfg.secureCookies ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  return (req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    h(req, res, next);
  };
}

// Cross-site request forgery, layer 1: browsers always tell us where a POST came from.
export function originCheck(cfg) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path.startsWith('/webhooks/')) return next(); // server-to-server, authenticated by signature
    // Apple posts the sign-in result from its own site. That handler only redirects and changes nothing, so it alone is exempt.
    if (req.method === 'POST' && /^\/api\/auth\/oauth\/[a-z][a-z0-9_-]{1,30}\/callback$/.test(req.path)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== new URL(cfg.appUrl).origin) return next(new ApiError(403, 'bad_origin', 'Request blocked: unexpected origin.'));
    next();
  };
}
