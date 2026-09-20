const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(d) {
  if (!d) return 'Date to be confirmed';
  const dt = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return d;
  return `${DAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
export function fmtTime(t) {
  if (!t) return 'Time to be confirmed';
  const [h, m] = t.split(':'); const hr = parseInt(h, 10);
  return Number.isNaN(hr) ? t : `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}
export const clock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const fullTime = (ts) => new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return fullTime(ts);
}
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export function daysUntil(date, now = Date.now()) {
  if (!date) return null;
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);   // East Africa Time
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
export const whenLabel = (n) => (n === null ? '' : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 ? `In ${n} days` : `${-n} days ago`);
