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
  it('sends a 3-message startup burst at 100ms spacing, then 1 per 1000ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.emit('connect');

    conn.send({ n: 1 });
    conn.send({ n: 2 });
    conn.send({ n: 3 });
    conn.send({ n: 4 });

    expect(conn.sendCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(conn.sendCalls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(conn.sendCalls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(100);
    expect(conn.sendCalls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(900);
    expect(conn.sendCalls.length).toBe(4);
  });

  it('throttles to 1 per 30s after a peer is discovered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.emit('message', [{ type: 'subscribe', from: 'peer-a', topics: ['room'] }]);

    conn.send({ n: 1 });
    conn.send({ n: 2 });

    expect(conn.sendCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(conn.sendCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.sendCalls.length).toBe(2);
  });

  it('sends immediately when a new peer appears after 5 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    vi.setSystemTime(5 * 60 * 1000 + 1);
    conn.emit('message', [{ type: 'subscribe', from: 'peer-a', topics: ['room'] }]);

    conn.send({ n: 1 });
    conn.send({ n: 2 });

    expect(conn.sendCalls.length).toBe(2);
  });
});
