// Hash routes (#/login, #/app/guests). Emails and the sign-in providers redirect here, so the hash is part of the contract.
export const go = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
export const replace = (hash) => history.replaceState(null, '', location.pathname + hash);
export function current() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('?');
  const path = i < 0 ? raw : raw.slice(0, i);
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
}
