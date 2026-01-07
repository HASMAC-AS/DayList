import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/services/sync/webrtcProvider', () => {
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
  it('sends immediately without throttling', async () => {
    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    conn.send({ type: 'publish', topic: 'room', data: 'a' });
    conn.send({ type: 'publish', topic: 'room', data: 'b' });
    conn.send({ type: 'publish', topic: 'room', data: 'c' });

    expect(conn.sendCalls.length).toBe(3);
  });

  it('sends immediately even with active peers', async () => {
    const provider = await buildProvider();
    const conn = provider.signalingConns[0];

    provider.emit('peers', [{ webrtcPeers: ['peer-a'], bcPeers: [] }]);

    conn.send({ type: 'publish', topic: 'room', data: 'a' });
    conn.send({ type: 'publish', topic: 'room', data: 'b' });

    expect(conn.sendCalls.length).toBe(2);
  });
});
