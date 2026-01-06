import { describe, expect, it } from 'vitest';
import { STALE_PEER_LIST_MS, shouldWaitForPeers } from '../src/lib/sync.ts';

describe('resume peer wait heuristics', () => {
  it('waits for fresh pending peers when not slept', () => {
    const lastPeerListAt = 10_000;
    const now = lastPeerListAt + STALE_PEER_LIST_MS - 500;
    expect(
      shouldWaitForPeers({
        peerCount: 0,
        webrtcPeers: ['peer-a'],
        bcPeers: [],
        lastPeerListAt,
        now
      })
    ).toBe(true);
  });

  it('does not wait for peers after a suspend/resume', () => {
    const lastPeerListAt = 10_000;
    const now = lastPeerListAt + 1000;
    expect(
      shouldWaitForPeers({
        peerCount: 0,
        webrtcPeers: ['peer-a'],
        bcPeers: [],
        lastPeerListAt,
        now,
        sleptMs: 2500
      })
    ).toBe(false);
  });

  it('does not wait for peers when the list is stale', () => {
    const lastPeerListAt = 10_000;
    const now = lastPeerListAt + STALE_PEER_LIST_MS + 1;
    expect(
      shouldWaitForPeers({
        peerCount: 0,
        webrtcPeers: ['peer-a'],
        bcPeers: [],
        lastPeerListAt,
        now
      })
    ).toBe(false);
  });

  it('does not wait without peers or when already connected', () => {
    expect(
      shouldWaitForPeers({
        peerCount: 0,
        webrtcPeers: [],
        bcPeers: [],
        lastPeerListAt: 0,
        now: 1000
      })
    ).toBe(false);
    expect(
      shouldWaitForPeers({
        peerCount: 1,
        webrtcPeers: ['peer-a'],
        bcPeers: [],
        lastPeerListAt: 1000,
        now: 1500
      })
    ).toBe(false);
  });
});
