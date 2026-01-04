export const DAY_MS = 24 * 60 * 60 * 1000;
export const BOUNDARY_HOUR = 3; // day resets at 3am local

export const pad2 = (n) => String(n).padStart(2, '0');

export function localDateKeyFrom(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function logicalDayKey(ts = Date.now()) {
  // Shift time backwards by BOUNDARY_HOUR so 00:00-02:59 counts as previous day.
  return localDateKeyFrom(ts - BOUNDARY_HOUR * 60 * 60 * 1000);
}

export function minutesOfDay(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function circularMinuteDistance(a, b) {
  const diff = Math.abs(a - b) % 1440;
  return Math.min(diff, 1440 - diff);
}

export function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function toDatetimeLocalValue(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export function parseDatetimeLocalValue(value) {
  // value: "YYYY-MM-DDTHH:mm" in local time.
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/.exec(value);
  if (!m) return null;
  const [_, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0).getTime();
}

export function normalizeTitle(title) {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function randomKey(bytes = 12) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function parseSignalingList(s) {
  const raw = String(s || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

export function errToObj(e) {
  if (!e) return null;
  if (typeof e === 'string') return { message: e };
  return {
    name: e.name,
    message: e.message,
    stack: e.stack
  };
}

// Avoid storing non-JSON-safe stuff in the persisted debug log.
export function toJsonSafe(x) {
  if (x == null) return x;
  try { return JSON.parse(JSON.stringify(x)); } catch { return String(x); }
}

// Redact secrets (encryption keys, TURN keys, etc)
export function redact(s, keep = 4) {
  const t = String(s || '');
  if (!t) return '';
  if (t.length <= keep * 2) return '*'.repeat(t.length);
  return `${t.slice(0, keep)}…${t.slice(-keep)} (len=${t.length})`;
}

export function suggestionScore(item, fuseScore, nowTs) {
  const fuzzy = 1 / (1 + (fuseScore ?? 0.6) * 8);
  const usage = Math.max(0, item.usageCount || 0);
  const pop = Math.log10(usage + 1);
  const first = item.firstUsedAt || nowTs;
  const daysSpan = Math.max(1, (nowTs - first) / DAY_MS);
  const freq = Math.log10((usage / daysSpan) + 1);
  const last = item.lastUsedAt || 0;
  const daysSinceLast = last ? (nowTs - last) / DAY_MS : 999;
  const recency = 1 / (1 + daysSinceLast / 3);
  const near = 1 / (1 + circularMinuteDistance(minutesOfDay(nowTs), item.meanMinutes || minutesOfDay(nowTs)) / 90);

  return 3.0 * fuzzy + 1.0 * pop + 1.2 * freq + 1.4 * recency + 0.8 * near;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
