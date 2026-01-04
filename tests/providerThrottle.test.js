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
      this.room = room;
      this.doc = doc;
      this.signalingConns = (opts.signaling || []).map((url) => new SignalingConn(url));
      this.awareness = new Awareness();
    }
    destroy() {}
  }

  return { WebrtcProvider, SignalingConn };
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
  it('limits signaling sends to 1 per 100ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.send({ n: 1 });
    conn.send({ n: 2 });
    conn.send({ n: 3 });

    expect(conn.sendCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(conn.sendCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.sendCalls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(conn.sendCalls.length).toBe(3);
  });

  it('slows signaling to 1 per 5000ms after 1000ms without peers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.send({ n: 1 });
    conn.send({ n: 2 });

    await vi.advanceTimersByTimeAsync(1000);
    const before = conn.sendCalls.length;

    conn.send({ n: 3 });
    conn.send({ n: 4 });
    conn.send({ n: 5 });

    expect(conn.sendCalls.length).toBe(before + 1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(conn.sendCalls.length).toBe(before + 1);

    await vi.advanceTimersByTimeAsync(1);
    expect(conn.sendCalls.length).toBe(before + 2);
  });
});
