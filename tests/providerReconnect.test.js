import { describe, it, expect, vi } from 'vitest';

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

describe('webrtc reconnection', () => {
  it('replaces unhealthy peer on announce', async () => {
    const provider = await buildProvider();
    const { __created } = await import('y-webrtc');
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
});
