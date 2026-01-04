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
import {
  BOUNDARY_HOUR,
  DAY_MS,
  debounce,
  errToObj,
  escapeHtml,
  formatDateTime,
  localDateKeyFrom,
  logicalDayKey,
  minutesOfDay,
  normalizeTitle,
  pad2,
  parseDatetimeLocalValue,
  parseSignalingList,
  randomKey,
  redact,
  suggestionScore,
  toDatetimeLocalValue,
  toJsonSafe
} from './core.js';
import { buildTodaySections } from './todayView.js';

/* ------------------------------ Utilities ------------------------------ */
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

/* ------------------------- Debug + Persistence Logs ------------------------- */

// Toggle verbose logging via:
//   ?debug=1   (URL)
// or
//   localStorage.setItem('daylist.debug.enabled', '1')
const LS_DEBUG_ENABLED = 'daylist.debug.enabled';
const LS_DEBUG_LOG = 'daylist.debug.log.v1';
const DEBUG_LOG_MAX = 600;

function safeGetLS(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSetLS(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemoveLS(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

function isDebugEnabled() {
  try {
    const url = new URL(location.href);
    const q = (url.searchParams.get('debug') || '').trim();
    if (q) return q === '1' || q.toLowerCase() === 'true';
  } catch {}
  return (safeGetLS(LS_DEBUG_ENABLED) || '').trim() === '1';
}

const DEBUG = isDebugEnabled();

// Persistent console-ish log buffer so you can inspect what happened after refresh.
let __dlLogBuf = (() => {
  try {
    const raw = safeGetLS(LS_DEBUG_LOG);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
})();


const flushDebugLog = debounce(() => {
  try { safeSetLS(LS_DEBUG_LOG, JSON.stringify(__dlLogBuf.slice(-DEBUG_LOG_MAX))); } catch {}
}, 250);

function log(event, data = null, level = 'INFO') {
  const entry = {
    t: Date.now(),
    iso: new Date().toISOString(),
    level,
    event,
    data: toJsonSafe(data)
  };

  // Always store to buffer if DEBUG; optionally you can store always by removing the if.
  if (DEBUG) {
    __dlLogBuf.push(entry);
    if (__dlLogBuf.length > DEBUG_LOG_MAX) __dlLogBuf = __dlLogBuf.slice(-DEBUG_LOG_MAX);
    flushDebugLog();

    // Console output (human friendly)
    const prefix = `[DayList] ${entry.iso} ${level} ${event}`;
    // Keep console logs readable: data only if present.
    if (data == null) console.log(prefix);
    else console.log(prefix, data);
  }
}

// Dump/copy logs quickly from DevTools:
window.daylistDebug = {
  enabled: DEBUG,
  getLogs: () => __dlLogBuf.slice(),
  clearLogs: () => { __dlLogBuf = []; safeRemoveLS(LS_DEBUG_LOG); },
  enable: () => { safeSetLS(LS_DEBUG_ENABLED, '1'); location.reload(); },
  disable: () => { safeRemoveLS(LS_DEBUG_ENABLED); location.reload(); }
};

// Catch silent failures (you had a lot of `catch(() => {})`):
window.addEventListener('error', (e) => {
  log('window:error', {
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    error: errToObj(e.error)
  }, 'ERROR');
});

window.addEventListener('unhandledrejection', (e) => {
  log('window:unhandledrejection', { reason: errToObj(e.reason) }, 'ERROR');
});

// One-time boot info
log('boot:env', {
  href: location.href,
  origin: location.origin,
  secureContext: !!window.isSecureContext,
  ua: navigator.userAgent
});

/* ----------------------------- PWA wiring ----------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => log('sw:registered', { scope: reg.scope }))
      .catch((e) => log('sw:register_failed', { error: errToObj(e) }, 'WARN'));
  });
} else {
  log('sw:unsupported');
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
    log('turn:cache_hit_fresh', { ageMs: Date.now() - cached.fetchedAt, count: cached.iceServers.length });
    return cached.iceServers;
  }

  // Fetch new credentials
  try {
    const res = await fetch(meteredUrl(key), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Metered fetch failed: ${res.status}`);
    const iceServers = await res.json();
    if (!isValidIceServers(iceServers)) throw new Error('Unexpected Metered response');
    saveMeteredIceCache(iceServers);
    log('turn:fetched_ice', {
      count: iceServers.length,
      sample: iceServers.slice(0, 2).map(s => ({ urls: s.urls }))
    });
    return iceServers;
  } catch (e) {
    // Fallback to cache even if stale, else STUN-only.
    if (cached && isValidIceServers(cached.iceServers)) {
      log('turn:fetch_failed_using_stale_cache', {
        error: errToObj(e),
        ageMs: Date.now() - cached.fetchedAt,
        count: cached.iceServers.length
      }, 'WARN');
      toast('TURN fetch failed; using cached TURN credentials');
      return cached.iceServers;
    }
    log('turn:fetch_failed_stun_only', { error: errToObj(e) }, 'WARN');
    toast('TURN fetch failed; falling back to STUN only');
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
    ];
  }
}

/* ------------------------------ Yjs setup ------------------------------ */
const ydoc = new Y.Doc();
let persistence = null;
let idbSynced = false;
let idbSyncedAt = 0;

try {
  persistence = new IndexeddbPersistence('daylist-v1', ydoc);
  log('idb:init_ok', { docName: 'daylist-v1' });

  // y-indexeddb fires "synced" when DB is connected and content loaded (even if empty).
  persistence.on('synced', () => {
    idbSynced = true;
    idbSyncedAt = Date.now();
    log('idb:synced', { at: idbSyncedAt });
  });
} catch (e) {
  // If IndexedDB is blocked/errored, you still want snapshot persistence to work.
  persistence = null;
  log('idb:init_failed', { error: errToObj(e) }, 'ERROR');
}

// Shared structures
const yTasks = ydoc.getMap('tasks');          // id -> Y.Map
const yTemplates = ydoc.getMap('templates');  // key -> Y.Map
const yHistory = ydoc.getMap('history');      // dayKey -> Y.Map(taskId -> completedAt)

function docCounts() {
  return {
    tasks: yTasks.size,
    templates: yTemplates.size,
    historyDays: yHistory.size
  };
}

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

let snapshotDirty = false;

function writeSnapshot(reason = 'unknown', { force = false } = {}) {
  // Only flush if something changed, unless it's an explicit lifecycle flush.
  const lifecycleFlush = reason === 'pagehide' || reason === 'beforeunload' || reason === 'visibility:hidden';
  if (!snapshotDirty && !force && !lifecycleFlush) return;

  try {
    const before = docCounts();
    const snapshot = exportSnapshot({ historyDays: 120 });
    const json = JSON.stringify(snapshot);

    const ok = safeSetLS(SNAPSHOT_KEY, json);

    snapshotDirty = false;

    log('snapshot:write', {
      reason,
      ok,
      bytes: json.length,
      exportedAt: snapshot.exportedAt,
      counts: {
        tasks: snapshot.tasks?.length || 0,
        templates: snapshot.templates ? Object.keys(snapshot.templates).length : 0,
        historyDays: snapshot.history ? Object.keys(snapshot.history).length : 0
      },
      beforeDoc: before,
      afterDoc: docCounts()
    }, ok ? 'INFO' : 'WARN');
  } catch (e) {
    log('snapshot:write_failed', { reason, error: errToObj(e) }, 'ERROR');
  }
}

// Faster than 800ms, and we also have an interval safety net.
const saveSnapshot = debounce(() => writeSnapshot('debounced'), 250);

// Flush on more lifecycle signals (pagehide is good, but not always enough on mobile/PWA)
window.addEventListener('pagehide', () => writeSnapshot('pagehide'));
window.addEventListener('beforeunload', () => writeSnapshot('beforeunload'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) writeSnapshot('visibility:hidden');
});

// Safety net: if updates keep streaming in and debounce never fires, flush periodically
setInterval(() => writeSnapshot('interval'), 10_000);

async function bootstrapFromLocalStorage() {
  const raw = safeGetLS(SNAPSHOT_KEY);
  if (!raw) {
    log('snapshot:boot_none');
    return false;
  }

  try {
    const obj = JSON.parse(raw);
    const before = docCounts();

    log('snapshot:boot_found', {
      bytes: raw.length,
      exportedAt: obj?.exportedAt,
      v: obj?.v,
      snapshotCounts: {
        tasks: Array.isArray(obj?.tasks) ? obj.tasks.length : 0,
        templates: obj?.templates ? Object.keys(obj.templates).length : 0,
        historyDays: obj?.history ? Object.keys(obj.history).length : 0
      }
    });

    importSnapshot(obj);

    log('snapshot:boot_imported', { beforeDoc: before, afterDoc: docCounts() });
    return true;
  } catch (e) {
    log('snapshot:boot_failed', { error: errToObj(e) }, 'ERROR');
    return false;
  }
}

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
  writeSnapshot('importSnapshot', { force: true });
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
  writeSnapshot('addTaskFromUI', { force: true });

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
  writeSnapshot('toggleCompletion', { force: true });
}

function archiveTask(id) {
  ydoc.transact(() => {
    const ytask = ensureTask(id);
    if (!ytask) return;
    ytask.set('archivedAt', Date.now());
  });
  writeSnapshot('archiveTask', { force: true });
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
  writeSnapshot('renameTask', { force: true });
}

function setTaskActive(id, active) {
  ydoc.transact(() => {
    const ytask = ensureTask(id);
    if (!ytask) return;
    ytask.set('active', !!active);
  });
  writeSnapshot('setTaskActive', { force: true });
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

  const tasks = [];
  yTasks.forEach((ytask) => {
    if (!(ytask instanceof Y.Map)) return;
    tasks.push(taskPlain(ytask));
  });

  const { todayHtml, upcomingHtml, upcomingCount } = buildTodaySections(tasks, now);

  els.todayList.innerHTML = todayHtml;
  els.upcomingCount.textContent = String(upcomingCount);
  els.upcomingList.innerHTML = upcomingHtml;

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

  log('wipe:begin');

  try {
    safeRemoveLS(SNAPSHOT_KEY);
    safeRemoveLS(LS_METERED_ICE_CACHE);

    // Optional: also clear persisted debug logs
    // safeRemoveLS(LS_DEBUG_LOG);

    if (persistence?.clearData) {
      await persistence.clearData();
      log('wipe:idb_cleared');
    } else {
      log('wipe:idb_not_available', null, 'WARN');
    }

    ydoc.transact(() => { yTasks.clear(); yTemplates.clear(); yHistory.clear(); });
    log('wipe:ydoc_cleared', { counts: docCounts() });
    toast('Wiped');
    log('wipe:done');
  } catch (e) {
    log('wipe:failed', { error: errToObj(e) }, 'ERROR');
    toast('Wipe failed');
  }
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
  snapshotDirty = true;

  const originName =
    origin == null ? 'null' :
    (typeof origin === 'string' ? origin :
      (origin.constructor?.name || typeof origin));

  log('ydoc:update', {
    updateBytes: update?.length ?? null,
    origin: originName,
    counts: docCounts()
  }, 'INFO');

  rebuildTemplateIndex();
  scheduleRender();
  saveSnapshot();
});

ydoc.on('afterTransaction', (tr) => {
  // Avoid spewing if DEBUG isn't enabled.
  if (!DEBUG) return;

  const originName =
    tr?.origin == null ? 'null' :
    (typeof tr.origin === 'string' ? tr.origin :
      (tr.origin?.constructor?.name || typeof tr.origin));

  const changed = [];
  try {
    tr.changed.forEach((subs, type) => {
      const keyCount = subs?.size ?? 0;
      let typeName = type?.constructor?.name || 'Type';
      // label your known root maps
      if (type === yTasks) typeName = 'yTasks';
      if (type === yTemplates) typeName = 'yTemplates';
      if (type === yHistory) typeName = 'yHistory';
      changed.push({ type: typeName, keyCount });
    });
  } catch {}

  log('ydoc:afterTransaction', {
    local: !!tr.local,
    origin: originName,
    changed
  }, 'DEBUG');
});

setInterval(() => scheduleRender(), 30 * 1000);

(async function main() {
  setDefaultsAndHydrateInputs();

  // Log storage status
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      log('storage:estimate', { usage: est.usage, quota: est.quota });
    }
    if (navigator.storage?.persisted) {
      const persisted = await navigator.storage.persisted();
      log('storage:persisted', { persisted });
    }
  } catch (e) {
    log('storage:estimate_failed', { error: errToObj(e) }, 'WARN');
  }

  // Wait for IndexedDB to load (if available). Use the documented "synced" event.
  if (persistence) {
    log('idb:waiting_for_synced');
    await new Promise((resolve) => {
      if (idbSynced) return resolve(true);
      const handler = () => {
        try { persistence.off('synced', handler); } catch {}
        resolve(true);
      };
      persistence.on('synced', handler);
    });

    log('idb:ready', { at: idbSyncedAt, counts: docCounts() });

    // Small meta-write to prove the DB is actually writable.
    try {
      const prev = await persistence.get?.('meta:lastRunAt');
      log('idb:meta_read', { prev });
      await persistence.set?.('meta:lastRunAt', Date.now());
      log('idb:meta_write_ok');
    } catch (e) {
      log('idb:meta_write_failed', { error: errToObj(e) }, 'WARN');
    }
  } else {
    log('idb:disabled_using_snapshot_only', null, 'WARN');
  }

  // Now bootstrap the snapshot mirror (safe additive import).
  await bootstrapFromLocalStorage();

  rebuildTemplateIndex();
  await connectSync();
  render();
  toast('Ready');
})();
