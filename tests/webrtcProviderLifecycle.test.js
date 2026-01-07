import { describe, it, expect, vi, afterEach } from 'vitest';

let keyPromise = Promise.resolve(null);

vi.mock('../src/services/sync/webrtcCrypto', () => ({
  deriveKey: vi.fn(() => keyPromise)
}));

vi.mock('../src/services/sync/webrtcRuntime', () => {
  const signalingConns = new Map();
  const rooms = new Map();

  class SignalingConn {
    constructor(url) {
      this.url = url;
      this.providers = new Set();
      this.destroy = vi.fn();
    }
  }

  const openRoom = vi.fn((_doc, _provider, name) => {
    const room = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn()
    };
    rooms.set(name, room);
    return room;
  });

  return { SignalingConn, signalingConns, rooms, openRoom, WebrtcConn: class {} };
});

const flush = () => Promise.resolve();

afterEach(async () => {
  const { signalingConns, rooms } = await import('../src/services/sync/webrtcRuntime');
  signalingConns.clear();
  rooms.clear();
  keyPromise = Promise.resolve(null);
  vi.clearAllMocks();
});

describe('webrtc provider lifecycle', () => {
  it('skips opening room if destroyed before key resolves', async () => {
    let resolveKey = () => {};
    keyPromise = new Promise((resolve) => {
      resolveKey = resolve;
    });

    const { WebrtcProvider } = await import('../src/services/sync/webrtcProvider');
    const { openRoom } = await import('../src/services/sync/webrtcRuntime');

    const doc = { on: vi.fn(), off: vi.fn() };
    const provider = new WebrtcProvider('room', doc, {
      signaling: ['wss://a'],
      password: 'secret'
    });

    provider.destroy();
    resolveKey(null);
    await flush();
    await flush();

    expect(openRoom).not.toHaveBeenCalled();
  });

  it('clears signaling connections between reconnects', async () => {
    keyPromise = Promise.resolve(null);

    const { WebrtcProvider } = await import('../src/services/sync/webrtcProvider');
    const doc = { on: vi.fn(), off: vi.fn() };
    const provider = new WebrtcProvider('room', doc, {
      signaling: ['wss://a', 'wss://b']
    });

    await flush();

    provider.disconnect();
    provider.connect();
    provider.disconnect();
    provider.connect();

    expect(provider.signalingConns).toHaveLength(2);
  });
});
