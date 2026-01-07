import * as map from 'lib0/map';
import * as random from 'lib0/random';
import * as math from 'lib0/math';
import { ObservableV2 } from 'lib0/observable';
import * as awarenessProtocol from 'y-protocols/awareness';
import { deriveKey } from './webrtcCrypto';
import { SignalingConn, openRoom, rooms, signalingConns } from './webrtcRuntime';

const emitStatus = (provider) => {
  provider.emit('status', [{ connected: provider.connected }]);
};

export class WebrtcProvider extends ObservableV2 {
  constructor(
    roomName,
    doc,
    {
      signaling = ['wss://y-webrtc-eu.fly.dev'],
      password = null,
      awareness = new awarenessProtocol.Awareness(doc),
      maxConns = 20 + math.floor(random.rand() * 15),
      filterBcConns = true,
      peerOpts = {}
    } = {}
  ) {
    super();
    this._destroyed = false;
    this.roomName = roomName;
    this.doc = doc;
    this.filterBcConns = filterBcConns;
    this.awareness = awareness;
    this.shouldConnect = false;
    this.signalingUrls = signaling;
    this.signalingConns = [];
    this.maxConns = maxConns;
    this.peerOpts = peerOpts;
    this.key = password ? deriveKey(password, roomName) : Promise.resolve(null);
    this.room = null;
    this.key
      .then((key) => {
      if (this._destroyed) return;
      this.room = openRoom(doc, this, roomName, key);
      if (this._destroyed) {
        this.room.destroy();
        rooms.delete(this.roomName);
        this.room = null;
        return;
      }
      if (this.shouldConnect) {
        this.room.connect();
      } else {
        this.room.disconnect();
      }
      emitStatus(this);
      })
      .catch(() => {});
    this.connect();
    this.destroy = this.destroy.bind(this);
    doc.on('destroy', this.destroy);
  }

  get connected() {
    return this.room !== null && this.shouldConnect;
  }

  connect() {
    if (this._destroyed) return;
    if (this.shouldConnect && this.signalingConns.length > 0) return;
    this.shouldConnect = true;
    this.signalingConns = [];
    this.signalingUrls.forEach((url) => {
      const signalingConn = map.setIfUndefined(signalingConns, url, () => new SignalingConn(url));
      this.signalingConns.push(signalingConn);
      signalingConn.providers.add(this);
    });
    if (this.room) {
      this.room.connect();
      emitStatus(this);
    }
  }

  disconnect() {
    this.shouldConnect = false;
    const conns = Array.from(new Set(this.signalingConns));
    this.signalingConns = [];
    conns.forEach((conn) => {
      conn.providers.delete(this);
      if (conn.providers.size === 0) {
        conn.destroy();
        signalingConns.delete(conn.url);
      }
    });
    if (this.room) {
      this.room.disconnect();
      emitStatus(this);
    }
  }

  destroy() {
    this._destroyed = true;
    this.disconnect();
    this.doc.off('destroy', this.destroy);
    this.key
      .then(() => {
        if (this.room) {
          this.room.destroy();
          this.room = null;
        }
        rooms.delete(this.roomName);
      })
      .catch(() => {});
    super.destroy();
  }
}

export { SignalingConn, WebrtcConn } from './webrtcRuntime';
