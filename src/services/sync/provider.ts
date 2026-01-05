import { SignalingConn, WebrtcConn, WebrtcProvider } from 'y-webrtc';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { errToObj } from '../../lib/core';
import type { YDocHandles } from './ydoc';

export interface ProviderStatus {
  connected: boolean;
  peers: number;
  usingTurn: boolean;
  signaling: string[];
}

export interface SignalingStatus {
  url: string;
  connected: boolean;
  connecting: boolean;
  lastMessageReceived: number;
}

type Outgoing = { conn: SignalingConn; message: unknown; enqueuedAt: number; key: string };

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export async function connectProvider(opts: {
  doc: YDocHandles;
  room: string;
  enc: string;
  signaling: string[];
  iceServers: RTCIceServer[];
  onAwarenessChange: () => void;
  onStatus?: (status: { connected: boolean }) => void;
  onSignalingStatus?: (status: SignalingStatus) => void;
  onPeers?: (peers: { webrtcPeers: string[]; bcPeers: string[] }) => void;
  onPeerSeen?: (info: { peerId?: string; reason: string; at: number; detail?: unknown }) => void;
  onLog?: (event: string, data?: unknown, level?: LogLevel) => void;
  debugSignaling?: boolean;
}): Promise<WebrtcProvider> {
  const DISCOVERY_INTERVAL_MS = 250;
  const STEADY_INTERVAL_MS = 45_000;
  const LOW_BURST_COUNT = 3;
  const PEER_STALE_MS = 20_000;
  const PEER_IDLE_RESET_MS = 15_000;
  const STALE_CHECK_INTERVAL_MS = 5_000;
  const RESYNC_RETRY_MS = 500;
  const RESYNC_MAX_ATTEMPTS = 12;
  const RESYNC_MIN_INTERVAL_MS = 30_000;
  const MESSAGE_SYNC = 0;
  const MESSAGE_AWARENESS = 1;
  const MESSAGE_QUERY_AWARENESS = 3;

  const lowQueue = new Map<string, Outgoing>();
  let lowTimer: ReturnType<typeof setTimeout> | null = null;
  let lowBurstTokens = 0;
  let mode: 'discovery' | 'steady' = 'discovery';
  let peerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  const peerLastSeenAt = new Map<string, number>();
  const peerSeenOnConn = new Map<string, string>();
  const pendingPeers = new Set<string>();
  const resyncPending = new Map<string, { reason: string; attempts: number }>();
  const lastResyncAt = new Map<string, number>();
  const hookedPeers = new Set<string>();
  const connSend = new WeakMap<SignalingConn, (message: unknown) => void>();
  let staleInterval: ReturnType<typeof setInterval> | null = null;

  const currentInterval = () => (mode === 'discovery' ? DISCOVERY_INTERVAL_MS : STEADY_INTERVAL_MS);

  const resetLowTimer = () => {
    if (lowTimer != null) {
      clearTimeout(lowTimer);
      lowTimer = null;
    }
    if (lowQueue.size > 0) scheduleLowPump(0);
  };

  const scheduleLowPump = (delayMs?: number) => {
    if (lowTimer != null) return;
    lowTimer = setTimeout(pumpLow, delayMs ?? currentInterval());
  };

  const pumpLow = () => {
    lowTimer = null;
    if (lowQueue.size === 0) return;
    const entry = lowQueue.entries().next().value as [string, Outgoing] | undefined;
    if (!entry) return;
    const [key, outgoing] = entry;
    lowQueue.delete(key);
    sendNow(outgoing.conn, outgoing.message);
    if (lowQueue.size > 0) scheduleLowPump();
  };

  const setMode = (next: 'discovery' | 'steady', reason: string) => {
    if (mode === next) return;
    mode = next;
    opts.onLog?.('signal:throttle_mode', { phase: mode, intervalMs: currentInterval(), reason });
    resetLowTimer();
  };

  const clearPeerIdleTimer = () => {
    if (peerIdleTimer != null) {
      clearTimeout(peerIdleTimer);
      peerIdleTimer = null;
    }
  };

  const schedulePeerIdleReset = (reason: string) => {
    if (peerIdleTimer != null) return;
    peerIdleTimer = setTimeout(() => {
      peerIdleTimer = null;
      setMode('discovery', `peer_idle:${reason}`);
    }, PEER_IDLE_RESET_MS);
    opts.onLog?.('signal:peer_idle_scheduled', { reason, afterMs: PEER_IDLE_RESET_MS });
  };

  const flushLowBurst = () => {
    while (lowBurstTokens > 0 && lowQueue.size > 0) {
      const entry = lowQueue.entries().next().value as [string, Outgoing] | undefined;
      if (!entry) return;
      const [key, outgoing] = entry;
      lowQueue.delete(key);
      lowBurstTokens -= 1;
      sendNow(outgoing.conn, outgoing.message);
    }
  };

  const grantLowBurst = (reason: string, count = LOW_BURST_COUNT) => {
    lowBurstTokens = Math.max(lowBurstTokens, count);
    opts.onLog?.('signal:low_burst', { reason, remaining: lowBurstTokens, mode });
    flushLowBurst();
  };

  const classifyOutgoing = (message: unknown): 'immediate' | 'low' => {
    if (!message || typeof message !== 'object') return 'immediate';
    const msg = message as { type?: string; to?: string; topic?: string };
    if (msg.type && msg.type !== 'publish') return 'immediate';
    if (msg.type !== 'publish') return 'immediate';
    if (msg.to) return 'immediate';
    if (msg.topic && msg.topic !== opts.room) return 'immediate';
    return 'low';
  };

  const lowKey = (conn: SignalingConn, message: unknown) => {
    const msg = message as { topic?: string } | null;
    const topic = msg && typeof msg.topic === 'string' && msg.topic ? msg.topic : opts.room;
    return `${conn.url}|${topic}`;
  };

  const provider = new WebrtcProvider(opts.room, opts.doc.ydoc, {
    password: opts.enc,
    signaling: opts.signaling,
    maxConns: Number.POSITIVE_INFINITY,
    filterBcConns: false,
    peerOpts: {
      config: { iceServers: opts.iceServers }
    }
  });

  const getRoom = () => (provider as { room?: any }).room || null;
  const getLocalPeerId = () => {
    const room = getRoom();
    return room?.peerId || null;
  };
  const getAnyConn = () => {
    const conns = provider.signalingConns || [];
    return conns.find((conn) => conn.connected || conn.connecting) || conns[0] || null;
  };

  const decodeBase64 = (input: string) => {
    const bin = atob(input);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  };

  const decryptSignalPayload = async (payload: string) => {
    const key = (provider as { room?: { key?: CryptoKey | null } }).room?.key || null;
    if (!key) return null;
    const data = decodeBase64(payload);
    const decoder = decoding.createDecoder(data);
    const algorithm = decoding.readVarString(decoder);
    if (algorithm !== 'AES-GCM') throw new Error(`Unsupported algorithm: ${algorithm}`);
    const iv = decoding.readVarUint8Array(decoder);
    const cipher = decoding.readVarUint8Array(decoder);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return decoding.readAny(decoding.createDecoder(new Uint8Array(decrypted)));
  };

  const sanitizeSignalMessage = (message: unknown) => {
    if (!message || typeof message !== 'object') return message;
    const msg = message as { type?: string; data?: unknown };
    if (msg.type === 'publish' && typeof msg.data === 'string') {
      return { ...msg, data: '[encrypted]' };
    }
    return message;
  };

  const logDecrypted = (direction: 'send' | 'recv', url: string, message: unknown) => {
    if (!opts.debugSignaling) return;
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; data?: unknown; from?: string; to?: string; topic?: string };
    if (msg.type !== 'publish' || typeof msg.data !== 'string') return;
    if (msg.topic && msg.topic !== opts.room) return;
    decryptSignalPayload(msg.data)
      .then((decrypted) => {
        if (decrypted == null) return;
        opts.onLog?.(`signal:${direction}_decrypted`, {
          url,
          from: msg.from,
          to: msg.to,
          decrypted
        });
      })
      .catch((error) => {
        opts.onLog?.(
          `signal:${direction}_decrypt_failed`,
          { url, topic: msg.topic, error: errToObj(error) },
          'WARN'
        );
      });
  };

  const sendNow = (conn: SignalingConn, message: unknown) => {
    const send =
      connSend.get(conn) ||
      ((conn as SignalingConn & { __dlSend?: (message: unknown) => void }).__dlSend || null);
    opts.onLog?.('signal:send', {
      url: conn.url,
      message: sanitizeSignalMessage(message),
      intervalMs: currentInterval(),
      mode
    });
    logDecrypted('send', conn.url, message);
    if (send) send(message);
  };

  const queueLow = (conn: SignalingConn, message: unknown) => {
    if (lowBurstTokens > 0) {
      lowBurstTokens -= 1;
      sendNow(conn, message);
      return;
    }
    const key = lowKey(conn, message);
    lowQueue.set(key, { conn, message, enqueuedAt: Date.now(), key });
    scheduleLowPump();
  };

  const ensureWebrtcConn = (peerId: string, conn: SignalingConn, reason: string, detail?: unknown) => {
    const room = getRoom();
    if (!room) {
      pendingPeers.add(peerId);
      return;
    }
    const localPeerId = room.peerId;
    if (!peerId || peerId === localPeerId) return;
    if (room.webrtcConns?.has(peerId)) return;

    try {
      const webrtcConn = new WebrtcConn(conn, true, peerId, room);
      room.webrtcConns.set(peerId, webrtcConn);
      opts.onLog?.('webrtc:manual_connect', { peerId, reason, detail });
    } catch (error) {
      opts.onLog?.('webrtc:manual_connect_failed', { peerId, reason, error: errToObj(error) }, 'WARN');
    }
  };

  const recordPeerSeen = (peerId: string, conn: SignalingConn, reason: string, detail?: unknown) => {
    const localPeerId = getLocalPeerId();
    if (!peerId || peerId === localPeerId) return;
    const now = Date.now();
    const last = peerLastSeenAt.get(peerId);
    const isNew = last == null;
    const isStale = last != null && now - last > PEER_STALE_MS;
    peerLastSeenAt.set(peerId, now);
    peerSeenOnConn.set(peerId, conn.url);
    opts.onPeerSeen?.({ peerId, reason, at: now, detail });
    if (isNew || isStale) {
      grantLowBurst(isNew ? 'peer_new' : 'peer_stale');
      ensureWebrtcConn(peerId, conn, isNew ? 'new_peer' : 'stale_peer', detail);
    }
  };

  const flushPendingPeers = (reason: string) => {
    if (pendingPeers.size === 0) return;
    const conn = getAnyConn();
    if (!conn) return;
    const room = getRoom();
    if (!room) return;
    pendingPeers.forEach((peerId) => {
      ensureWebrtcConn(peerId, conn, `pending:${reason}`);
    });
    pendingPeers.clear();
  };

  const sendResync = (peerId: string, reason: string) => {
    const room = getRoom();
    if (!room) return false;
    const conn = room.webrtcConns?.get(peerId);
    if (!conn || !conn.peer) return false;
    if (!conn.peer.connected) return false;

    try {
      const doc = room.provider.doc;
      const awareness = room.awareness;

      const update = Y.encodeStateAsUpdate(doc);
      const encUpdate = encoding.createEncoder();
      encoding.writeVarUint(encUpdate, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encUpdate, update);
      conn.peer.send(encoding.toUint8Array(encUpdate));

      const encStep1 = encoding.createEncoder();
      encoding.writeVarUint(encStep1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encStep1, doc);
      conn.peer.send(encoding.toUint8Array(encStep1));

      const encAwQuery = encoding.createEncoder();
      encoding.writeVarUint(encAwQuery, MESSAGE_QUERY_AWARENESS);
      conn.peer.send(encoding.toUint8Array(encAwQuery));

      const awarenessStates = awareness.getStates();
      if (awarenessStates.size > 0) {
        const encAw = encoding.createEncoder();
        encoding.writeVarUint(encAw, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encAw,
          awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys()))
        );
        conn.peer.send(encoding.toUint8Array(encAw));
      }

      opts.onLog?.('webrtc:resync', { peerId, reason });
      return true;
    } catch (error) {
      opts.onLog?.('webrtc:resync_failed', { peerId, reason, error: errToObj(error) }, 'WARN');
      return true;
    }
  };

  const attemptResync = (peerId: string) => {
    const entry = resyncPending.get(peerId);
    if (!entry) return;
    if (sendResync(peerId, entry.reason)) {
      resyncPending.delete(peerId);
      return;
    }
    if (entry.attempts >= RESYNC_MAX_ATTEMPTS) {
      resyncPending.delete(peerId);
      opts.onLog?.('webrtc:resync_giveup', { peerId, reason: entry.reason }, 'WARN');
      return;
    }
    entry.attempts += 1;
    setTimeout(() => attemptResync(peerId), RESYNC_RETRY_MS);
  };

  const requestResync = (peerId: string, reason: string) => {
    if (!peerId) return;
    const now = Date.now();
    const last = lastResyncAt.get(peerId) || 0;
    if (now - last < RESYNC_MIN_INTERVAL_MS) {
      opts.onLog?.('webrtc:resync_skip_cooldown', { peerId, reason, ageMs: now - last }, 'DEBUG');
      return;
    }
    lastResyncAt.set(peerId, now);
    resyncPending.set(peerId, { reason, attempts: 0 });
    attemptResync(peerId);
  };

  const originalDestroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    if (staleInterval) {
      clearInterval(staleInterval);
      staleInterval = null;
    }
    clearPeerIdleTimer();
    if (lowTimer != null) {
      clearTimeout(lowTimer);
      lowTimer = null;
    }
    return originalDestroy();
  };

  opts.onLog?.('signal:throttle_mode', {
    phase: mode,
    intervalMs: currentInterval()
  });

  staleInterval = setInterval(() => {
    const now = Date.now();
    const conn = getAnyConn();
    if (!conn) return;
    peerLastSeenAt.forEach((lastSeen, peerId) => {
      if (now - lastSeen > PEER_STALE_MS) {
        peerLastSeenAt.set(peerId, now);
        ensureWebrtcConn(peerId, conn, 'stale_check');
      }
    });
  }, STALE_CHECK_INTERVAL_MS);

  const maybeFlushPending = () => flushPendingPeers('room_ready');
  const keyPromise = (provider as { key?: PromiseLike<unknown> }).key;
  if (keyPromise && typeof keyPromise.then === 'function') {
    keyPromise
      .then(() => {
        maybeFlushPending();
      })
      .catch(() => {});
  }

  provider.awareness.on('change', () => {
    opts.onAwarenessChange();
  });

  provider.on('status', (event) => {
    opts.onLog?.('provider:status', event);
    if (event && typeof event === 'object' && 'connected' in event) {
      opts.onStatus?.({ connected: !!(event as { connected?: boolean }).connected });
    }
  });

  provider.on('peers', (event) => {
    opts.onPeers?.({
      webrtcPeers: event.webrtcPeers || [],
      bcPeers: event.bcPeers || []
    });
    opts.onLog?.('provider:peers', event);
    const webrtcList = Array.isArray(event.webrtcPeers) ? event.webrtcPeers : [];

    if (webrtcList.length > 0) {
      clearPeerIdleTimer();
      setMode('steady', 'webrtc_peers');
    } else {
      schedulePeerIdleReset('webrtc_empty');
    }

    const room = getRoom();
    if (room && room.webrtcConns) {
      webrtcList.forEach((peerId) => {
        if (!peerId || typeof peerId !== 'string') return;
        if (hookedPeers.has(peerId)) return;
        const conn = room.webrtcConns.get(peerId);
        if (!conn || !(conn as { peer?: any }).peer) return;
        const peer = (conn as { peer: any }).peer;
        hookedPeers.add(peerId);
        try {
          peer.on('connect', () => {
            opts.onLog?.('webrtc:peer_connected', { peerId });
            requestResync(peerId, 'peer_connect');
          });
          peer.on('close', () => {
            hookedPeers.delete(peerId);
            opts.onLog?.('webrtc:peer_closed', { peerId });
          });
          peer.on('error', (error: unknown) => {
            opts.onLog?.('webrtc:peer_error', { peerId, error: errToObj(error) }, 'WARN');
          });
          if (typeof peer.on === 'function') {
            peer.on('iceStateChange', (state: unknown) => {
              opts.onLog?.('webrtc:ice_state', { peerId, state });
            });
            peer.on('signalingStateChange', (state: unknown) => {
              opts.onLog?.('webrtc:signal_state', { peerId, state });
            });
          }
        } catch (error) {
          opts.onLog?.('webrtc:peer_hook_failed', { peerId, error: errToObj(error) }, 'WARN');
        }
      });
    }
  });

  const attachConn = (conn: SignalingConn) => {
    const anyConn = conn as SignalingConn & { __dlPatched?: boolean };
    if (anyConn.__dlPatched) return;
    anyConn.__dlPatched = true;

    const updateStatus = () => {
      opts.onSignalingStatus?.({
        url: conn.url,
        connected: !!conn.connected,
        connecting: !!conn.connecting,
        lastMessageReceived: Number(conn.lastMessageReceived || 0)
      });
    };

    updateStatus();

    conn.on('connect', () => {
      updateStatus();
      opts.onLog?.('signal:connect', { url: conn.url });
      grantLowBurst('signal_connect');
      flushPendingPeers('signaling_connect');
    });
    conn.on('disconnect', () => {
      updateStatus();
      opts.onLog?.('signal:disconnect', { url: conn.url });
    });
    conn.on('message', (message: unknown) => {
      updateStatus();
      opts.onLog?.('signal:recv', { url: conn.url, message: sanitizeSignalMessage(message) });
      logDecrypted('recv', conn.url, message);
      if (!message || typeof message !== 'object') return;
      const msg = message as {
        type?: string;
        from?: string;
        peers?: unknown;
        topic?: string;
        topics?: unknown;
      };
      if (msg.type === 'publish' && msg.topic && msg.topic !== opts.room) {
        opts.onLog?.('signal:recv_other_room', { topic: msg.topic, room: opts.room }, 'DEBUG');
      }
      const hasTopic =
        msg.type === 'publish'
          ? !msg.topic || msg.topic === opts.room
          : Array.isArray(msg.topics)
            ? msg.topics.includes(opts.room)
            : msg.topic === opts.room;

      if (typeof msg.from === 'string' && msg.from && hasTopic) {
        recordPeerSeen(msg.from, conn, `signal:${msg.type || 'from'}`, { type: msg.type });
      }
      if (msg.type === 'welcome' && Array.isArray(msg.peers) && msg.peers.length > 0) {
        msg.peers.forEach((peerId) => {
          if (typeof peerId !== 'string' || !peerId) return;
          recordPeerSeen(peerId, conn, 'signal:welcome', { count: msg.peers.length });
        });
      }
    });

    const originalSend = conn.send.bind(conn);
    connSend.set(conn, originalSend);
    (conn as SignalingConn & { __dlSend?: (message: unknown) => void }).__dlSend = originalSend;
    conn.send = (message: unknown) => {
      const decision = classifyOutgoing(message);
      if (decision === 'immediate') {
        sendNow(conn, message);
      } else {
        queueLow(conn, message);
      }
    };
  };

  if (Array.isArray(provider.signalingConns)) {
    provider.signalingConns.forEach((conn) => {
      if (conn) attachConn(conn as SignalingConn);
    });
  }

  return provider;
}

export function getPeerCount(provider: WebrtcProvider | null) {
  if (!provider) return 0;
  return Math.max(0, provider.awareness.getStates().size - 1);
}
