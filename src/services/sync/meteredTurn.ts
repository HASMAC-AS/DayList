import { errToObj, toJsonSafe } from '../../lib/core';

const METERED_TURN_ENDPOINT =
  'https://dac1ee5f-99c1-46e6-8497-bcde3d533904.metered.live/api/v1/turn/credentials';
const METERED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LS_METERED_ICE_CACHE = 'daylist.meteredIceCache.v1';

const STUN_FALLBACK: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
];

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
    return STUN_FALLBACK;
  }

  const key = (opts.turnKey || '').trim();
  if (!key) return STUN_FALLBACK;

  const cached = loadMeteredIceCache(opts.storage);
  const age = cached ? opts.now() - cached.fetchedAt : null;

  if (cached && age != null && age < METERED_CACHE_TTL_MS && isValidIceServers(cached.iceServers)) {
    opts.log?.('turn:cache_hit_fresh', { ageMs: age, count: cached.iceServers.length });
    return cached.iceServers;
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
    return iceServers;
  } catch (e) {
    if (cached && isValidIceServers(cached.iceServers)) {
      opts.log?.(
        'turn:fetch_failed_using_stale_cache',
        { error: toJsonSafe(errToObj(e)), ageMs: age, count: cached.iceServers.length },
        'WARN'
      );
      return cached.iceServers;
    }
    opts.log?.('turn:fetch_failed_stun_only', { error: toJsonSafe(errToObj(e)) }, 'WARN');
    return STUN_FALLBACK;
  }
}
