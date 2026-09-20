export class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Validate with a zod schema; turn failures into a 400 with per-field messages the UI can show.
export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const fields = {};
  for (const i of r.error.issues) { const k = i.path.join('.') || '_'; if (!fields[k]) fields[k] = i.message; }
  throw new ApiError(400, 'validation', Object.values(fields)[0] || 'Please check your input.', { fields });
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
  }
  return out;
}

export const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';
export const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 300);
