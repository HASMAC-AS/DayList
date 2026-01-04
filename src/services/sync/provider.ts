import { WebrtcProvider } from 'y-webrtc';
import type { YDocHandles } from './ydoc';

export interface ProviderStatus {
  connected: boolean;
  peers: number;
  usingTurn: boolean;
  signaling: string[];
}

export async function connectProvider(opts: {
  doc: YDocHandles;
  room: string;
  enc: string;
  signaling: string[];
  iceServers: RTCIceServer[];
  onAwarenessChange: () => void;
}): Promise<WebrtcProvider> {
  const provider = new WebrtcProvider(opts.room, opts.doc.ydoc, {
    password: opts.enc,
    signaling: opts.signaling,
    peerOpts: {
      config: { iceServers: opts.iceServers }
    }
  });

  provider.awareness.on('change', opts.onAwarenessChange);
  return provider;
}

export function getPeerCount(provider: WebrtcProvider | null) {
  if (!provider) return 0;
  return Math.max(0, provider.awareness.getStates().size - 1);
}
