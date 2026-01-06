import { afterEach, describe, expect, it, vi } from 'vitest';

const stunServers = [{ urls: 'stun:stun.example.com' }];
const turnServers = [{ urls: 'turn:turn.example.com', username: 'user', credential: 'pass' }];
let fastResult;

vi.mock('../src/services/sync/meteredTurn', () => ({
  getIceServersFast: vi.fn(() => fastResult),
  getStunFallback: vi.fn(() => stunServers)
}));

vi.mock('../src/services/sync/provider', () => ({
  connectProvider: vi.fn(async () => ({
    destroy: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn()
  }))
}));

import { createSyncSession } from '../src/services/sync/session';
import { getIceServersFast } from '../src/services/sync/meteredTurn';
import { connectProvider } from '../src/services/sync/provider';

describe('sync session ICE upgrade', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('retries TURN upgrade once peers disconnect', async () => {
    vi.useFakeTimers();
    let resolveRefresh;
    const refresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    fastResult = {
      initial: stunServers,
      initialSource: 'stun-fallback',
      refresh
    };

    const session = await createSyncSession({
      doc: { ydoc: {} },
      room: 'room',
      enc: 'enc',
      signaling: [],
      turnKey: 'key',
      turnEnabled: true,
      fetchFn: vi.fn(),
      storage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn()
      },
      platform: { isIPhone: false }
    });

    await session.start('test');

    const firstOpts = connectProvider.mock.calls[0][0];
    firstOpts.onPeers({ webrtcPeers: ['peer-a'], bcPeers: [] });

    resolveRefresh({ iceServers: turnServers, source: 'turn-fetch' });
    await Promise.resolve();

    expect(connectProvider).toHaveBeenCalledTimes(1);

    firstOpts.onPeers({ webrtcPeers: [], bcPeers: [] });
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    expect(connectProvider).toHaveBeenCalledTimes(2);
    const secondOpts = connectProvider.mock.calls[1][0];
    const hasTurn = secondOpts.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
        String(url).startsWith('turn:')
      )
    );
    expect(hasTurn).toBe(true);
  });

  it('refreshes TURN credentials on restart', async () => {
    vi.useFakeTimers();
    fastResult = {
      initial: stunServers,
      initialSource: 'stun-fallback'
    };

    const session = await createSyncSession({
      doc: { ydoc: {} },
      room: 'room',
      enc: 'enc',
      signaling: [],
      turnKey: 'key',
      turnEnabled: true,
      fetchFn: vi.fn(),
      storage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn()
      },
      platform: { isIPhone: false }
    });

    await session.start('test');
    expect(getIceServersFast).toHaveBeenCalledTimes(1);
    expect(connectProvider).toHaveBeenCalledTimes(1);

    let resolveRefresh;
    const refresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    fastResult = {
      initial: stunServers,
      initialSource: 'stun-fallback',
      refresh
    };

    await session.restart('resume');
    expect(getIceServersFast).toHaveBeenCalledTimes(2);
    expect(connectProvider).toHaveBeenCalledTimes(2);

    resolveRefresh({ iceServers: turnServers, source: 'turn-fetch' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    expect(connectProvider).toHaveBeenCalledTimes(3);
    const lastOpts = connectProvider.mock.calls[2][0];
    const hasTurn = lastOpts.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
        String(url).startsWith('turn:')
      )
    );
    expect(hasTurn).toBe(true);
  });
});
