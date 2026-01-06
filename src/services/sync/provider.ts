import { SignalingConn, WebrtcConn, WebrtcProvider } from 'y-webrtc';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { errToObj } from '../../lib/core';
import type { YDocHandles } from './ydoc';
import { ensureWebrtcCompression } from './webrtcCompression';

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

export type PeerConnectionUpdate = {
  peerId: string;
  at: number;
  event: string;
  connected?: boolean;
  reason?: string;
  detail?: unknown;
  outcome?: string;
  iceState?: unknown;
  signalState?: unknown;
  error?: unknown;
};

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export async function connectProvider(opts: {
  doc: YDocHandles;
  room: string;
  enc: string;
  signaling: string[];
  iceServers: RTCIceServer[];
  iceTransport?: 'all' | 'relay';
  onAwarenessChange: () => void;
  onStatus?: (status: { connected: boolean }) => void;
  onSignalingStatus?: (status: SignalingStatus) => void;
  onPeers?: (peers: { webrtcPeers: string[]; bcPeers: string[] }) => void;
  onPeerSeen?: (info: { peerId?: string; reason: string; at: number; detail?: unknown }) => void;
  onPeerState?: (info: PeerConnectionUpdate) => void;
  onLog?: (event: string, data?: unknown, level?: LogLevel) => void;
  debugSignaling?: boolean;
}): Promise<WebrtcProvider> {
  ensureWebrtcCompression({ onLog: opts.onLog });
  const PEER_STALE_MS = 20_000;
  const STALE_CHECK_INTERVAL_MS = 5_000;
  const DISCONNECTED_GRACE_MS = 15_000;
  const NEGOTIATION_TIMEOUT_MS = 20_000;
  const RESYNC_RETRY_MS = 500;
  const RESYNC_MAX_ATTEMPTS = 12;
  const RESYNC_MIN_INTERVAL_MS = 30_000;
  const MESSAGE_SYNC = 0;
  const MESSAGE_AWARENESS = 1;
  const MESSAGE_QUERY_AWARENESS = 3;

  const peerLastSeenAt = new Map<string, number>();
  const peerSeenOnConn = new Map<string, string>();
  const peerLastActivityAt = new Map<string, number>();
  const peerDisconnectedAt = new Map<string, number>();
  const peerNegotiationStartedAt = new Map<string, number>();
  const peerLastIceState = new Map<string, string>();
  const pendingPeers = new Set<string>();
  const resyncPending = new Map<string, { reason: string; attempts: number }>();
  const lastResyncAt = new Map<string, number>();
  const hookedPeers = new Set<string>();
  const connectedPeers = new Set<string>();
  const connSend = new WeakMap<SignalingConn, (message: unknown) => void>();
  let staleInterval: ReturnType<typeof setInterval> | null = null;

  const emitPeerState = (info: Omit<PeerConnectionUpdate, 'at'> & { at?: number }) => {
    if (!info.peerId) return;
    opts.onPeerState?.({ ...info, at: info.at ?? Date.now() });
  };

  const logConnectAttempt = (
    peerId: string,
    reason: string,
    detail: unknown,
    outcome: string,
    error?: unknown,
    level: LogLevel = 'INFO'
  ) => {
    opts.onLog?.('webrtc:connect_attempt', { peerId, reason, detail, outcome, error: error ? errToObj(error) : null }, level);
    emitPeerState({
      peerId,
      event: 'connect_attempt',
      reason,
      detail,
      outcome,
      connected: outcome === 'connected' ? true : outcome.startsWith('skip_') ? undefined : false
    });
  };

  const provider = new WebrtcProvider(opts.room, opts.doc.ydoc, {
    password: opts.enc,
    signaling: opts.signaling,
    maxConns: Number.POSITIVE_INFINITY,
    filterBcConns: false,
    peerOpts: {
      config: {
        iceServers: opts.iceServers,
        iceTransportPolicy: opts.iceTransport === 'relay' ? 'relay' : 'all'
      }
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

  const isCurrentConn = (peerId: string, conn: unknown) => {
    const room = getRoom();
    if (!room || !room.webrtcConns) return true;
    return room.webrtcConns.get(peerId) === conn;
  };

  const markPeerActivity = (peerId: string, at = Date.now()) => {
    peerLastActivityAt.set(peerId, at);
  };

  const markPeerDisconnected = (peerId: string, at = Date.now()) => {
    if (!peerDisconnectedAt.has(peerId)) peerDisconnectedAt.set(peerId, at);
  };

  const ensureNegotiationStart = (peerId: string, at = Date.now()) => {
    if (!peerNegotiationStartedAt.has(peerId)) peerNegotiationStartedAt.set(peerId, at);
  };

  const cleanupPeerTracking = (peerId: string) => {
    peerLastActivityAt.delete(peerId);
    peerDisconnectedAt.delete(peerId);
    peerNegotiationStartedAt.delete(peerId);
    peerLastIceState.delete(peerId);
  };

  const peerIsHealthy = (peerId: string, conn: { peer?: any; closed?: boolean }, now = Date.now()) => {
    if (!conn || !conn.peer) return false;
    if (conn.closed) return false;
    const peer = conn.peer;
    if (peer.destroyed || peer.destroying) return false;

    ensureNegotiationStart(peerId, now);
    const startedAt = peerNegotiationStartedAt.get(peerId) || now;
    const pc = peer?._pc;
    const iceState =
      typeof pc?.iceConnectionState === 'string' ? pc.iceConnectionState : peerLastIceState.get(peerId) || null;
    const connState = typeof pc?.connectionState === 'string' ? pc.connectionState : null;
    const channelState = peer?._channel?.readyState;
    const connected = !!peer.connected || channelState === 'open';

    if (iceState === 'disconnected') {
      markPeerDisconnected(peerId, now);
    } else if (iceState) {
      peerDisconnectedAt.delete(peerId);
    }

    if (iceState === 'failed' || iceState === 'closed') return false;
    if (connState === 'failed' || connState === 'closed') return false;

    if (!connected) {
      if (channelState === 'closed' || channelState === 'closing') return false;
      if (now - startedAt > NEGOTIATION_TIMEOUT_MS) return false;
      if (iceState === 'disconnected') {
        const disconnectedAt = peerDisconnectedAt.get(peerId) || startedAt;
        const lastActivity = peerLastActivityAt.get(peerId) || startedAt;
        const baseline = Math.max(disconnectedAt, lastActivity, startedAt);
        if (now - baseline > DISCONNECTED_GRACE_MS) return false;
      }
      return true;
    }

    if (channelState && channelState !== 'open') return false;
    if (iceState === 'disconnected') {
      const disconnectedAt = peerDisconnectedAt.get(peerId) || startedAt;
      const lastActivity = peerLastActivityAt.get(peerId) || startedAt;
      const baseline = Math.max(disconnectedAt, lastActivity, startedAt);
      if (now - baseline > DISCONNECTED_GRACE_MS) return false;
    }
    return true;
  };

  const hookPeer = (peerId: string, conn: { peer?: any }) => {
    if (!peerId || hookedPeers.has(peerId)) return;
    if (!conn || !(conn as { peer?: any }).peer) return;
    const peer = (conn as { peer: any }).peer;
    hookedPeers.add(peerId);
    ensureNegotiationStart(peerId);
    try {
      peer.on('connect', () => {
        if (!isCurrentConn(peerId, conn)) return;
        connectedPeers.add(peerId);
        markPeerActivity(peerId);
        peerDisconnectedAt.delete(peerId);
        opts.onLog?.('webrtc:peer_connected', { peerId });
        emitPeerState({ peerId, event: 'peer_connected', connected: true });
        requestResync(peerId, 'peer_connect');
      });
      peer.on('close', () => {
        if (!isCurrentConn(peerId, conn)) return;
        connectedPeers.delete(peerId);
        hookedPeers.delete(peerId);
        cleanupPeerTracking(peerId);
        opts.onLog?.('webrtc:peer_closed', { peerId });
        emitPeerState({ peerId, event: 'peer_closed', connected: false });
      });
      peer.on('error', (error: unknown) => {
        if (!isCurrentConn(peerId, conn)) return;
        opts.onLog?.('webrtc:peer_error', { peerId, error: errToObj(error) }, 'WARN');
        emitPeerState({ peerId, event: 'peer_error', error });
      });
      peer.on('data', () => {
        if (!isCurrentConn(peerId, conn)) return;
        markPeerActivity(peerId);
      });
      if (typeof peer.on === 'function') {
        peer.on('iceStateChange', (state: unknown) => {
          if (!isCurrentConn(peerId, conn)) return;
          const nextState = typeof state === 'string' ? state : String(state);
          peerLastIceState.set(peerId, nextState);
          if (nextState === 'disconnected') {
            markPeerDisconnected(peerId);
          } else {
            peerDisconnectedAt.delete(peerId);
          }
          opts.onLog?.('webrtc:ice_state', { peerId, state });
          emitPeerState({ peerId, event: 'ice_state', iceState: state });
        });
        peer.on('signalingStateChange', (state: unknown) => {
          if (!isCurrentConn(peerId, conn)) return;
          opts.onLog?.('webrtc:signal_state', { peerId, state });
          emitPeerState({ peerId, event: 'signal_state', signalState: state });
        });
      }
    } catch (error) {
      opts.onLog?.('webrtc:peer_hook_failed', { peerId, error: errToObj(error) }, 'WARN');
    }
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

  const logSignal = (
    direction: 'send' | 'recv',
    conn: SignalingConn,
    message: unknown,
    extra?: Record<string, unknown>
  ) => {
    const base = {
      url: conn.url,
      ...(extra || {})
    };
    if (!message || typeof message !== 'object') {
      opts.onLog?.(`signal:${direction}`, { ...base, message });
      return;
    }
    const msg = message as { type?: string; data?: unknown; topic?: string };
    const isPublish = msg.type === 'publish';
    const dataIsString = typeof msg.data === 'string';
    if (!isPublish || !dataIsString) {
      opts.onLog?.(`signal:${direction}`, { ...base, message: msg });
      return;
    }
    if (msg.topic && msg.topic !== opts.room) {
      opts.onLog?.(`signal:${direction}`, { ...base, message: { ...msg, data: null } });
      return;
    }
    decryptSignalPayload(msg.data)
      .then((decrypted) => {
        if (decrypted == null) {
          opts.onLog?.(
            `signal:${direction}_decrypt_failed`,
            { ...base, message: { ...msg, data: null }, reason: 'missing_key' },
            'WARN'
          );
          return;
        }
        opts.onLog?.(`signal:${direction}`, { ...base, message: { ...msg, data: decrypted } });
      })
      .catch((error) => {
        opts.onLog?.(
          `signal:${direction}_decrypt_failed`,
          { ...base, message: { ...msg, data: null }, error: errToObj(error) },
          'WARN'
        );
      });
  };

  const sendNow = (conn: SignalingConn, message: unknown) => {
    const send =
      connSend.get(conn) ||
      ((conn as SignalingConn & { __dlSend?: (message: unknown) => void }).__dlSend || null);
    logSignal('send', conn, message);
    if (send) send(message);
  };

  const ensureWebrtcConn = (peerId: string, conn: SignalingConn, reason: string, detail?: unknown) => {
    if (!peerId) return;
    const room = getRoom();
    if (!room) {
      pendingPeers.add(peerId);
      logConnectAttempt(peerId, reason, detail, 'defer_no_room');
      return;
    }
    const localPeerId = room.peerId;
    if (peerId === localPeerId) {
      logConnectAttempt(peerId, reason, detail, 'skip_self');
      return;
    }
    const existingConn = room.webrtcConns?.get(peerId);
    if (existingConn) {
      if (peerIsHealthy(peerId, existingConn)) {
        logConnectAttempt(peerId, reason, detail, 'skip_healthy');
        hookPeer(peerId, existingConn);
        return;
      }
      logConnectAttempt(peerId, reason, detail, 'replace_unhealthy');
      try {
        if (typeof (existingConn as { destroy?: () => void }).destroy === 'function') {
          (existingConn as { destroy: () => void }).destroy();
        } else if ((existingConn as { peer?: { destroy?: () => void } }).peer?.destroy) {
          (existingConn as { peer: { destroy: () => void } }).peer.destroy();
        }
      } catch (error) {
        opts.onLog?.('webrtc:peer_destroy_failed', { peerId, reason, error: errToObj(error) }, 'WARN');
      }
      connectedPeers.delete(peerId);
      hookedPeers.delete(peerId);
      cleanupPeerTracking(peerId);
      if (room.webrtcConns?.has(peerId)) {
        room.webrtcConns.delete(peerId);
      }
    }

    try {
      logConnectAttempt(peerId, reason, detail, 'create');
      ensureNegotiationStart(peerId);
      const webrtcConn = new WebrtcConn(conn, true, peerId, room);
      room.webrtcConns.set(peerId, webrtcConn);
      opts.onLog?.('webrtc:manual_connect', { peerId, reason, detail });
      emitPeerState({ peerId, event: 'connect_created', reason, detail, connected: false });
      hookPeer(peerId, webrtcConn);
    } catch (error) {
      opts.onLog?.('webrtc:manual_connect_failed', { peerId, reason, error: errToObj(error) }, 'WARN');
      logConnectAttempt(peerId, reason, detail, 'failed', error, 'WARN');
      emitPeerState({ peerId, event: 'connect_failed', reason, detail, error, connected: false });
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
      const shouldConnect = reason !== 'signal:signal' && reason !== 'signal:welcome' && reason !== 'signal:subscribe';
      if (!shouldConnect) {
        logConnectAttempt(peerId, isNew ? 'new_peer' : 'stale_peer', detail, 'skip_policy');
        return;
      }
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
    return originalDestroy();
  };

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
      connectedPeers.forEach((peerId) => {
        if (!webrtcList.includes(peerId)) connectedPeers.delete(peerId);
      });
    }

    const room = getRoom();
    if (room && room.webrtcConns) {
      webrtcList.forEach((peerId) => {
        if (!peerId || typeof peerId !== 'string') return;
        const conn = room.webrtcConns.get(peerId);
        if (!conn) return;
        hookPeer(peerId, conn);
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
      flushPendingPeers('signaling_connect');
    });
    conn.on('disconnect', () => {
      updateStatus();
      opts.onLog?.('signal:disconnect', { url: conn.url });
    });
    conn.on('message', (message: unknown) => {
      updateStatus();
      logSignal('recv', conn, message);
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

      if (msg.type === 'publish' && hasTopic) {
        if (msg.data && typeof msg.data === 'object') {
          const data = msg.data as { from?: unknown; type?: unknown; signal?: unknown };
          const peerId = typeof data.from === 'string' ? data.from : '';
          if (peerId) {
            recordPeerSeen(peerId, conn, `signal:${typeof data.type === 'string' ? data.type : 'from'}`, {
              type: data.type,
              signalType:
                data && typeof data.signal === 'object' && data.signal && 'type' in (data.signal as { type?: unknown })
                  ? (data.signal as { type?: unknown }).type
                  : undefined
            });
          }
        } else if (typeof msg.data === 'string') {
          decryptSignalPayload(msg.data)
            .then((decrypted) => {
              if (!decrypted || typeof decrypted !== 'object') return;
              const data = decrypted as { from?: unknown; type?: unknown; signal?: unknown };
              const peerId = typeof data.from === 'string' ? data.from : '';
              if (!peerId) return;
              recordPeerSeen(peerId, conn, `signal:${typeof data.type === 'string' ? data.type : 'from'}`, {
                type: data.type,
                signalType:
                  data && typeof data.signal === 'object' && data.signal && 'type' in (data.signal as { type?: unknown })
                    ? (data.signal as { type?: unknown }).type
                    : undefined
              });
            })
            .catch(() => {});
        }
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
      sendNow(conn, message);
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
