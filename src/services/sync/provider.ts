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
  const provider = new WebrtcProvider(opts.room, opts.doc.ydoc, {
    password: opts.enc,
    signaling: opts.signaling,
    peerOpts: {
      config: { iceServers: opts.iceServers }
    }
  });

  provider.awareness.on('change', opts.onAwarenessChange);

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
      opts.onLog?.('signal:send', { url: conn.url, message });
      originalSend(message);
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
