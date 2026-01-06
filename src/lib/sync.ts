export const STALE_PEER_LIST_MS = 8000;

type PeerWaitOptions = {
  peerCount: number;
  webrtcPeers: string[];
  bcPeers: string[];
  lastPeerListAt: number;
  now: number;
  sleptMs?: number;
  staleAfterMs?: number;
};

export const shouldWaitForPeers = ({
  peerCount,
  webrtcPeers,
  bcPeers,
  lastPeerListAt,
  now,
  sleptMs = 0,
  staleAfterMs = STALE_PEER_LIST_MS
}: PeerWaitOptions) => {
  if (peerCount > 0) return false;
  const peerTotal = (webrtcPeers?.length || 0) + (bcPeers?.length || 0);
  if (peerTotal === 0) return false;
  if (sleptMs > 0) return false;
  if (!lastPeerListAt) return false;
  return now - lastPeerListAt <= staleAfterMs;
};
