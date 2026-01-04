/* DayList
   - Daily repeating tasks reset at 3am (local time)
   - Scheduled tasks appear when their due time arrives
   - Offline-first PWA + P2P sync (Yjs + y-webrtc)
   - Two-key sync via URL query:
       ?room=CONNECT_KEY&enc=ENCRYPTION_KEY[&sig=wss://...,wss://...][&turnKey=...]
   - TURN via Metered credentials API (recommended for cross-network reliability)
*/

import * as Y from 'https://esm.sh/yjs@13.6.28';
import { WebrtcProvider } from 'https://esm.sh/y-webrtc@10.3.0';
import { IndexeddbPersistence } from 'https://esm.sh/y-indexeddb@9.0.12';
import Fuse from 'https://esm.sh/fuse.js@7.1.0';

/* ------------------------------ Utilities ------------------------------ */
const DAY_MS = 24 * 60 * 60 * 1000;
const BOUNDARY_HOUR = 3; // day resets at 3am local

const DEFAULT_SIGNALING = [
  'wss://signaling.yjs.dev',
  'wss://y-webrtc-signaling-eu.herokuapp.com',
  'wss://y-webrtc-signaling-us.herokuapp.com'
];

// Metered TURN credentials endpoint (you can change the UUID part if you use a different Metered app)
const METERED_TURN_ENDPOINT =
  'https://dac1ee5f-99c1-46e6-8497-bcde3d533904.metered.live/api/v1/turn/credentials';

const METERED_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');

function localDateKeyFrom(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function logicalDayKey(ts = Date.now()) {
  // Shift time backwards by BOUNDARY_HOUR so 00:00-02:59 counts as previous day.
  return localDateKeyFrom(ts - BOUNDARY_HOUR * 60 * 60 * 1000);
}

function minutesOfDay(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

function circularMinuteDistance(a, b) {
  const diff = Math.abs(a - b) % 1440;
  return Math.min(diff, 1440 - diff);
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toDatetimeLocalValue(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function parseDatetimeLocalValue(value) {
  // value: "YYYY-MM-DDTHH:mm" in local time.
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/.exec(value);
  if (!m) return null;
  const [_, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0).getTime();
}

function normalizeTitle(title) {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function randomKey(bytes = 12) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function parseSignalingList(s) {
  const raw = String(s || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

/* --------------------------- Debug + Logging --------------------------- */
const DEBUG_Q = 'debug';
const DEBUG_LS = 'daylist.debug.enabled.v1';
const DEBUG_LOG_LS = 'daylist.debug.log.v1';
const DEBUG_LOG_MAX = 500;

function isDebugEnabled() {
  try {
    const url = new URL(window.location.href);
    const q = (url.searchParams.get(DEBUG_Q) || '').trim();
    if (q === '1' || q === 'true') return true;
    return localStorage.getItem(DEBUG_LS) === '1';
  } catch {
    return false;
  }
}
const DEBUG = isDebugEnabled();

function tsIso(t = Date.now()) {
  return new Date(t).toISOString();
}

function safeJson(x) {
  try { return JSON.parse(JSON.stringify(x)); } catch { return String(x); }
}

function loadDebugLog() {
  try {
    const raw = localStorage.getItem(DEBUG_LOG_LS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveDebugLog(arr) {
  try {
    localStorage.setItem(DEBUG_LOG_LS, JSON.stringify(arr.slice(-DEBUG_LOG_MAX)));
  } catch {
    // ignore quota failures
  }
}

let __debugLog = loadDebugLog();

function log(level, msg, data) {
  const entry = { t: Date.now(), iso: tsIso(), level, msg, data: data == null ? null : safeJson(data) };
  __debugLog.push(entry);
  if (__debugLog.length > DEBUG_LOG_MAX) __debugLog = __debugLog.slice(-DEBUG_LOG_MAX);
  saveDebugLog(__debugLog);

  const prefix = `[DayList ${entry.iso}]`;
  // Always log warnings/errors; debug/info only if DEBUG enabled
  if (level === 'error') console.error(prefix, msg, data ?? '');
  else if (level === 'warn') console.warn(prefix, msg, data ?? '');
  else if (DEBUG) console.log(prefix, msg, data ?? '');
}

window.daylistDebug = {
  enabled: DEBUG,
  enable() { try { localStorage.setItem(DEBUG_LS, '1'); } catch {} log('info', 'Debug enabled (reload to apply)'); },
  disable() { try { localStorage.removeItem(DEBUG_LS); } catch {} log('info', 'Debug disabled (reload to apply)'); },
  dumpLog() { return loadDebugLog(); },
  clearLog() { try { localStorage.removeItem(DEBUG_LOG_LS); } catch {} },
};

async function storageDiagnostics() {
  log('info', 'Storage diagnostics: start', {
    href: window.location.href,
    origin: window.location.origin,
    ua: navigator.userAgent,
    standalone: window.matchMedia?.('(display-mode: standalone)')?.matches ?? null
  });

  // localStorage sanity
  try {
    const k = '__daylist_ls_test__';
    localStorage.setItem(k, String(Date.now()));
    localStorage.removeItem(k);
    log('info', 'localStorage: OK');
  } catch (e) {
    log('error', 'localStorage: FAILED', { e: String(e) });
  }

  // IndexedDB sanity
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('__daylist_idb_test__', 1);
      req.onupgradeneeded = () => { /* noop */ };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error || new Error('IDB open failed'));
    });
    indexedDB.deleteDatabase('__daylist_idb_test__');
    log('info', 'indexedDB: OK');
  } catch (e) {
    log('error', 'indexedDB: FAILED', { e: String(e) });
  }

  // Storage persistence (prevents browser eviction)
  try {
    if (navigator.storage?.persisted && navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted();
      log('info', 'storage.persisted()', { persisted });
      if (!persisted) {
        const granted = await navigator.storage.persist();
        log('info', 'storage.persist() requested', { granted });
      }
    }
  } catch (e) {
    log('warn', 'storage.persist() check failed', { e: String(e) });
  }

  // Quota estimate
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      log('info', 'storage.estimate()', est);
    }
  } catch (e) {
    log('warn', 'storage.estimate() failed', { e: String(e) });
  }

  log('info', 'Storage diagnostics: end');
}

/* ----------------------------- PWA wiring ----------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* ------------------------------ URL keys ------------------------------ */
const Q_ROOM = 'room';
const Q_ENC = 'enc';
const Q_SIG = 'sig';
const Q_TURN = 'turnKey';

const SNAPSHOT_KEY = 'daylist.snapshot.v1';

const LS_ROOM = 'daylist.room.v1';
const LS_ENC = 'daylist.enc.v1';
const LS_SIG = 'daylist.sig.v1';
const LS_TURN = 'daylist.turnKey.v1';

const LS_LEGACY_PW = 'daylist.pw.v1';

// Cached Metered ICE servers so you can still connect when offline
const LS_METERED_ICE_CACHE = 'daylist.meteredIceCache.v1';

function readQuery() {
  const url = new URL(window.location.href);
  return {
    room: (url.searchParams.get(Q_ROOM) || '').trim(),
    enc: (url.searchParams.get(Q_ENC) || '').trim(),
    sig: (url.searchParams.get(Q_SIG) || '').trim(),
    turnKey: (url.searchParams.get(Q_TURN) || '').trim()
  };
}

function writeQuery({ room, enc, sig, turnKey }) {
  const url = new URL(window.location.href);

  if (room != null) url.searchParams.set(Q_ROOM, room);
  if (enc != null) url.searchParams.set(Q_ENC, enc);

  if (sig != null) {
    const clean = String(sig).trim();
    if (clean) url.searchParams.set(Q_SIG, clean);
    else url.searchParams.delete(Q_SIG);
  }

  if (turnKey != null) {
    const clean = String(turnKey).trim();
    if (clean) url.searchParams.set(Q_TURN, clean);
    else url.searchParams.delete(Q_TURN);
  }

  history.replaceState({}, '', url.toString());
}

function ensureKeysInUrlAndInputs(els) {
  const q = readQuery();

  // precedence: URL query -> localStorage -> prompt (for room+enc only)
  let room = q.room || (localStorage.getItem(LS_ROOM) || '').trim();
  let enc =
    q.enc ||
    (localStorage.getItem(LS_ENC) || '').trim() ||
    (localStorage.getItem(LS_LEGACY_PW) || '').trim();
  let sig = q.sig || (localStorage.getItem(LS_SIG) || '').trim();
  let turnKey = q.turnKey || (localStorage.getItem(LS_TURN) || '').trim();

  if (!room) {
    const suggestion = `daylist-${randomKey(6)}`;
    room = (prompt('Connect key (room):', suggestion) || '').trim() || suggestion;
  }

  if (!enc) {
    const suggestion = randomKey(12);
    enc = (prompt('Encryption key (required):', suggestion) || '').trim() || suggestion;
  }

  // Persist locally
  localStorage.setItem(LS_ROOM, room);
  localStorage.setItem(LS_ENC, enc);
  localStorage.removeItem(LS_LEGACY_PW);

  if (sig) localStorage.setItem(LS_SIG, sig);
  else localStorage.removeItem(LS_SIG);

  if (turnKey) localStorage.setItem(LS_TURN, turnKey);
  else localStorage.removeItem(LS_TURN);

  // Persist in URL query (shareable)
  writeQuery({ room, enc, sig, turnKey });

  // Populate UI
  els.roomInput.value = room;
  els.encInput.value = enc;
  els.sigInput.value = sig;
  els.turnKeyInput.value = turnKey;
}

/* ---------------------------- Metered TURN ---------------------------- */
function meteredUrl(apiKey) {
  const u = new URL(METERED_TURN_ENDPOINT);
  u.searchParams.set('apiKey', apiKey);
  return u.toString();
}

function isValidIceServers(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  // minimal sanity: each entry should have urls
  return arr.every(x => x && (typeof x.urls === 'string' || Array.isArray(x.urls)));
}

function loadMeteredIceCache() {
  try {
    const raw = localStorage.getItem(LS_METERED_ICE_CACHE);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj.iceServers)) return null;
    if (typeof obj.fetchedAt !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

function saveMeteredIceCache(iceServers) {
  try {
    localStorage.setItem(LS_METERED_ICE_CACHE, JSON.stringify({
      fetchedAt: Date.now(),
      iceServers
    }));
  } catch {}
}

async function getIceServers(turnKey) {
  // If user provided a Metered API key, that becomes the primary ICE list.
  const key = (turnKey || '').trim();
  if (!key) {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
    ];
  }

  // Use cache if fresh
  const cached = loadMeteredIceCache();
  if (cached && (Date.now() - cached.fetchedAt) < METERED_CACHE_TTL_MS && isValidIceServers(cached.iceServers)) {
    return cached.iceServers;
  }

  // Fetch new credentials
  try {
    const res = await fetch(meteredUrl(key), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Metered fetch failed: ${res.status}`);
    const iceServers = await res.json();
    if (!isValidIceServers(iceServers)) throw new Error('Unexpected Metered response');
    saveMeteredIceCache(iceServers);
     console.log(iceServers);
    return iceServers;
  } catch (e) {
    // Fallback to cache even if stale, else STUN-only.
    if (cached && isValidIceServers(cached.iceServers)) {
      toast('TURN fetch failed; using cached TURN credentials');
      return cached.iceServers;
    }
    toast('TURN fetch failed; falling back to STUN only');
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
    ];
  }
}

/* ------------------------------ Yjs setup ------------------------------ */
const ydoc = new Y.Doc();
const persistence = new IndexeddbPersistence('daylist-v1', ydoc);
persistence.on('synced', () => {
  log('info', 'IndexedDB persistence: synced', { counts: docCounts() });
});

// Shared structures
const yTasks = ydoc.getMap('tasks');          // id -> Y.Map
const yTemplates = ydoc.getMap('templates');  // key -> Y.Map
const yHistory = ydoc.getMap('history');      // dayKey -> Y.Map(taskId -> completedAt)

let provider = null;
let fuse = null;
let templateIndex = [];

/* ------------------------------ Local UI ------------------------------ */
const els = {
  dayLabel: $('dayLabel'),
  syncPill: $('syncPill'),
  peersCount: $('peersCount'),

  titleInput: $('titleInput'),
  typeDaily: $('typeDaily'),
  typeScheduled: $('typeScheduled'),
  dueInput: $('dueInput'),
  addBtn: $('addBtn'),
  suggestions: $('suggestions'),

  todayList: $('todayList'),
  upcomingList: $('upcomingList'),
  upcomingCount: $('upcomingCount'),
  upcomingDetails: $('upcomingDetails'),
  historyList: $('historyList'),

  roomInput: $('roomInput'),
  encInput: $('encInput'),
  sigInput: $('sigInput'),
  turnKeyInput: $('turnKeyInput'),
  reconnectBtn: $('reconnectBtn'),
  copyLinkBtn: $('copyLinkBtn'),

  exportBtn: $('exportBtn'),
  importFile: $('importFile'),
  wipeBtn: $('wipeBtn'),
};

/* ------------------------------ Persistence --------------------------- */
let hydrationComplete = false;  // guard to avoid persisting "empty boot" state
let lastSnapshotMeta = null;

function snapshotMeta(snapshot) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks.length : 0;
  const templates = snapshot?.templates && typeof snapshot.templates === 'object'
    ? Object.keys(snapshot.templates).length
    : 0;
  const historyDays = snapshot?.history && typeof snapshot.history === 'object'
    ? Object.keys(snapshot.history).length
    : 0;
  return { v: snapshot?.v ?? null, exportedAt: snapshot?.exportedAt ?? null, tasks, templates, historyDays };
}

function docCounts() {
  let tasks = 0, templates = 0, historyDays = 0;
  try { tasks = yTasks.size; } catch {}
  try { templates = yTemplates.size; } catch {}
  try { historyDays = yHistory.size; } catch {}
  return { tasks, templates, historyDays };
}

function writeSnapshot(reason = 'unknown') {
  try {
    const before = docCounts();
    const t0 = performance.now();
    const snapshot = exportSnapshot({ historyDays: 120 });
    const meta = snapshotMeta(snapshot);
    const json = JSON.stringify(snapshot);
    localStorage.setItem(SNAPSHOT_KEY, json);
    lastSnapshotMeta = meta;

    const t1 = performance.now();
    log('info', 'Snapshot written', {
      reason,
      bytes: json.length,
      meta,
      docBefore: before,
      tookMs: Math.round((t1 - t0) * 10) / 10
    });
  } catch (e) {
    log('error', 'Snapshot write FAILED', { reason, e: String(e) });
  }
}

const saveSnapshot = debounce((reason) => writeSnapshot(reason), 600);

function persistNow(reason) {
  // synchronous, immediate
  writeSnapshot(reason);
}

function readSnapshotRaw() {
  try {
    return localStorage.getItem(SNAPSHOT_KEY);
  } catch (e) {
    log('error', 'Snapshot read FAILED (localStorage)', { e: String(e) });
    return null;
  }
}

function parseSnapshot(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj;
  } catch (e) {
    log('error', 'Snapshot JSON parse FAILED', { e: String(e), sample: String(raw).slice(0, 120) });
    return null;
  }
}

async function bootstrapFromLocalStorage(tag = 'bootstrap') {
  const raw = readSnapshotRaw();
  if (!raw) {
    log('info', 'No snapshot found in localStorage', { tag });
    return { loaded: false, imported: false, meta: null };
  }

  log('info', 'Snapshot found in localStorage', { tag, bytes: raw.length });

  const snap = parseSnapshot(raw);
  if (!snap) return { loaded: true, imported: false, meta: null };

  const meta = snapshotMeta(snap);
  lastSnapshotMeta = meta;
  log('info', 'Snapshot meta', { tag, meta, docBefore: docCounts() });

  try {
    importSnapshot(snap);
    log('info', 'Snapshot imported (merge-only)', { tag, docAfter: docCounts() });
    return { loaded: true, imported: true, meta };
  } catch (e) {
    log('error', 'Snapshot import FAILED', { tag, e: String(e) });
    return { loaded: true, imported: false, meta };
  }
}

// Flush points: refresh, tab hidden, iOS quirks, etc.
window.addEventListener('pagehide', () => persistNow('pagehide'));
window.addEventListener('beforeunload', () => persistNow('beforeunload'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistNow('visibility.hidden');
});

function exportSnapshot({ historyDays = 120 } = {}) {
  const tasks = [];
  yTasks.forEach((ytask, id) => {
    tasks.push({
      id,
      title: String(ytask.get('title') || ''),
      type: String(ytask.get('type') || 'daily'),
      createdAt: Number(ytask.get('createdAt') || 0),
      dueAt: ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt')),
      active: ytask.get('active') !== false,
      archivedAt: ytask.get('archivedAt') == null ? null : Number(ytask.get('archivedAt')),
      doneAt: ytask.get('doneAt') == null ? null : Number(ytask.get('doneAt')),
      templateKey: ytask.get('templateKey') == null ? null : String(ytask.get('templateKey')),
      completions: (() => {
        const m = ytask.get('completions');
        if (!(m instanceof Y.Map)) return {};
        const out = {};
        m.forEach((v, k) => { out[k] = !!v; });
        return out;
      })()
    });
  });

  const templates = {};
  yTemplates.forEach((yt, key) => {
    templates[key] = {
      title: String(yt.get('title') || ''),
      usageCount: Number(yt.get('usageCount') || 0),
      firstUsedAt: Number(yt.get('firstUsedAt') || 0),
      lastUsedAt: Number(yt.get('lastUsedAt') || 0),
      meanMinutes: Number(yt.get('meanMinutes') || 0),
      lastType: String(yt.get('lastType') || 'daily')
    };
  });

  const cutoffTs = Date.now() - historyDays * DAY_MS;
  const history = {};
  yHistory.forEach((ymap, dayKey) => {
    if (!(ymap instanceof Y.Map)) return;
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dayKey);
    if (!m) return;
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), BOUNDARY_HOUR, 0, 0, 0).getTime();
    if (ts < cutoffTs) return;
    const o = {};
    ymap.forEach((completedAt, taskId) => { o[taskId] = Number(completedAt || 0); });
    history[dayKey] = o;
  });

  return { v: 1, exportedAt: Date.now(), tasks, templates, history };
}

function importSnapshot(snapshot) {
  if (!snapshot || snapshot.v !== 1) throw new Error('Unsupported snapshot format');

  ydoc.transact(() => {
    if (snapshot.templates && typeof snapshot.templates === 'object') {
      for (const [key, t] of Object.entries(snapshot.templates)) {
        if (!key) continue;
        let yt = yTemplates.get(key);
        if (!(yt instanceof Y.Map)) {
          yt = new Y.Map();
          yTemplates.set(key, yt);
        }
        if (!yt.has('title')) yt.set('title', String(t.title || key));
        if (!yt.has('usageCount')) yt.set('usageCount', Number(t.usageCount || 0));
        if (!yt.has('firstUsedAt')) yt.set('firstUsedAt', Number(t.firstUsedAt || 0));
        if (!yt.has('lastUsedAt')) yt.set('lastUsedAt', Number(t.lastUsedAt || 0));
        if (!yt.has('meanMinutes')) yt.set('meanMinutes', Number(t.meanMinutes || 0));
        if (!yt.has('lastType')) yt.set('lastType', String(t.lastType || 'daily'));
      }
    }

    if (Array.isArray(snapshot.tasks)) {
      for (const t of snapshot.tasks) {
        if (!t || !t.id) continue;
        if (yTasks.has(t.id)) continue;
        const ytask = new Y.Map();
        ytask.set('id', String(t.id));
        ytask.set('title', String(t.title || ''));
        ytask.set('type', String(t.type || 'daily'));
        ytask.set('createdAt', Number(t.createdAt || Date.now()));
        ytask.set('dueAt', t.dueAt == null ? null : Number(t.dueAt));
        ytask.set('active', t.active !== false);
        ytask.set('archivedAt', t.archivedAt == null ? null : Number(t.archivedAt));
        ytask.set('doneAt', t.doneAt == null ? null : Number(t.doneAt));
        ytask.set('templateKey', t.templateKey == null ? null : String(t.templateKey));
        const comps = new Y.Map();
        if (t.completions && typeof t.completions === 'object') {
          for (const [k, v] of Object.entries(t.completions)) comps.set(k, !!v);
        }
        ytask.set('completions', comps);
        yTasks.set(String(t.id), ytask);
      }
    }

    if (snapshot.history && typeof snapshot.history === 'object') {
      for (const [dayKey, map] of Object.entries(snapshot.history)) {
        if (!map || typeof map !== 'object') continue;
        let ymap = yHistory.get(dayKey);
        if (!(ymap instanceof Y.Map)) {
          ymap = new Y.Map();
          yHistory.set(dayKey, ymap);
        }
        for (const [taskId, completedAt] of Object.entries(map)) {
          if (!taskId) continue;
          if (!ymap.has(taskId)) ymap.set(taskId, Number(completedAt || 0));
        }
      }
    }
  });
  persistNow('importSnapshot');
}

/* ---------------------------- Sync connect ---------------------------- */
function updateSyncBadge() {
  const peers = provider ? Math.max(0, provider.awareness.getStates().size - 1) : 0;
  els.peersCount.textContent = String(peers);

  els.syncPill.classList.toggle('offline', !provider);
  els.syncPill.classList.toggle('online', !!provider);

  const label = provider ? 'Sync: on' : 'Sync: off';
  const labelSpan = els.syncPill.querySelector('span:nth-child(2)');
  if (labelSpan) labelSpan.textContent = label;
}

async function connectSync() {
  const room = (els.roomInput.value || '').trim();
  const enc = (els.encInput.value || '').trim();
  const sigRaw = (els.sigInput.value || '').trim();
  const turnKey = (els.turnKeyInput.value || '').trim();

  const sig = parseSignalingList(sigRaw);
  const signaling = sig.length ? sig : DEFAULT_SIGNALING;

  if (!room) { toast('Connect key cannot be empty'); return; }
  if (!enc) { toast('Encryption key cannot be empty'); return; }

  // Persist to localStorage + URL
  localStorage.setItem(LS_ROOM, room);
  localStorage.setItem(LS_ENC, enc);

  if (sigRaw) localStorage.setItem(LS_SIG, sigRaw);
  else localStorage.removeItem(LS_SIG);

  if (turnKey) localStorage.setItem(LS_TURN, turnKey);
  else localStorage.removeItem(LS_TURN);

  writeQuery({ room, enc, sig: sigRaw, turnKey });

  // Fetch ICE servers (TURN if provided)
  const iceServers = await getIceServers(turnKey);

  // Reconnect provider
  if (provider) {
    try { provider.destroy(); } catch {}
    provider = null;
  }

  provider = new WebrtcProvider(room, ydoc, {
    // Encrypt signaling messages sent via the signaling server(s)
    password: enc,
    signaling,
    peerOpts: {
      config: { iceServers }
    }
  });

  provider.awareness.on('change', () => {
    updateSyncBadge();
    scheduleRender();
  });

  updateSyncBadge();

  if (turnKey) toast('Using Metered TURN for ICE');
  else toast('Using STUN-only ICE');
}

/* -------------------------- Task + template ops ------------------------ */
function ensureTask(id) {
  const ytask = yTasks.get(id);
  return ytask instanceof Y.Map ? ytask : null;
}

function ensureMapField(ytask, field) {
  const got = ytask.get(field);
  if (got instanceof Y.Map) return got;
  const m = new Y.Map();
  ytask.set(field, m);
  return m;
}

function ensureDayHistory(dayKey) {
  const got = yHistory.get(dayKey);
  if (got instanceof Y.Map) return got;
  const m = new Y.Map();
  yHistory.set(dayKey, m);
  return m;
}

function touchTemplate(title, typeHint = 'daily', dueAt = null) {
  const key = normalizeTitle(title);
  if (!key) return null;

  let yt = yTemplates.get(key);
  if (!(yt instanceof Y.Map)) {
    yt = new Y.Map();
    yTemplates.set(key, yt);
    yt.set('title', title.trim());
    yt.set('usageCount', 0);
    yt.set('firstUsedAt', Date.now());
    yt.set('meanMinutes', minutesOfDay());
    yt.set('lastType', typeHint);
  }

  const now = Date.now();
  yt.set('usageCount', Number(yt.get('usageCount') || 0) + 1);
  yt.set('lastUsedAt', now);
  yt.set('lastType', typeHint);

  const usedMinutes = minutesOfDay(dueAt ?? now);
  const mean = Number(yt.get('meanMinutes') || usedMinutes);
  const alpha = 0.20; // EMA
  yt.set('meanMinutes', (mean * (1 - alpha)) + (usedMinutes * alpha));

  return key;
}

function addTaskFromUI() {
  const title = els.titleInput.value.trim();
  if (!title) return;

  const type = els.typeScheduled.checked ? 'scheduled' : 'daily';
  let dueAt = null;

  if (type === 'scheduled') {
    dueAt = parseDatetimeLocalValue(els.dueInput.value);
    if (!dueAt) {
      const now = Date.now();
      const rounded = Math.ceil((now + 30 * 60000) / (5 * 60000)) * (5 * 60000);
      dueAt = rounded;
      els.dueInput.value = toDatetimeLocalValue(dueAt);
    }
  }

  const id = crypto.randomUUID();

  ydoc.transact(() => {
    const ytask = new Y.Map();
    ytask.set('id', id);
    ytask.set('title', title);
    ytask.set('type', type);
    ytask.set('createdAt', Date.now());
    ytask.set('dueAt', dueAt);
    ytask.set('active', true);
    ytask.set('archivedAt', null);
    ytask.set('doneAt', null);
    ytask.set('completions', new Y.Map());
    ytask.set('templateKey', touchTemplate(title, type, dueAt));
    yTasks.set(id, ytask);
  });
  persistNow('addTaskFromUI');

  els.titleInput.value = '';
  els.titleInput.focus();
  renderSuggestions();
}

function toggleCompletion(id, checked) {
  const dayKey = logicalDayKey();

  ydoc.transact(() => {
    const ytask = ensureTask(id);
    if (!ytask) return;

    const type = String(ytask.get('type') || 'daily');
    const completions = ensureMapField(ytask, 'completions');
    const dayHist = ensureDayHistory(dayKey);

    if (checked) {
      completions.set(dayKey, true);
      dayHist.set(id, Date.now());
      if (type === 'scheduled') ytask.set('doneAt', Date.now());
    } else {
      completions.delete(dayKey);
      dayHist.delete(id);
      if (type === 'scheduled') ytask.set('doneAt', null);
    }
  });
  persistNow('toggleCompletion');
}

function archiveTask(id) {
  ydoc.transact(() => {
    const ytask = ensureTask(id);
    if (!ytask) return;
    ytask.set('archivedAt', Date.now());
  });
  persistNow('archiveTask');
}

function renameTask(id, newTitle) {
  const title = (newTitle || '').trim();
  if (!title) return;

  ydoc.transact(() => {
    const ytask = ensureTask(id);
    if (!ytask) return;
    ytask.set('title', title);
    const type = String(ytask.get('type') || 'daily');
    const dueAt = ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt'));
    ytask.set('templateKey', touchTemplate(title, type, dueAt));
  });
  persistNow('renameTask');
}

function setTaskActive(id, active) {
  ydoc.transact(() => {
    const ytask = ensureTask(id);
    if (!ytask) return;
    ytask.set('active', !!active);
  });
  persistNow('setTaskActive');
}

/* ------------------------- Suggestion ranking -------------------------- */
function rebuildTemplateIndex() {
  const list = [];
  yTemplates.forEach((yt, key) => {
    if (!(yt instanceof Y.Map)) return;
    list.push({
      key,
      title: String(yt.get('title') || key),
      usageCount: Number(yt.get('usageCount') || 0),
      firstUsedAt: Number(yt.get('firstUsedAt') || 0),
      lastUsedAt: Number(yt.get('lastUsedAt') || 0),
      meanMinutes: Number(yt.get('meanMinutes') || 0),
      lastType: String(yt.get('lastType') || 'daily'),
    });
  });

  templateIndex = list;
  fuse = new Fuse(list, {
    keys: ['title'],
    includeScore: true,
    threshold: 0.42,
    ignoreLocation: true,
    minMatchCharLength: 1,
  });
}

function suggestionScore(item, fuseScore, nowTs) {
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

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSuggestions() {
  const q = els.titleInput.value.trim();
  if (!fuse) rebuildTemplateIndex();
  const now = Date.now();

  let candidates = [];
  if (!q) {
    candidates = templateIndex
      .map(item => ({ item, score: suggestionScore(item, 0.65, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  } else {
    candidates = fuse.search(q, { limit: 20 })
      .map(r => ({ item: r.item, score: suggestionScore(r.item, r.score, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  els.suggestions.innerHTML = candidates.map(({ item }) => {
    const usage = item.usageCount ? `· used ${item.usageCount}×` : '';
    const last = item.lastUsedAt ? `· last ${formatDateTime(item.lastUsedAt)}` : '';
    const time = `· ~${pad2(Math.floor(item.meanMinutes / 60))}:${pad2(Math.round(item.meanMinutes % 60))}`;
    return `
      <div class="sugg" data-skey="${escapeHtml(item.key)}" title="Click to use">
        <div class="sugg-title">${escapeHtml(item.title)}</div>
        <div class="sugg-meta">${escapeHtml(item.lastType)} ${usage} ${last} ${time}</div>
      </div>
    `;
  }).join('');
}

/* ------------------------------ Rendering ------------------------------ */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function taskPlain(ytask) {
  return {
    id: String(ytask.get('id')),
    title: String(ytask.get('title') || ''),
    type: String(ytask.get('type') || 'daily'),
    dueAt: ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt')),
    active: ytask.get('active') !== false,
    archivedAt: ytask.get('archivedAt') == null ? null : Number(ytask.get('archivedAt')),
    completions: ytask.get('completions')
  };
}

function isCompletedToday(task, dayKey) {
  const m = task.completions;
  return (m instanceof Y.Map) ? !!m.get(dayKey) : false;
}

function renderTaskRow(t, dayKey, opts = {}) {
  const completed = isCompletedToday(t, dayKey);
  const due = t.type === 'scheduled' && t.dueAt ? `<span class="time">${escapeHtml(formatDateTime(t.dueAt))}</span>` : '';
  const badge = t.type === 'scheduled' ? '<span class="tag">scheduled</span>' : '<span class="tag">daily</span>';
  const upcomingHint = opts.upcoming ? '<span class="tag">upcoming</span>' : '';
  const titleCls = `title ${completed ? 'done' : ''}`;

  return `
    <div class="task" data-id="${escapeHtml(t.id)}">
      <label class="check">
        <input type="checkbox" class="toggle" ${completed ? 'checked' : ''} />
        <span></span>
      </label>
      <div class="main">
        <div class="rowline">
          <div class="${titleCls}" title="Double-click to rename">${escapeHtml(t.title)}</div>
          ${due}
        </div>
        <div class="meta">${badge} ${upcomingHint}</div>
      </div>
      <div class="actions">
        ${t.type === 'daily' ? `<button class="chip act" data-act="${t.active ? 'deactivate' : 'activate'}">${t.active ? 'Hide' : 'Show'}</button>` : ''}
        <button class="chip" data-act="archive">Archive</button>
      </div>
    </div>
  `;
}

function renderHistory(daysBack = 7) {
  const now = Date.now();
  const out = [];

  for (let i = 0; i < daysBack; i++) {
    const dayKey = logicalDayKey(now - i * DAY_MS);
    const m = yHistory.get(dayKey);
    const entries = (m instanceof Y.Map) ? [...m.entries()] : [];
    entries.sort((a, b) => Number(a[1]) - Number(b[1]));

    const titles = entries.map(([taskId]) => {
      const ytask = yTasks.get(taskId);
      return (ytask instanceof Y.Map) ? String(ytask.get('title') || '(untitled)') : '(missing task)';
    });

    out.push(`
      <div class="history-day">
        <div class="history-head">
          <div class="history-date">${escapeHtml(dayKey)}</div>
          <div class="history-count">${entries.length} done</div>
        </div>
        ${entries.length
          ? `<div class="history-items">${titles.map(t => `<span class="history-item">${escapeHtml(t)}</span>`).join('')}</div>`
          : `<div class="empty">No completions logged.</div>`
        }
      </div>
    `);
  }

  return out.join('');
}

function render() {
  const now = Date.now();
  const dayKey = logicalDayKey(now);
  els.dayLabel.textContent = `Day: ${dayKey} (resets 03:00 local)`;
  updateSyncBadge();

  const daily = [];
  const scheduledDue = [];
  const scheduledUpcoming = [];

  yTasks.forEach((ytask) => {
    if (!(ytask instanceof Y.Map)) return;
    const t = taskPlain(ytask);
    if (t.archivedAt) return;

    if (t.type === 'daily') {
      if (t.active) daily.push(t);
    } else {
      const dueAt = t.dueAt || 0;
      if (dueAt <= now) scheduledDue.push(t);
      else scheduledUpcoming.push(t);
    }
  });

  daily.sort((a, b) => {
    const ca = isCompletedToday(a, dayKey) ? 1 : 0;
    const cb = isCompletedToday(b, dayKey) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return a.title.localeCompare(b.title);
  });
  scheduledDue.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  scheduledUpcoming.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));

  const todayHtml = [];
  if (daily.length) {
    todayHtml.push(`<div class="section-title">Daily</div>`);
    todayHtml.push(daily.map(t => renderTaskRow(t, dayKey)).join(''));
  }
  if (scheduledDue.length) {
    todayHtml.push(`<div class="section-title">Due now</div>`);
    todayHtml.push(scheduledDue.map(t => renderTaskRow(t, dayKey)).join(''));
  }
  if (!todayHtml.length) todayHtml.push(`<div class="empty">No tasks yet. Add one above 👆</div>`);
  els.todayList.innerHTML = todayHtml.join('');

  els.upcomingCount.textContent = String(scheduledUpcoming.length);
  els.upcomingList.innerHTML = scheduledUpcoming.length
    ? scheduledUpcoming.map(t => renderTaskRow(t, dayKey, { upcoming: true })).join('')
    : `<div class="empty">Nothing scheduled.</div>`;

  els.historyList.innerHTML = renderHistory(7);
  renderSuggestions();
}

/* ------------------------------ Events -------------------------------- */
function setDueEnabled() {
  const scheduled = els.typeScheduled.checked;
  els.dueInput.disabled = !scheduled;
  els.dueInput.style.opacity = scheduled ? '1' : '0.55';
  if (scheduled && !els.dueInput.value) {
    const now = Date.now();
    const rounded = Math.ceil((now + 30 * 60000) / (5 * 60000)) * (5 * 60000);
    els.dueInput.value = toDatetimeLocalValue(rounded);
  }
}

els.typeDaily.addEventListener('change', () => { setDueEnabled(); renderSuggestions(); });
els.typeScheduled.addEventListener('change', () => { setDueEnabled(); renderSuggestions(); });
els.titleInput.addEventListener('input', renderSuggestions);
els.titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addTaskFromUI(); }
});
els.addBtn.addEventListener('click', addTaskFromUI);

els.suggestions.addEventListener('click', (e) => {
  const el = e.target.closest('.sugg');
  if (!el) return;
  const key = el.getAttribute('data-skey');
  const item = templateIndex.find(x => x.key === key);
  if (!item) return;

  els.titleInput.value = item.title;
  if (item.lastType === 'scheduled') {
    els.typeScheduled.checked = true; els.typeDaily.checked = false;
  } else {
    els.typeDaily.checked = true; els.typeScheduled.checked = false;
  }
  setDueEnabled();
  renderSuggestions();
  els.titleInput.focus();
  els.titleInput.setSelectionRange(0, els.titleInput.value.length);
});

function onTaskListEvent(e) {
  const taskEl = e.target.closest('.task');
  if (!taskEl) return;
  const id = taskEl.getAttribute('data-id');

  if (e.target.classList.contains('toggle')) {
    toggleCompletion(id, e.target.checked);
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'archive') archiveTask(id);
  if (act === 'activate') setTaskActive(id, true);
  if (act === 'deactivate') setTaskActive(id, false);
}
els.todayList.addEventListener('click', onTaskListEvent);
els.upcomingList.addEventListener('click', onTaskListEvent);

function onDblClickRename(e) {
  const titleEl = e.target.closest('.title');
  const taskEl = e.target.closest('.task');
  if (!titleEl || !taskEl) return;
  const id = taskEl.getAttribute('data-id');
  const current = titleEl.textContent || '';
  const next = prompt('Rename task:', current);
  if (next == null) return;
  renameTask(id, next);
}
els.todayList.addEventListener('dblclick', onDblClickRename);
els.upcomingList.addEventListener('dblclick', onDblClickRename);

els.reconnectBtn.addEventListener('click', async () => {
  await connectSync();
});

els.copyLinkBtn.addEventListener('click', async () => {
  const room = (els.roomInput.value || '').trim();
  const enc = (els.encInput.value || '').trim();
  const sig = (els.sigInput.value || '').trim();
  const turnKey = (els.turnKeyInput.value || '').trim();

  if (room && enc) writeQuery({ room, enc, sig, turnKey });

  const link = window.location.href;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied');
  } catch {
    prompt('Copy this link:', link);
  }
});

els.exportBtn.addEventListener('click', () => {
  const snapshot = exportSnapshot({ historyDays: 999999 });
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `daylist-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

els.importFile.addEventListener('change', async () => {
  const f = els.importFile.files?.[0];
  if (!f) return;
  const text = await f.text();
  try { importSnapshot(JSON.parse(text)); toast('Imported'); }
  catch { toast('Import failed (invalid JSON)'); }
  finally { els.importFile.value = ''; }
});

els.wipeBtn.addEventListener('click', async () => {
  const ok = confirm('This will delete ALL local data (IndexedDB + localStorage mirror). Continue?');
  if (!ok) return;

  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(LS_METERED_ICE_CACHE);
    await persistence.clearData();
    ydoc.transact(() => { yTasks.clear(); yTemplates.clear(); yHistory.clear(); });
    persistNow('wipe');
    toast('Wiped');
  } catch { toast('Wipe failed'); }
});

/* ------------------------------ Toasts -------------------------------- */
let toastTimer = null;
function toast(msg) {
  const host = $('toastHost');
  host.textContent = String(msg);
  host.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), 2400);
}

/* ------------------------------ Wiring -------------------------------- */
function setDefaultsAndHydrateInputs() {
  setDueEnabled();
  ensureKeysInUrlAndInputs(els);
  els.dayLabel.textContent = `Day: ${logicalDayKey()} (resets 03:00 local)`;
}

ydoc.on('update', (update, origin) => {
  const bytes = update?.byteLength ?? null;
  const originName =
    origin == null ? 'null' :
    (typeof origin === 'string' ? origin :
     origin.constructor?.name || typeof origin);

  log('info', 'Y.Doc update', {
    bytes,
    origin: originName,
    counts: docCounts(),
    hydrationComplete
  });

  rebuildTemplateIndex();
  scheduleRender();

  // Prevent the classic foot-gun: persisting an "empty boot doc" before we hydrate.
  if (hydrationComplete) saveSnapshot('ydoc.update');
  else log('info', 'Skip snapshot save (hydration not complete yet)', { bytes, origin: originName });
});

setInterval(() => scheduleRender(), 30 * 1000);

(async function main() {
  setDefaultsAndHydrateInputs();

  // Loud startup logs so you can diagnose "why did it forget?"
  await storageDiagnostics();

  log('info', 'BOOT: start', { counts: docCounts() });

  // 1) Restore ASAP from localStorage snapshot so refresh never shows empty if we have a backup.
  await bootstrapFromLocalStorage('boot.pre-idb');

  // 2) Wait for IndexedDB (Yjs) to load, but DO NOT hang forever if IDB is blocked.
  try {
    const IDB_TIMEOUT_MS = 4000;
    const timed = await Promise.race([
      persistence.whenSynced.then(() => 'synced'),
      new Promise((r) => setTimeout(() => r('timeout'), IDB_TIMEOUT_MS))
    ]);
    log('info', 'IndexedDB persistence.whenSynced result', { timed, counts: docCounts() });
  } catch (e) {
    log('error', 'IndexedDB persistence.whenSynced FAILED', { e: String(e) });
  }

  // 3) Re-apply snapshot after IDB too (merge-only, idempotent). Helps if IDB is empty/blocked.
  await bootstrapFromLocalStorage('boot.post-idb');

  // From here on, updates are “real” and safe to persist.
  hydrationComplete = true;
  persistNow('boot.finalize');

  rebuildTemplateIndex();

  await connectSync();
  render();

  log('info', 'BOOT: ready', { counts: docCounts(), lastSnapshotMeta });
  toast('Ready');
})();
