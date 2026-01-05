import type { WebrtcProvider } from 'y-webrtc';
import { errToObj } from '../../lib/core';
import { computeIceConfigs, iceKey, hasTurn, type IceConfig } from './icePolicy';
import { connectProvider, type PeerConnectionUpdate, type SignalingStatus } from './provider';
import { getIceServersFast, getStunFallback } from './meteredTurn';
import type { YDocHandles } from './ydoc';

export type SyncSession = {
  getProvider(): WebrtcProvider | null;
  getIceConfig(): IceConfig;
  start(reason?: string): Promise<void>;
  restart(reason: string): Promise<void>;
  softReconnect(reason: string): void;
  dispose(): void;
};

export async function createSyncSession(opts: {
  doc: YDocHandles;
  room: string;
  enc: string;
  signaling: string[];
  turnKey: string;
  turnEnabled: boolean;
  fetchFn: typeof fetch;
  storage: Storage;
  now?: () => number;
  platform: { isIPhone: boolean };
  onProvider?: (provider: WebrtcProvider) => void;
  onStatus?: (s: { connected: boolean }) => void;
  onPeers?: (p: { webrtcPeers: string[]; bcPeers: string[] }) => void;
  onAwarenessChange?: () => void;
  onSignalingStatus?: (s: SignalingStatus) => void;
  onPeerSeen?: (info: { peerId?: string; reason: string; at: number; detail?: unknown }) => void;
  onPeerState?: (info: PeerConnectionUpdate) => void;
  onIce?: (info: { config: IceConfig; reason: string }) => void;
  onLog?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG') => void;
  debugSignaling?: boolean;
}): Promise<SyncSession> {
  const ICE_UPGRADE_DELAY_MS = 800;
  const ICE_SIGNAL_GRACE_MS = 800;
  const ICE_MAX_WAIT_MS = 4000;

  const now = opts.now || (() => Date.now());
  const stunFallback = getStunFallback();

  let provider: WebrtcProvider | null = null;
  let currentConfig: IceConfig = { mode: 'stun', transport: 'all', iceServers: stunFallback };
  let bestConfig: IceConfig = currentConfig;
  let webrtcPeers: string[] = [];
  let lastPeerSeenAt = 0;
  let upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  let upgradeStartAt = 0;
  let disposed = false;

  const iceServersEqual = (a: RTCIceServer[], b: RTCIceServer[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (iceKey(a[i]) !== iceKey(b[i])) return false;
    }
    return true;
  };

  const iceConfigEqual = (a: IceConfig, b: IceConfig) =>
    a.mode === b.mode && a.transport === b.transport && iceServersEqual(a.iceServers, b.iceServers);

  const clearUpgradeTimer = () => {
    if (upgradeTimer != null) {
      clearTimeout(upgradeTimer);
      upgradeTimer = null;
    }
  };

  const buildProvider = async (config: IceConfig, reason: string) => {
    if (disposed) return;
    if (provider) {
      try {
        provider.destroy();
      } catch {
        // ignore
      }
      provider = null;
    }
    opts.onStatus?.({ connected: false });
    opts.onPeers?.({ webrtcPeers: [], bcPeers: [] });
    currentConfig = config;
    bestConfig = config;
    opts.onIce?.({ config, reason });
    provider = await connectProvider({
      doc: opts.doc,
      room: opts.room,
      enc: opts.enc,
      signaling: opts.signaling,
      iceServers: config.iceServers,
      onAwarenessChange: () => {
        opts.onAwarenessChange?.();
      },
      onStatus: (status) => {
        opts.onStatus?.(status);
      },
      onSignalingStatus: (status) => {
        opts.onSignalingStatus?.(status);
      },
      onPeers: (peers) => {
        webrtcPeers = Array.isArray(peers.webrtcPeers) ? peers.webrtcPeers : [];
        if (webrtcPeers.length > 0) {
          clearUpgradeTimer();
          upgradeStartAt = 0;
        }
        opts.onPeers?.(peers);
      },
      onPeerSeen: (info) => {
        lastPeerSeenAt = info.at;
        opts.onPeerSeen?.(info);
      },
      onPeerState: (info) => {
        opts.onPeerState?.(info);
      },
      onLog: opts.onLog,
      debugSignaling: opts.debugSignaling
    });
    opts.onProvider?.(provider);
  };

  const scheduleUpgrade = (target: IceConfig, reason: string, delayMs = ICE_UPGRADE_DELAY_MS) => {
    clearUpgradeTimer();
    if (!upgradeStartAt) upgradeStartAt = now();
    upgradeTimer = setTimeout(() => runUpgrade(target, reason), delayMs);
    opts.onLog?.('ice:upgrade_scheduled', { delayMs, reason, target: target.mode });
  };

  const runUpgrade = async (target: IceConfig, reason: string) => {
    if (!upgradeTimer) return;
    const ts = now();
    if (webrtcPeers.length > 0) {
      opts.onLog?.('ice:upgrade_skip_peers', { reason, peers: webrtcPeers.length });
      clearUpgradeTimer();
      upgradeStartAt = 0;
      return;
    }
    const signalRecent = lastPeerSeenAt > 0 && ts - lastPeerSeenAt < ICE_SIGNAL_GRACE_MS;
    if (signalRecent && ts - upgradeStartAt < ICE_MAX_WAIT_MS) {
      opts.onLog?.('ice:upgrade_delay_signal', {
        delayMs: ICE_SIGNAL_GRACE_MS,
        seenMsAgo: ts - lastPeerSeenAt
      });
      scheduleUpgrade(target, 'signal_recent', ICE_SIGNAL_GRACE_MS);
      return;
    }
    opts.onLog?.('ice:upgrade_connecting', { reason, target: target.mode });
    await buildProvider(target, `ice_upgrade:${reason}`);
    clearUpgradeTimer();
    upgradeStartAt = 0;
  };

  const start = async (reason = 'start') => {
    if (disposed) return;
    const fast = getIceServersFast({
      turnKey: opts.turnKey,
      allowTurn: opts.turnEnabled,
      fetchFn: opts.fetchFn,
      storage: opts.storage,
      now,
      log: opts.onLog
    });

    const turnInitial = hasTurn(fast.initial) ? fast.initial : null;
    const initialConfigs = computeIceConfigs({
      platform: opts.platform,
      stun: stunFallback,
      turn: turnInitial
    });

    await buildProvider(initialConfigs.initial, `${reason}:${fast.initialSource}`);

    if (fast.refresh) {
      fast.refresh
        .then((refresh) => {
          const turnServers = hasTurn(refresh.iceServers) ? refresh.iceServers : null;
          if (!turnServers) {
            opts.onLog?.('ice:refresh_no_turn', { source: refresh.source });
            return;
          }
          const refreshed = computeIceConfigs({
            platform: opts.platform,
            stun: stunFallback,
            turn: turnServers
          });
          const target = refreshed.upgrade || refreshed.initial;
          bestConfig = target;
          if (iceConfigEqual(currentConfig, target)) {
            opts.onLog?.('ice:upgrade_skip_same', { target: target.mode });
            return;
          }
          if (webrtcPeers.length > 0) {
            opts.onLog?.('ice:upgrade_skip_peers', { peers: webrtcPeers.length });
            return;
          }
          scheduleUpgrade(target, refresh.source);
        })
        .catch((error) => {
          opts.onLog?.('ice:refresh_failed', { error: errToObj(error) }, 'WARN');
        });
    }
  };

  const restart = async (reason: string) => {
    if (disposed) return;
    clearUpgradeTimer();
    upgradeStartAt = 0;
    await buildProvider(bestConfig || currentConfig, reason);
  };

  const softReconnect = (reason: string) => {
    if (!provider) return;
    try {
      provider.disconnect();
      provider.connect();
      opts.onLog?.('sync:soft_reconnect', { reason });
    } catch (error) {
      opts.onLog?.('sync:soft_reconnect_failed', { reason, error: errToObj(error) }, 'WARN');
    }
  };

  const dispose = () => {
    disposed = true;
    clearUpgradeTimer();
    if (provider) {
      try {
        provider.destroy();
      } catch {
        // ignore
      }
      provider = null;
    }
  };

  return {
    getProvider: () => provider,
    getIceConfig: () => currentConfig,
    start,
    restart,
    softReconnect,
    dispose
  };
}
