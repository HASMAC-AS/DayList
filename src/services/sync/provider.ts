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
  onLog?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG') => void;
}): Promise<WebrtcProvider> {
  const STARTUP_BURST_COUNT = 3;
  const STARTUP_BURST_INTERVAL_MS = 100;
  const PRE_PEER_INTERVAL_MS = 1000;
  const POST_PEER_INTERVAL_MS = 30_000;
  const PEER_STALE_MS = 30_000;
  const PEER_URGENT_MS = 5 * 60 * 1000;
  const URGENT_BURST_COUNT = 3;
  const MESSAGE_SYNC = 0;
  const MESSAGE_AWARENESS = 1;
  const MESSAGE_QUERY_AWARENESS = 3;

  const sendQueue: Array<() => void> = [];
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let burstRemaining = 0;
  let startupBurstUsed = false;
  let peerConnected = false;
  let peerDiscovered = false;
  let priorityRemaining = 0;
  let peerSeen = false;
  let peerSeenAt = 0;
  const peerLastSeen = new Map<string, number>();
  const pendingPeers = new Set<string>();
  const urgentPeers = new Set<string>();
  const startupResynced = new Set<string>();
  const resyncPending = new Map<string, { reason: string; attempts: number }>();
  const knownPeers = new Set<string>();
  let staleInterval: ReturnType<typeof setInterval> | null = null;

  const STALE_CHECK_INTERVAL_MS = 5_000;
  const RESYNC_RETRY_MS = 500;
  const RESYNC_MAX_ATTEMPTS = 12;

  const currentInterval = () => {
    if (burstRemaining > 0) return STARTUP_BURST_INTERVAL_MS;
    return peerDiscovered ? POST_PEER_INTERVAL_MS : PRE_PEER_INTERVAL_MS;
  };

  const startPump = () => {
    if (sendTimer != null) return;
    const pump = () => {
      if (sendQueue.length === 0) {
        sendTimer = null;
        return;
      }
      const next = sendQueue.shift();
      if (next) next();
      if (burstRemaining > 0) burstRemaining -= 1;
      sendTimer = setTimeout(pump, currentInterval());
    };
    pump();
  };

  const scheduleSend = (fn: () => void) => {
    if (priorityRemaining > 0) {
      priorityRemaining -= 1;
      fn();
      return;
    }
    sendQueue.push(fn);
    startPump();
  };

  const resetSendTimer = () => {
    if (sendTimer != null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    startPump();
  };

  const grantPriorityBurst = (reason: string) => {
    priorityRemaining = Math.max(priorityRemaining, URGENT_BURST_COUNT);
    opts.onLog?.('signal:priority_burst', { reason, remaining: priorityRemaining });
    while (priorityRemaining > 0 && sendQueue.length > 0) {
      const next = sendQueue.shift();
      if (next) next();
      priorityRemaining -= 1;
    }
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

  const shouldBypassThrottle = (message: unknown) => {
    if (!message || typeof message !== 'object') return false;
    const msg = message as { type?: string; data?: unknown; topic?: string };
    if (msg.type !== 'publish') return false;
    if (msg.topic !== opts.room) return false;
    if (msg.data && typeof msg.data === 'object') {
      return (msg.data as { type?: string }).type === 'signal';
    }
    if (typeof msg.data !== 'string') return false;
    return decryptSignalPayload(msg.data)
      .then((decrypted) => {
        if (!decrypted || typeof decrypted !== 'object') return false;
        return (decrypted as { type?: string }).type === 'signal';
      })
      .catch(() => true);
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

  const notePeerSeen = (peerId: string, conn: SignalingConn, reason: string, detail?: unknown) => {
    const localPeerId = getLocalPeerId();
    if (!peerId || peerId === localPeerId) return;
    const now = Date.now();
    opts.onPeerSeen?.({ peerId, reason, at: now, detail });
    const last = peerLastSeen.get(peerId);
    const stale = last != null && now - last > PEER_STALE_MS;
    const urgent = last == null || now - (last || 0) > PEER_URGENT_MS;
    const isNew = last == null;
    peerLastSeen.set(peerId, now);

    if (isNew || stale) {
      if (urgent) {
        grantPriorityBurst(isNew ? 'new_peer' : 'stale_peer');
        urgentPeers.add(peerId);
      }
      ensureWebrtcConn(peerId, conn, isNew ? 'new_peer' : 'stale_peer', detail);
    }
  };

  const logDecrypted = (direction: 'send' | 'recv', url: string, message: unknown, conn?: SignalingConn) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; data?: unknown; from?: string; to?: string; topic?: string };
    if (msg.type !== 'publish' || typeof msg.data !== 'string') return;
    if (msg.topic !== opts.room) return;
    decryptSignalPayload(msg.data)
      .then((decrypted) => {
        if (decrypted == null) return;
        opts.onLog?.(`signal:${direction}_decrypted`, {
          url,
          from: msg.from,
          to: msg.to,
          decrypted
        });
        if (direction === 'recv' && conn && decrypted && typeof decrypted === 'object') {
          const dec = decrypted as { from?: string; type?: string };
          if (typeof dec.from === 'string' && dec.from) {
            notePeerSeen(dec.from, conn, 'signal:decrypted', { type: dec.type });
          }
        }
      })
      .catch((error) => {
        opts.onLog?.(
          `signal:${direction}_decrypt_failed`,
          { url, topic: msg.topic, error: errToObj(error) },
          'WARN'
        );
      });
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
    resyncPending.set(peerId, { reason, attempts: 0 });
    attemptResync(peerId);
  };

  const computeHasPeer = () => provider.awareness.getStates().size > 1;
  const updateHasPeer = (reason: string) => {
    const nowHasPeer = computeHasPeer();
    if (nowHasPeer) {
      if (!peerConnected) {
        peerConnected = true;
        opts.onLog?.('signal:peer_connected', { reason });
      }
      if (!peerDiscovered) {
        peerDiscovered = true;
        opts.onLog?.('signal:peer_discovered', { reason, intervalMs: currentInterval() });
        resetSendTimer();
      }
      opts.onLog?.('signal:peer_detected', { reason });
      return;
    }
    if (peerConnected) {
      peerConnected = false;
      opts.onLog?.('signal:peer_lost', { reason });
    }
  };

  const markPeerSeen = (reason: string, detail?: unknown) => {
    if (peerSeen) return;
    peerSeen = true;
    peerSeenAt = Date.now();
    if (!peerDiscovered) {
      peerDiscovered = true;
      opts.onLog?.('signal:peer_discovered', { reason, intervalMs: currentInterval() });
      resetSendTimer();
    }
    opts.onLog?.('signal:peer_seen', { reason, detail, at: peerSeenAt });
  };

  const originalDestroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    if (staleInterval) {
      clearInterval(staleInterval);
      staleInterval = null;
    }
    return originalDestroy();
  };

  opts.onLog?.('signal:throttle_mode', {
    phase: 'init',
    intervalMs: currentInterval()
  });

  staleInterval = setInterval(() => {
    const now = Date.now();
    const conn = getAnyConn();
    if (!conn) return;
    peerLastSeen.forEach((lastSeen, peerId) => {
      if (now - lastSeen > PEER_STALE_MS) {
        peerLastSeen.set(peerId, now);
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

  provider.awareness.on('change', (...args: unknown[]) => {
    opts.onAwarenessChange();
    updateHasPeer('awareness');
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
    const added = Array.isArray(event.added)
      ? event.added
      : webrtcList.filter((peerId) => !knownPeers.has(peerId));
    added.forEach((peerId) => {
      if (!peerId || typeof peerId !== 'string') return;
      const reasons: string[] = [];
      if (!startupResynced.has(peerId)) {
        startupResynced.add(peerId);
        reasons.push('startup');
      }
      if (urgentPeers.has(peerId)) {
        urgentPeers.delete(peerId);
        reasons.push('stale_peer');
      }
      if (reasons.length) requestResync(peerId, reasons.join('+'));
    });

    knownPeers.clear();
    webrtcList.forEach((peerId) => {
      if (peerId && typeof peerId === 'string') knownPeers.add(peerId);
    });
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
      if (!startupBurstUsed) {
        startupBurstUsed = true;
        burstRemaining = STARTUP_BURST_COUNT;
        opts.onLog?.('signal:startup_burst', {
          count: STARTUP_BURST_COUNT,
          intervalMs: STARTUP_BURST_INTERVAL_MS
        });
        resetSendTimer();
      }
      flushPendingPeers('signaling_connect');
    });
    conn.on('disconnect', () => {
      updateStatus();
      opts.onLog?.('signal:disconnect', { url: conn.url });
    });
    conn.on('message', (message: unknown) => {
      updateStatus();
      opts.onLog?.('signal:recv', { url: conn.url, message: sanitizeSignalMessage(message) });
      logDecrypted('recv', conn.url, message, conn);
      if (message && typeof message === 'object') {
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
          msg.type === 'publish' ? msg.topic === opts.room
          : Array.isArray(msg.topics) ? msg.topics.includes(opts.room)
          : false;
        if (typeof msg.from === 'string' && msg.from && hasTopic) {
          markPeerSeen(`signal:${msg.type || 'from'}`, { type: msg.type });
          notePeerSeen(msg.from, conn, `signal:${msg.type || 'from'}`, { type: msg.type });
        } else if (msg.type === 'welcome' && Array.isArray(msg.peers) && msg.peers.length > 0) {
          opts.onLog?.('signal:welcome_peers', { count: msg.peers.length });
        }
      }
    });

    const originalSend = conn.send.bind(conn);
    conn.send = (message: unknown) => {
      const doSend = () => {
        opts.onLog?.('signal:send', {
          url: conn.url,
          message: sanitizeSignalMessage(message),
          intervalMs: currentInterval()
        });
        logDecrypted('send', conn.url, message);
        originalSend(message);
      };
      const bypass = shouldBypassThrottle(message);
      if (typeof bypass === 'boolean') {
        if (bypass) doSend();
        else scheduleSend(doSend);
        return;
      }
      bypass
        .then((allowed) => {
          if (allowed) doSend();
          else scheduleSend(doSend);
        })
        .catch(() => {
          doSend();
        });
    };
  };

  if (Array.isArray(provider.signalingConns)) {
    provider.signalingConns.forEach((conn) => {
      if (conn) attachConn(conn as SignalingConn);
    });
  }

  updateHasPeer('init');

  return provider;
}

export function getPeerCount(provider: WebrtcProvider | null) {
  if (!provider) return 0;
  return Math.max(0, provider.awareness.getStates().size - 1);
}
