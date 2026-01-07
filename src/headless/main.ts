import type { WebrtcProvider } from '../services/sync/webrtcProvider';
import { errToObj, parseSignalingList, redact } from '../lib/core';
import { DEFAULT_SIGNALING } from '../services/sync/defaults';
import { resolveKeysStrict } from '../services/sync/keys';
import { getPeerCount, type SignalingStatus } from '../services/sync/provider';
import { createSyncSession } from '../services/sync/session';
import { importSnapshot, loadSnapshotFromStorage } from '../services/sync/snapshot';
import { createYDoc, type YDocHandles } from '../services/sync/ydoc';

type HeadlessStatus = {
  startedAt: number;
  room: string;
  connected: boolean;
  peers: number;
  usingTurn: boolean;
  signaling: SignalingStatus[];
  lastError?: { message: string; stack?: string };
};

type HeadlessRuntime = {
  status: HeadlessStatus;
};

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const status: HeadlessStatus = {
  startedAt: Date.now(),
  room: '',
  connected: false,
  peers: 0,
  usingTurn: false,
  signaling: []
};

const runtime: HeadlessRuntime = { status };
const runtimeWindow = window as Window & { daylistHeadless?: HeadlessRuntime };
runtimeWindow.daylistHeadless = runtime;

const setStatus = (patch: Partial<HeadlessStatus>) => {
  Object.assign(status, patch);
};

const log = (event: string, data?: unknown, level: LogLevel = 'INFO') => {
  const prefix = `[DayList Headless] ${level} ${event}`;
  if (level === 'ERROR') {
    if (data == null) console.error(prefix);
    else console.error(prefix, data);
    return;
  }
  if (level === 'WARN') {
    if (data == null) console.warn(prefix);
    else console.warn(prefix, data);
    return;
  }
  if (data == null) console.log(prefix);
  else console.log(prefix, data);
};

const setFatal = (error: unknown, message?: string) => {
  const err = errToObj(error);
  const msg = message || err?.message || 'Unknown error';
  setStatus({ lastError: { message: msg, stack: err?.stack } });
  const bodyMsg = `DayList headless peer error: ${msg}`;
  document.body.textContent = bodyMsg;
  console.error(bodyMsg, err);
};

const waitForIdb = async (doc: YDocHandles) => {
  if (!doc.persistence) return false;
  if (doc.idbSynced.value) return true;
  await new Promise((resolve) => {
    const handler = () => {
      try {
        doc.persistence?.off('synced', handler);
      } catch {
        // ignore
      }
      resolve(true);
    };
    doc.persistence?.on('synced', handler);
  });
  return true;
};

const main = async () => {
  const keys = resolveKeysStrict({ href: location.href, storage: localStorage });
  setStatus({ room: redact(keys.room) });

  const doc = createYDoc(log);
  await waitForIdb(doc);

  const snapshot = loadSnapshotFromStorage(localStorage);
  if (snapshot) {
    try {
      importSnapshot(doc, snapshot);
      log('snapshot:boot_imported');
    } catch (error) {
      log('snapshot:boot_failed', { error: errToObj(error) }, 'WARN');
    }
  } else {
    log('snapshot:boot_none');
  }

  const sigList = parseSignalingList(keys.sig);
  const signaling = sigList.length ? sigList : DEFAULT_SIGNALING;

  const signalingByUrl = new Map<string, SignalingStatus>();
  signaling.forEach((url) => {
    signalingByUrl.set(url, { url, connected: false, connecting: false, lastMessageReceived: 0 });
  });
  setStatus({ signaling: Array.from(signalingByUrl.values()) });

  let provider: WebrtcProvider | null = null;
  const updatePeers = (fallback?: { webrtcPeers: string[]; bcPeers: string[] }) => {
    if (provider) {
      setStatus({ peers: getPeerCount(provider) });
      return;
    }
    if (fallback) {
      setStatus({ peers: Math.max(fallback.webrtcPeers.length, fallback.bcPeers.length) });
    }
  };

  const fetchFn = (...args: Parameters<typeof fetch>) => fetch(...args);
  const session = await createSyncSession({
    doc,
    room: keys.room,
    enc: keys.enc,
    signaling,
    turnKey: keys.turnKey,
    turnEnabled: keys.turnEnabled !== false,
    fetchFn,
    storage: localStorage,
    platform: { isIPhone: false },
    onProvider: (next) => {
      provider = next;
      provider.awareness.setLocalStateField('daylist', { role: 'headless-peer' });
      updatePeers();
    },
    onAwarenessChange: () => updatePeers(),
    onStatus: ({ connected }) => setStatus({ connected }),
    onSignalingStatus: (sigStatus) => {
      signalingByUrl.set(sigStatus.url, sigStatus);
      setStatus({ signaling: Array.from(signalingByUrl.values()) });
    },
    onPeers: (peers) => updatePeers(peers),
    onIce: ({ config }) => setStatus({ usingTurn: config.mode !== 'stun' }),
    onLog: log
  });

  await session.start('headless_start');
};

main().catch((error) => {
  setFatal(error);
});
