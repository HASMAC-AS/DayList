export interface SyncKeys {
  room: string;
  enc: string;
  sig: string;
  turnKey: string;
  turnEnabled: boolean;
}

const Q_ROOM = 'room';
const Q_ENC = 'enc';
const Q_SIG = 'sig';
const Q_TURN = 'turnKey';
const Q_TURN_ENABLED = 'turn';

const LS_ROOM = 'daylist.room.v1';
const LS_ENC = 'daylist.enc.v1';
const LS_SIG = 'daylist.sig.v1';
const LS_TURN = 'daylist.turnKey.v1';
const LS_TURN_ENABLED = 'daylist.turnEnabled.v1';
const LS_LEGACY_PW = 'daylist.pw.v1';

function parseBool(value: string | null) {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return undefined;
}

export function readKeysFromUrl(locationHref: string): Partial<SyncKeys> {
  try {
    const url = new URL(locationHref);
    const turnEnabled = parseBool(url.searchParams.get(Q_TURN_ENABLED));
    return {
      room: (url.searchParams.get(Q_ROOM) || '').trim(),
      enc: (url.searchParams.get(Q_ENC) || '').trim(),
      sig: (url.searchParams.get(Q_SIG) || '').trim(),
      turnKey: (url.searchParams.get(Q_TURN) || '').trim(),
      turnEnabled
    };
  } catch {
    return {};
  }
}

export function writeKeysToUrl(keys: Partial<SyncKeys>) {
  try {
    const url = buildUrlWithKeys(keys);
    history.replaceState({}, '', url);
  } catch {
    // ignore
  }
}

export function buildUrlWithKeys(keys: Partial<SyncKeys>, href: string = window.location.href) {
  const url = new URL(href);

  if (keys.room != null) url.searchParams.set(Q_ROOM, keys.room);
  if (keys.enc != null) url.searchParams.set(Q_ENC, keys.enc);

  if (keys.sig != null) {
    const clean = String(keys.sig).trim();
    if (clean) url.searchParams.set(Q_SIG, clean);
    else url.searchParams.delete(Q_SIG);
  }

  if (keys.turnKey != null) {
    const clean = String(keys.turnKey).trim();
    if (clean) url.searchParams.set(Q_TURN, clean);
    else url.searchParams.delete(Q_TURN);
  }

  if (keys.turnEnabled != null) {
    url.searchParams.set(Q_TURN_ENABLED, keys.turnEnabled ? '1' : '0');
  }

  return url.toString();
}

export function readKeysFromStorage(storage: Storage): Partial<SyncKeys> {
  try {
    const turnEnabled = parseBool(storage.getItem(LS_TURN_ENABLED));
    return {
      room: (storage.getItem(LS_ROOM) || '').trim(),
      enc: (storage.getItem(LS_ENC) || '').trim() || (storage.getItem(LS_LEGACY_PW) || '').trim(),
      sig: (storage.getItem(LS_SIG) || '').trim(),
      turnKey: (storage.getItem(LS_TURN) || '').trim(),
      turnEnabled
    };
  } catch {
    return {};
  }
}

export function persistKeysToStorage(storage: Storage, keys: SyncKeys) {
  try {
    storage.setItem(LS_ROOM, keys.room);
    storage.setItem(LS_ENC, keys.enc);
    storage.removeItem(LS_LEGACY_PW);

    if (keys.sig) storage.setItem(LS_SIG, keys.sig);
    else storage.removeItem(LS_SIG);

    if (keys.turnKey) storage.setItem(LS_TURN, keys.turnKey);
    else storage.removeItem(LS_TURN);

    storage.setItem(LS_TURN_ENABLED, keys.turnEnabled ? '1' : '0');
  } catch {
    // ignore
  }
}

export function resolveInitialKeys(opts: {
  href: string;
  storage: Storage;
  prompt?: (msg: string, initial: string) => string | null;
  randomKey: (bytes?: number) => string;
}): SyncKeys {
  const fromUrl = readKeysFromUrl(opts.href);
  const fromStorage = readKeysFromStorage(opts.storage);

  let room = fromUrl.room || fromStorage.room || '';
  let enc = fromUrl.enc || fromStorage.enc || '';
  const sig = fromUrl.sig || fromStorage.sig || '';
  const turnKey = fromUrl.turnKey || fromStorage.turnKey || '';
  const turnEnabled = fromUrl.turnEnabled ?? fromStorage.turnEnabled ?? true;

  if (!room) {
    const suggestion = `daylist-${opts.randomKey(6)}`;
    room = (opts.prompt?.('Connect key (room):', suggestion) || '').trim() || suggestion;
  }

  if (!enc) {
    const suggestion = opts.randomKey(12);
    enc = (opts.prompt?.('Encryption key (required):', suggestion) || '').trim() || suggestion;
  }

  const resolved = { room, enc, sig, turnKey, turnEnabled };
  persistKeysToStorage(opts.storage, resolved);
  writeKeysToUrl(resolved);
  return resolved;
}

export function resolveKeysStrict(opts: { href: string; storage: Storage }): SyncKeys {
  const fromUrl = readKeysFromUrl(opts.href);
  const fromStorage = readKeysFromStorage(opts.storage);

  const room = (fromUrl.room || fromStorage.room || '').trim();
  const enc = (fromUrl.enc || fromStorage.enc || '').trim();
  const sig = (fromUrl.sig || fromStorage.sig || '').trim();
  const turnKey = (fromUrl.turnKey || fromStorage.turnKey || '').trim();
  const turnEnabled = fromUrl.turnEnabled ?? fromStorage.turnEnabled ?? true;

  if (!room) throw new Error('Missing required sync key: room');
  if (!enc) throw new Error('Missing required sync key: enc');

  const resolved = { room, enc, sig, turnKey, turnEnabled };
  persistKeysToStorage(opts.storage, resolved);
  return resolved;
}
