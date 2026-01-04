import { SignalingConn, WebrtcProvider } from 'y-webrtc';
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
  onSignalingStatus?: (status: SignalingStatus) => void;
  onPeers?: (peers: { webrtcPeers: string[]; bcPeers: string[] }) => void;
  onLog?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG') => void;
}): Promise<WebrtcProvider> {
  const SIGNAL_BASE_INTERVAL_MS = 100;
  const SIGNAL_THROTTLE_DELAY_MS = 1000;
  const SIGNAL_THROTTLE_INTERVAL_MS = 5000;

  const sendQueue: Array<() => void> = [];
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let throttleActive = false;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let hasPeer = false;

  const currentInterval = () => (throttleActive ? SIGNAL_THROTTLE_INTERVAL_MS : SIGNAL_BASE_INTERVAL_MS);

  const scheduleSend = (fn: () => void) => {
    sendQueue.push(fn);
    if (sendTimer != null) return;
    const pump = () => {
      if (sendQueue.length === 0) {
        sendTimer = null;
        return;
      }
      const next = sendQueue.shift();
      if (next) next();
      sendTimer = setTimeout(pump, currentInterval());
    };
    pump();
  };

  const flushSendQueue = () => {
    if (sendTimer != null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    while (sendQueue.length) {
      const next = sendQueue.shift();
      if (next) next();
    }
  };

  const clearSendQueue = () => {
    if (sendTimer != null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    sendQueue.length = 0;
  };

  const startThrottleTimer = (reason = 'start') => {
    if (throttleTimer != null) clearTimeout(throttleTimer);
    throttleTimer = setTimeout(() => {
      if (hasPeer) return;
      if (!throttleActive) {
        throttleActive = true;
        opts.onLog?.('signal:throttle_on', {
          intervalMs: SIGNAL_THROTTLE_INTERVAL_MS,
          delayMs: SIGNAL_THROTTLE_DELAY_MS,
          reason
        });
        if (sendTimer != null) {
          clearTimeout(sendTimer);
          sendTimer = null;
          if (sendQueue.length) scheduleSend(() => {});
        }
      }
    }, SIGNAL_THROTTLE_DELAY_MS);
  };

  const stopThrottle = (flush = true) => {
    if (throttleTimer != null) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (throttleActive) {
      throttleActive = false;
      opts.onLog?.('signal:throttle_off');
      if (sendTimer != null) {
        clearTimeout(sendTimer);
        sendTimer = null;
        if (sendQueue.length) scheduleSend(() => {});
      }
    }
    if (flush) flushSendQueue();
    else clearSendQueue();
  };

  const provider = new WebrtcProvider(opts.room, opts.doc.ydoc, {
    password: opts.enc,
    signaling: opts.signaling,
    peerOpts: {
      config: { iceServers: opts.iceServers }
    }
  });

  const computeHasPeer = () => provider.awareness.getStates().size > 1;
  const updateHasPeer = (reason: string) => {
    const nowHasPeer = computeHasPeer();
    if (nowHasPeer) {
      if (!hasPeer) {
        hasPeer = true;
        stopThrottle();
        opts.onLog?.('signal:peer_detected', { reason });
      }
      return;
    }
    if (hasPeer) {
      hasPeer = false;
      startThrottleTimer(reason);
    }
  };

  const originalDestroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    stopThrottle(false);
    return originalDestroy();
  };

  startThrottleTimer('init');

  provider.awareness.on('change', (...args: unknown[]) => {
    opts.onAwarenessChange();
    updateHasPeer('awareness');
  });

  provider.on('status', (event) => {
    opts.onLog?.('provider:status', event);
  });

  provider.on('peers', (event) => {
    opts.onPeers?.({
      webrtcPeers: event.webrtcPeers || [],
      bcPeers: event.bcPeers || []
    });
    opts.onLog?.('provider:peers', event);
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
    });
    conn.on('disconnect', () => {
      updateStatus();
      opts.onLog?.('signal:disconnect', { url: conn.url });
    });
    conn.on('message', (message: unknown) => {
      updateStatus();
      opts.onLog?.('signal:recv', { url: conn.url, message });
    });

    const originalSend = conn.send.bind(conn);
    conn.send = (message: unknown) => {
      const doSend = () => {
        opts.onLog?.('signal:send', {
          url: conn.url,
          message,
          throttled: throttleActive,
          intervalMs: currentInterval()
        });
        originalSend(message);
      };
      scheduleSend(doSend);
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
