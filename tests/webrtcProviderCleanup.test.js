import { describe, it, expect, vi, afterEach } from 'vitest';

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

  const openRoom = (_doc, _provider, name) => {
    const room = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn()
    };
    rooms.set(name, room);
    return room;
  };

  return { SignalingConn, signalingConns, rooms, openRoom, WebrtcConn: class {} };
});

const flush = () => Promise.resolve();

afterEach(async () => {
  const { signalingConns, rooms } = await import('../src/services/sync/webrtcRuntime');
  signalingConns.clear();
  rooms.clear();
  vi.clearAllMocks();
});

describe('webrtc provider cleanup', () => {
  it('disconnects signaling connections on destroy', async () => {
    const { WebrtcProvider } = await import('../src/services/sync/webrtcProvider');
    const { signalingConns } = await import('../src/services/sync/webrtcRuntime');

    const doc = { on: vi.fn(), off: vi.fn() };
    const provider = new WebrtcProvider('room', doc, { signaling: ['wss://a', 'wss://b'] });

    await flush();

    const conns = Array.from(signalingConns.values());
    expect(conns).toHaveLength(2);
    conns.forEach((conn) => {
      expect(conn.providers.has(provider)).toBe(true);
    });

    provider.destroy();

    conns.forEach((conn) => {
      expect(conn.providers.has(provider)).toBe(false);
      expect(conn.destroy).toHaveBeenCalledTimes(1);
    });
    expect(signalingConns.size).toBe(0);
  });
});
