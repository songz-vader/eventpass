// One place that talks to the server. Adds the CSRF token to writes and turns failures into readable errors.
export const store = { config: null, user: null, csrf: null, events: null, mfaToken: null };

export class ApiFail extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.fields = extra.fields || {}; this.extra = extra; }
}

export async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && store.csrf) headers['X-CSRF-Token'] = store.csrf;
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { throw new ApiFail(0, 'network', 'Could not reach the server. Check your connection and try again.'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty or not JSON */ }
  if (data?.csrf) store.csrf = data.csrf;
  if (!res.ok) {
    const e = data?.error || {};
    if (res.status === 401 && e.code === 'unauthenticated' && store.user) window.dispatchEvent(new CustomEvent('ep:signedout'));
    throw new ApiFail(res.status, e.code || 'error', e.message || 'Something went wrong. Please try again.', e);
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p, b) => api('DELETE', p, b ?? {});

export async function loadEvents(force = false) {
  if (!store.events || force) store.events = (await get('/api/events')).events;
  return store.events;
}

// Door-staff calls: authenticated by the link's secret alone, sent as a header. No cookies, no CSRF token.
export async function scanApi(token, method, path, body) {
  const headers = { Accept: 'application/json', 'X-Scanner-Token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit' }); }
  catch { throw new ApiFail(0, 'network', 'No connection. Check your signal and try again.'); }
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = data?.error || {}; throw new ApiFail(res.status, e.code || 'error', e.message || 'Something went wrong. Please try again.', e); }
  return data;
}
