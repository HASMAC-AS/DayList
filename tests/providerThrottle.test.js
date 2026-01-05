import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('y-webrtc', () => {
  class Emitter {
    constructor() {
      this.listeners = new Map();
    }
    on(event, handler) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(handler);
    }
    emit(event, args = []) {
      const list = this.listeners.get(event) || [];
      list.forEach((fn) => fn(...args));
    }
  }

  class SignalingConn extends Emitter {
    constructor(url) {
      super();
      this.url = url;
      this.connected = false;
      this.connecting = false;
      this.lastMessageReceived = 0;
      this.sendCalls = [];
    }
    send(message) {
      this.sendCalls.push({ ts: Date.now(), message });
    }
  }

  class Awareness extends Emitter {
    constructor() {
      super();
      this.states = new Map([['local', {}]]);
    }
    getStates() {
      return this.states;
    }
  }

  class WebrtcProvider extends Emitter {
    constructor(room, doc, opts) {
      super();
      this.room = { peerId: 'local', webrtcConns: new Map(), key: null };
      this.doc = doc;
      this.signalingConns = (opts.signaling || []).map((url) => new SignalingConn(url));
      this.awareness = new Awareness();
    }
    destroy() {}
  }

  class WebrtcConn {
    constructor() {}
  }

  return { WebrtcProvider, SignalingConn, WebrtcConn };
});

const buildProvider = async () => {
  const { connectProvider } = await import('../src/services/sync/provider');
  return connectProvider({
    doc: { ydoc: {} },
    room: 'room',
    enc: 'enc',
    signaling: ['wss://signal.example'],
    iceServers: [],
    onAwarenessChange: () => {}
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('signaling throttling', () => {
  it('sends a 3-message startup burst, then 1 per discovery interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.emit('connect');

    conn.send({ type: 'publish', topic: 'room', data: 'a' });
    conn.send({ type: 'publish', topic: 'room', data: 'b' });
    conn.send({ type: 'publish', topic: 'room', data: 'c' });
    conn.send({ type: 'publish', topic: 'room', data: 'd' });

    expect(conn.sendCalls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(249);
    expect(conn.sendCalls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.sendCalls.length).toBe(4);
  });

  it('throttles to 1 per steady interval after a peer connects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    provider.emit('peers', [{ webrtcPeers: ['peer-a'], bcPeers: [] }]);

    conn.send({ type: 'publish', topic: 'room', data: 'a' });
    conn.send({ type: 'publish', topic: 'room', data: 'b' });

    expect(conn.sendCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(44_999);
    expect(conn.sendCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.sendCalls.length).toBe(1);
  });

  it('sends immediately when a new peer appears after 5 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    vi.setSystemTime(5 * 60 * 1000 + 1);
    conn.emit('message', [{ type: 'subscribe', from: 'peer-a', topics: ['room'] }]);

    conn.send({ type: 'publish', topic: 'room', data: 'a' });
    conn.send({ type: 'publish', topic: 'room', data: 'b' });

    expect(conn.sendCalls.length).toBe(2);
  });

  it('returns to discovery interval after peers go away', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    provider.emit('peers', [{ webrtcPeers: ['peer-a'], bcPeers: [] }]);
    provider.emit('peers', [{ webrtcPeers: [], bcPeers: [] }]);

    await vi.advanceTimersByTimeAsync(15_000);

    conn.send({ type: 'publish', topic: 'room', data: 'a' });
    conn.send({ type: 'publish', topic: 'room', data: 'b' });

    expect(conn.sendCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(249);
    expect(conn.sendCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.sendCalls.length).toBe(1);
  });

  it('sends announce immediately on peer discovery burst', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.emit('message', [{ type: 'subscribe', from: 'peer-a', topics: ['room'] }]);

    conn.send({ type: 'publish', topic: 'room', data: { type: 'announce', from: 'peer-b' } });
    conn.send({ type: 'publish', topic: 'room', data: { type: 'announce', from: 'peer-c' } });

    expect(conn.sendCalls.length).toBe(2);
  });
});
