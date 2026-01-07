import { describe, it, expect, afterEach } from 'vitest';

import { ensureWebrtcCompression } from '../src/services/sync/webrtcCompression';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('webrtc compression', () => {
  const originalRtc = globalThis.RTCPeerConnection;

  afterEach(() => {
    if (originalRtc === undefined) {
      delete globalThis.RTCPeerConnection;
    } else {
      globalThis.RTCPeerConnection = originalRtc;
    }
  });

  it('compresses outgoing payloads and restores incoming payloads', async () => {
    globalThis.RTCPeerConnection = function RTCPeerConnection() {};

    class FakePeer {
      constructor() {
        this.sent = [];
        this.received = [];
        this.destroyed = false;
        this.destroying = false;
      }
      send(data) {
        this.sent.push(data);
      }
      _onChannelMessage(event) {
        this.received.push(event.data);
      }
      destroy() {}
    }

    ensureWebrtcCompression(FakePeer);

    const peer = new FakePeer();
    peer.send('hello');
    await flush();

    expect(peer.sent.length).toBe(1);
    expect(peer.sent[0]).toBeInstanceOf(Uint8Array);

    peer._onChannelMessage({ data: peer.sent[0] });
    await flush();

    expect(peer.received).toEqual(['hello']);
  });
});
