import { errToObj, toJsonSafe } from '../../lib/core';

const METERED_TURN_ENDPOINT =
  'https://dac1ee5f-99c1-46e6-8497-bcde3d533904.metered.live/api/v1/turn/credentials';
const METERED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LS_METERED_ICE_CACHE = 'daylist.meteredIceCache.v1';

const STUN_FALLBACK: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const VALID_SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:'];

const normalizeIceServers = (servers: RTCIceServer[]) =>
  servers
    .map((server) => {
      if (!server || typeof server !== 'object') return null;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const cleaned = urls.filter((url) => typeof url === 'string' && VALID_SCHEMES.some((s) => url.startsWith(s)));
      if (!cleaned.length) return null;
      return {
        ...server,
        urls: cleaned
      } as RTCIceServer;
    })
    .filter((server): server is RTCIceServer => !!server);

function meteredUrl(apiKey: string) {
  const u = new URL(METERED_TURN_ENDPOINT);
  u.searchParams.set('apiKey', apiKey);
  return u.toString();
}

function isValidIceServers(arr: unknown): arr is RTCIceServer[] {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.every((x) => x && (typeof (x as RTCIceServer).urls === 'string' || Array.isArray((x as RTCIceServer).urls)));
}

function loadMeteredIceCache(storage: Storage) {
  try {
    const raw = storage.getItem(LS_METERED_ICE_CACHE);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj.iceServers)) return null;
    if (typeof obj.fetchedAt !== 'number') return null;
    return obj as { fetchedAt: number; iceServers: RTCIceServer[] };
  } catch {
    return null;
  }
}

function saveMeteredIceCache(storage: Storage, iceServers: RTCIceServer[], now: number) {
  try {
    storage.setItem(
      LS_METERED_ICE_CACHE,
      JSON.stringify({
        fetchedAt: now,
        iceServers
      })
    );
  } catch {
    // ignore
  }
}

export type MeteredIceCache = { fetchedAt: number; iceServers: RTCIceServer[] };

export function loadCachedIce(storage: Storage): MeteredIceCache | null {
  return loadMeteredIceCache(storage);
}

export function isFresh(cache: MeteredIceCache, now: number) {
  return now - cache.fetchedAt < METERED_CACHE_TTL_MS;
}

export function getStunFallback() {
  return normalizeIceServers(STUN_FALLBACK);
}

type TurnFetchResult = {
  iceServers: RTCIceServer[];
  source: 'turn-cache-fresh' | 'turn-fetch' | 'turn-cache-stale' | 'turn-fetch-failed';
  fetchedAt: number;
};

const fetchTurnIce = async (opts: {
  turnKey: string;
  fetchFn: typeof fetch;
  storage: Storage;
  now: () => number;
  log?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR') => void;
}): Promise<TurnFetchResult> => {
  const key = (opts.turnKey || '').trim();
  const cached = loadMeteredIceCache(opts.storage);
  const age = cached ? opts.now() - cached.fetchedAt : null;

  if (cached && age != null && age < METERED_CACHE_TTL_MS && isValidIceServers(cached.iceServers)) {
    opts.log?.('turn:cache_hit_fresh', { ageMs: age, count: cached.iceServers.length });
    const sanitized = normalizeIceServers(cached.iceServers);
    if (!sanitized.length) {
      opts.log?.('turn:cache_invalid_fallback', { ageMs: age }, 'WARN');
      return { iceServers: getStunFallback(), source: 'turn-fetch-failed', fetchedAt: opts.now() };
    }
    return { iceServers: sanitized, source: 'turn-cache-fresh', fetchedAt: cached.fetchedAt };
  }

  try {
    const res = await opts.fetchFn(meteredUrl(key), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Metered fetch failed: ${res.status}`);
    const iceServers = await res.json();
    if (!isValidIceServers(iceServers)) throw new Error('Unexpected Metered response');
    saveMeteredIceCache(opts.storage, iceServers, opts.now());
    opts.log?.('turn:fetched_ice', {
      count: iceServers.length,
      sample: iceServers.slice(0, 2).map((s: RTCIceServer) => ({ urls: s.urls }))
    });
    const sanitized = normalizeIceServers(iceServers);
    if (!sanitized.length) {
      opts.log?.('turn:fetched_invalid_fallback', { count: iceServers.length }, 'WARN');
      return { iceServers: getStunFallback(), source: 'turn-fetch-failed', fetchedAt: opts.now() };
    }
    return { iceServers: sanitized, source: 'turn-fetch', fetchedAt: opts.now() };
  } catch (e) {
    if (cached && isValidIceServers(cached.iceServers)) {
      opts.log?.(
        'turn:fetch_failed_using_stale_cache',
        { error: toJsonSafe(errToObj(e)), ageMs: age, count: cached.iceServers.length },
        'WARN'
      );
      const sanitized = normalizeIceServers(cached.iceServers);
      if (!sanitized.length) {
        opts.log?.('turn:stale_invalid_fallback', { ageMs: age }, 'WARN');
        return { iceServers: getStunFallback(), source: 'turn-fetch-failed', fetchedAt: opts.now() };
      }
      return { iceServers: sanitized, source: 'turn-cache-stale', fetchedAt: cached.fetchedAt };
    }
    opts.log?.('turn:fetch_failed_stun_only', { error: toJsonSafe(errToObj(e)) }, 'WARN');
    return { iceServers: getStunFallback(), source: 'turn-fetch-failed', fetchedAt: opts.now() };
  }
};

export type IceFastResult = {
  initial: RTCIceServer[];
  initialSource: 'turn-cache' | 'stun-fallback' | 'stun-only';
  refresh?: Promise<{
    iceServers: RTCIceServer[];
    source: 'turn-fetch' | 'turn-cache-stale' | 'turn-fetch-failed';
    fetchedAt: number;
  }>;
};

export function getIceServersFast(opts: {
  turnKey: string;
  allowTurn?: boolean;
  fetchFn: typeof fetch;
  storage: Storage;
  now: () => number;
  log?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR') => void;
}): IceFastResult {
  if (opts.allowTurn === false) {
    opts.log?.('turn:skipped_stun_only');
    return { initial: getStunFallback(), initialSource: 'stun-only' };
  }

  const key = (opts.turnKey || '').trim();
  if (!key) return { initial: getStunFallback(), initialSource: 'stun-fallback' };

  const cached = loadMeteredIceCache(opts.storage);
  const now = opts.now();
  const age = cached ? now - cached.fetchedAt : null;
  if (cached && age != null && age < METERED_CACHE_TTL_MS && isValidIceServers(cached.iceServers)) {
    opts.log?.('turn:cache_hit_fresh', { ageMs: age, count: cached.iceServers.length });
    const sanitized = normalizeIceServers(cached.iceServers);
    if (sanitized.length) return { initial: sanitized, initialSource: 'turn-cache' };
    opts.log?.('turn:cache_invalid_fallback', { ageMs: age }, 'WARN');
  }

  const refresh = fetchTurnIce({
    turnKey: key,
    fetchFn: opts.fetchFn,
    storage: opts.storage,
    now: opts.now,
    log: opts.log
  }).then((result) => ({
    iceServers: result.iceServers,
    source:
      result.source === 'turn-cache-stale'
        ? 'turn-cache-stale'
        : result.source === 'turn-fetch'
          ? 'turn-fetch'
          : 'turn-fetch-failed',
    fetchedAt: result.fetchedAt
  }));

  return { initial: getStunFallback(), initialSource: 'stun-fallback', refresh };
}

export async function getIceServers(opts: {
  turnKey: string;
  allowTurn?: boolean;
  fetchFn: typeof fetch;
  storage: Storage;
  now: () => number;
  log?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR') => void;
}): Promise<RTCIceServer[]> {
  if (opts.allowTurn === false) {
    opts.log?.('turn:skipped_stun_only');
    return getStunFallback();
  }

  const key = (opts.turnKey || '').trim();
  if (!key) return getStunFallback();

  const result = await fetchTurnIce({
    turnKey: key,
    fetchFn: opts.fetchFn,
    storage: opts.storage,
    now: opts.now,
    log: opts.log
  });
  return result.iceServers;
}
