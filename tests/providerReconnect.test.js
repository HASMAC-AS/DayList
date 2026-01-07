import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    }
    send() {}
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
      this.awareness = new Awareness();
      this.doc = doc;
      this.room = {
        peerId: 'local',
        webrtcConns: new Map(),
        bcConns: new Set(),
        key: null,
        provider: this
      };
      this.signalingConns = (opts.signaling || []).map((url) => new SignalingConn(url));
    }
    destroy() {}
  }

  const created = [];

  class MockPeer extends Emitter {
    constructor() {
      super();
      this.connected = false;
      this.destroyed = false;
      this.destroying = false;
      this._channel = { readyState: 'connecting' };
      this._pc = { iceConnectionState: 'new', connectionState: 'new' };
    }
    destroy() {
      this.destroyed = true;
      this.emit('close');
    }
  }

  class WebrtcConn {
    constructor(signalingConn, initiator, remotePeerId, room) {
      this.remotePeerId = remotePeerId;
      this.peer = new MockPeer();
      this.closed = false;
      this.room = room;
      created.push(this);
    }
    destroy() {
      this.peer.destroy();
    }
  }

  return { WebrtcProvider, SignalingConn, WebrtcConn, __created: created };
});

const buildProvider = async (overrides = {}) => {
  const { connectProvider } = await import('../src/services/sync/provider');
  return connectProvider({
    doc: { ydoc: {} },
    room: 'room',
    enc: 'enc',
    signaling: ['wss://signal.example'],
    iceServers: [],
    onAwarenessChange: () => {},
    ...overrides
  });
};

describe('webrtc reconnection', () => {
  beforeEach(async () => {
    const { __created } = await import('../src/services/sync/webrtcProvider');
    __created.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replaces unhealthy peer on announce', async () => {
    const provider = await buildProvider();
    const { __created } = await import('../src/services/sync/webrtcProvider');
    const conn = provider.signalingConns[0];

    const unhealthyPeer = {
      connected: false,
      destroyed: false,
      destroying: false,
      _channel: { readyState: 'closed' },
      _pc: { iceConnectionState: 'failed', connectionState: 'failed' }
    };
    const existing = {
      peer: unhealthyPeer,
      closed: false,
      destroy: vi.fn()
    };

    provider.room.webrtcConns.set('peer-a', existing);

    conn.emit('message', [
      {
        type: 'publish',
        topic: 'room',
        data: { from: 'peer-a', type: 'announce' }
      }
    ]);

    expect(existing.destroy).toHaveBeenCalledTimes(1);
    expect(provider.room.webrtcConns.get('peer-a')).not.toBe(existing);
    expect(__created.length).toBe(1);
  });

  it('connects on signal when peer has no healthy connection', async () => {
    const provider = await buildProvider();
    const { __created } = await import('../src/services/sync/webrtcProvider');
    const conn = provider.signalingConns[0];

    conn.emit('message', [
      {
        type: 'publish',
        topic: 'room',
        data: { from: 'peer-a', type: 'signal', signal: { type: 'offer' } }
      }
    ]);

    expect(provider.room.webrtcConns.has('peer-a')).toBe(true);
    expect(__created.length).toBe(1);
  });

  it('marks peers disconnected on ICE failure', async () => {
    const onPeerState = vi.fn();
    const provider = await buildProvider({ onPeerState });
    const { __created } = await import('../src/services/sync/webrtcProvider');
    const conn = provider.signalingConns[0];

    conn.emit('message', [
      {
        type: 'publish',
        topic: 'room',
        data: { from: 'peer-a', type: 'announce' }
      }
    ]);

    const webrtcConn = __created[0];
    webrtcConn.peer.emit('iceStateChange', ['failed']);

    const iceCall = onPeerState.mock.calls.find((call) => call[0]?.event === 'ice_state');
    expect(iceCall?.[0]?.connected).toBe(false);
  });

  it('retries resync when initial resync fails', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const provider = await buildProvider();
    const { __created } = await import('../src/services/sync/webrtcProvider');
    const conn = provider.signalingConns[0];

    conn.emit('message', [
      {
        type: 'publish',
        topic: 'room',
        data: { from: 'peer-a', type: 'announce' }
      }
    ]);

    const webrtcConn = __created[0];
    webrtcConn.peer.connected = true;
    webrtcConn.peer.emit('connect');

    const hasResyncTimeout = setTimeoutSpy.mock.calls.some((call) => call[1] === 500);
    expect(hasResyncTimeout).toBe(true);
  });
});
