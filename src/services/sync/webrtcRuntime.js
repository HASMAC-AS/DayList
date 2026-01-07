import * as ws from 'lib0/websocket';
import * as map from 'lib0/map';
import * as error from 'lib0/error';
import * as random from 'lib0/random';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as bc from 'lib0/broadcastchannel';
import * as buffer from 'lib0/buffer';
import { createMutex } from 'lib0/mutex';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { ensureWebrtcCompression } from './webrtcCompression';
import { decrypt, decryptJson, encrypt, encryptJson } from './webrtcCrypto';

let peerCtorPromise = null;
let peerCtor = null;

export const loadPeerCtor = () => {
  if (peerCtor) return Promise.resolve(peerCtor);
  if (peerCtorPromise) return peerCtorPromise;
  peerCtorPromise = import('@thaunknown/simple-peer/lite.js')
    .then((mod) => {
      peerCtor = mod?.default ?? mod;
      try {
        ensureWebrtcCompression(peerCtor);
      } catch (err) {
        console.error('[webrtc] Failed to enable compression:', err);
      }
      return peerCtor;
    })
    .catch((err) => {
      console.error('[webrtc] Failed to load Peer implementation:', err);
      return null;
    });
  return peerCtorPromise;
};

const MESSAGE_SYNC = 0;
const MESSAGE_QUERY_AWARENESS = 3;
const MESSAGE_AWARENESS = 1;
const MESSAGE_BC_PEER_ID = 4;

export const signalingConns = new Map();
export const rooms = new Map();

const checkIsSynced = (room) => {
  let synced = true;
  room.webrtcConns.forEach((peer) => {
    if (!peer.synced) synced = false;
  });
  if ((!synced && room.synced) || (synced && !room.synced)) {
    room.synced = synced;
    room.provider.emit('synced', [{ synced }]);
  }
};

const readMessage = (room, buf, syncedCallback) => {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  if (room === undefined) return null;
  const awareness = room.awareness;
  const doc = room.doc;
  let sendReply = false;
  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, room);
      if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !room.synced) {
        syncedCallback();
      }
      if (syncMessageType === syncProtocol.messageYjsSyncStep1) sendReply = true;
      break;
    }
    case MESSAGE_QUERY_AWARENESS:
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys()))
      );
      sendReply = true;
      break;
    case MESSAGE_AWARENESS:
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), room);
      break;
    case MESSAGE_BC_PEER_ID: {
      const add = decoding.readUint8(decoder) === 1;
      const peerName = decoding.readVarString(decoder);
      if (
        peerName !== room.peerId &&
        ((room.bcConns.has(peerName) && !add) || (!room.bcConns.has(peerName) && add))
      ) {
        const removed = [];
        const added = [];
        if (add) {
          room.bcConns.add(peerName);
          added.push(peerName);
        } else {
          room.bcConns.delete(peerName);
          removed.push(peerName);
        }
        room.provider.emit('peers', [
          {
            added,
            removed,
            webrtcPeers: Array.from(room.webrtcConns.keys()),
            bcPeers: Array.from(room.bcConns)
          }
        ]);
        broadcastBcPeerId(room);
      }
      break;
    }
    default:
      console.error('Unable to compute message');
      return encoder;
  }
  if (!sendReply) return null;
  return encoder;
};

const readPeerMessage = (peerConn, buf) => {
  const room = peerConn.room;
  return readMessage(room, buf, () => {
    peerConn.synced = true;
    checkIsSynced(room);
  });
};

const sendWebrtcConn = (webrtcConn, encoder) => {
  try {
    webrtcConn.peer.send(encoding.toUint8Array(encoder));
  } catch {
    // ignore
  }
};

const broadcastWebrtcConn = (room, m) => {
  room.webrtcConns.forEach((conn) => {
    try {
      conn.peer.send(m);
    } catch {
      // ignore
    }
  });
};

export class WebrtcConn {
  constructor(PeerCtor, signalingConn, initiator, remotePeerId, room) {
    this.room = room;
    this.remotePeerId = remotePeerId;
    this.glareToken = undefined;
    this.closed = false;
    this.connected = false;
    this.synced = false;
    this.peer = new PeerCtor({ initiator, ...room.provider.peerOpts });
    this.peer.on('signal', (signal) => {
      if (this.glareToken === undefined) {
        this.glareToken = Date.now() + Math.random();
      }
      publishSignalingMessage(signalingConn, room, {
        to: remotePeerId,
        from: room.peerId,
        type: 'signal',
        token: this.glareToken,
        signal
      });
    });
    this.peer.on('connect', () => {
      this.connected = true;
      const provider = room.provider;
      const doc = provider.doc;
      const awareness = room.awareness;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      sendWebrtcConn(this, encoder);
      const awarenessStates = awareness.getStates();
      if (awarenessStates.size > 0) {
        const encoderAw = encoding.createEncoder();
        encoding.writeVarUint(encoderAw, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoderAw,
          awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys()))
        );
        sendWebrtcConn(this, encoderAw);
      }
    });
    this.peer.on('close', () => {
      this.connected = false;
      this.closed = true;
      if (room.webrtcConns.has(this.remotePeerId)) {
        room.webrtcConns.delete(this.remotePeerId);
        room.provider.emit('peers', [
          {
            removed: [this.remotePeerId],
            added: [],
            webrtcPeers: Array.from(room.webrtcConns.keys()),
            bcPeers: Array.from(room.bcConns)
          }
        ]);
      }
      checkIsSynced(room);
      this.peer.destroy();
      announceSignalingInfo(room);
    });
    this.peer.on('error', () => {
      announceSignalingInfo(room);
    });
    this.peer.on('data', (data) => {
      const answer = readPeerMessage(this, data);
      if (answer !== null) {
        sendWebrtcConn(this, answer);
      }
    });
  }

  destroy() {
    this.peer.destroy();
  }
}

const broadcastBcMessage = (room, m) =>
  encrypt(m, room.key)
    .then((data) =>
      room.mux(() => {
        bc.publish(room.name, data);
      })
    )
    .catch(() => {});

const broadcastRoomMessage = (room, m) => {
  if (room.bcconnected) broadcastBcMessage(room, m);
  broadcastWebrtcConn(room, m);
};

const shouldInitiate = (localPeerId, remotePeerId) => {
  if (!localPeerId || !remotePeerId) return true;
  return localPeerId < remotePeerId;
};

const announceSignalingInfo = (room) => {
  signalingConns.forEach((conn) => {
    if (conn.connected) {
      conn.send({ type: 'subscribe', topics: [room.name] });
      if (room.webrtcConns.size < room.provider.maxConns) {
        publishSignalingMessage(conn, room, { type: 'announce', from: room.peerId });
      }
    }
  });
};

const broadcastBcPeerId = (room) => {
  if (room.provider.filterBcConns) {
    const encoderPeerIdBc = encoding.createEncoder();
    encoding.writeVarUint(encoderPeerIdBc, MESSAGE_BC_PEER_ID);
    encoding.writeUint8(encoderPeerIdBc, 1);
    encoding.writeVarString(encoderPeerIdBc, room.peerId);
    broadcastBcMessage(room, encoding.toUint8Array(encoderPeerIdBc));
  }
};

export class Room {
  constructor(doc, provider, name, key) {
    this.peerId = random.uuidv4();
    this.doc = doc;
    this.awareness = provider.awareness;
    this.provider = provider;
    this.synced = false;
    this.name = name;
    this.key = key;
    this.webrtcConns = new Map();
    this.bcConns = new Set();
    this.mux = createMutex();
    this.bcconnected = false;
    this._bcSubscriber = (data) =>
      decrypt(new Uint8Array(data), key)
        .then((m) =>
          this.mux(() => {
            const reply = readMessage(this, m, () => {});
            if (reply) {
              broadcastBcMessage(this, encoding.toUint8Array(reply));
            }
          })
        )
        .catch(() => {});
    this._docUpdateHandler = (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      broadcastRoomMessage(this, encoding.toUint8Array(encoder));
    };
    this._awarenessUpdateHandler = ({ added, updated, removed }) => {
      const changedClients = added.concat(updated).concat(removed);
      const encoderAwareness = encoding.createEncoder();
      encoding.writeVarUint(encoderAwareness, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoderAwareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      broadcastRoomMessage(this, encoding.toUint8Array(encoderAwareness));
    };
    this._beforeUnloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload');
      rooms.forEach((room) => {
        room.disconnect();
      });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._beforeUnloadHandler);
    } else if (typeof process !== 'undefined') {
      process.on('exit', this._beforeUnloadHandler);
    }
  }

  connect() {
    this.doc.on('update', this._docUpdateHandler);
    this.awareness.on('update', this._awarenessUpdateHandler);
    announceSignalingInfo(this);
    const roomName = this.name;
    bc.subscribe(roomName, this._bcSubscriber);
    this.bcconnected = true;
    broadcastBcPeerId(this);
    const encoderSync = encoding.createEncoder();
    encoding.writeVarUint(encoderSync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoderSync, this.doc);
    broadcastBcMessage(this, encoding.toUint8Array(encoderSync));
    const encoderState = encoding.createEncoder();
    encoding.writeVarUint(encoderState, MESSAGE_SYNC);
    syncProtocol.writeSyncStep2(encoderState, this.doc);
    broadcastBcMessage(this, encoding.toUint8Array(encoderState));
    const encoderAwarenessQuery = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessQuery, MESSAGE_QUERY_AWARENESS);
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessQuery));
    const encoderAwarenessState = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessState, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
    );
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessState));
  }

  disconnect() {
    signalingConns.forEach((conn) => {
      if (conn.connected) {
        conn.send({ type: 'unsubscribe', topics: [this.name] });
      }
    });
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'disconnect');
    const encoderPeerIdBc = encoding.createEncoder();
    encoding.writeVarUint(encoderPeerIdBc, MESSAGE_BC_PEER_ID);
    encoding.writeUint8(encoderPeerIdBc, 0);
    encoding.writeVarString(encoderPeerIdBc, this.peerId);
    broadcastBcMessage(this, encoding.toUint8Array(encoderPeerIdBc));

    bc.unsubscribe(this.name, this._bcSubscriber);
    this.bcconnected = false;
    this.doc.off('update', this._docUpdateHandler);
    this.awareness.off('update', this._awarenessUpdateHandler);
    this.webrtcConns.forEach((conn) => conn.destroy());
  }

  destroy() {
    this.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    } else if (typeof process !== 'undefined') {
      process.off('exit', this._beforeUnloadHandler);
    }
  }
}

export const openRoom = (doc, provider, name, key) => {
  if (rooms.has(name)) {
    throw error.create(`A Yjs Doc connected to room "${name}" already exists!`);
  }
  const room = new Room(doc, provider, name, key);
  rooms.set(name, room);
  return room;
};

const publishSignalingMessage = (conn, room, data) => {
  if (room.key) {
    encryptJson(data, room.key)
      .then((encrypted) => {
        conn.send({ type: 'publish', topic: room.name, data: buffer.toBase64(encrypted) });
      })
      .catch(() => {});
  } else {
    conn.send({ type: 'publish', topic: room.name, data });
  }
};

export class SignalingConn extends ws.WebsocketClient {
  constructor(url) {
    super(url);
    this.providers = new Set();
    this.on('connect', () => {
      const topics = Array.from(rooms.keys());
      this.send({ type: 'subscribe', topics });
      rooms.forEach((room) =>
        publishSignalingMessage(this, room, { type: 'announce', from: room.peerId })
      );
    });
    this.on('message', (m) => {
      switch (m.type) {
        case 'publish': {
          const roomName = m.topic;
          const room = rooms.get(roomName);
          if (room == null || typeof roomName !== 'string') return;
          const execMessage = (data) => {
            const webrtcConns = room.webrtcConns;
            const peerId = room.peerId;
            if (
              data == null ||
              data.from === peerId ||
              (data.to !== undefined && data.to !== peerId) ||
              room.bcConns.has(data.from)
            ) {
              return;
            }
            const emitPeerChange = () =>
              room.provider.emit('peers', [
                {
                  removed: [],
                  added: [data.from],
                  webrtcPeers: Array.from(room.webrtcConns.keys()),
                  bcPeers: Array.from(room.bcConns)
                }
              ]);
            switch (data.type) {
              case 'announce':
                if (webrtcConns.size < room.provider.maxConns && shouldInitiate(peerId, data.from)) {
                  loadPeerCtor().then((PeerCtor) => {
                    if (!PeerCtor) return;
                    if (webrtcConns.size >= room.provider.maxConns) return;
                    if (webrtcConns.has(data.from)) return;
                    map.setIfUndefined(
                      webrtcConns,
                      data.from,
                      () => new WebrtcConn(PeerCtor, this, true, data.from, room)
                    );
                    emitPeerChange();
                  });
                }
                break;
              case 'signal':
                if (data.signal.type === 'offer') {
                  const existingConn = webrtcConns.get(data.from);
                  if (existingConn) {
                    const remoteToken = data.token;
                    const localToken = existingConn.glareToken;
                    if (localToken && localToken > remoteToken) return;
                    existingConn.glareToken = undefined;
                  }
                }
                if (data.signal.type === 'answer') {
                  const existingConn = webrtcConns.get(data.from);
                  if (existingConn) existingConn.glareToken = undefined;
                }
                if (data.to === peerId) {
                  const existingConn = webrtcConns.get(data.from);
                  if (existingConn) {
                    existingConn.peer.signal(data.signal);
                  } else {
                    loadPeerCtor().then((PeerCtor) => {
                      if (!PeerCtor) return;
                      const hadConn = webrtcConns.has(data.from);
                      const conn = map.setIfUndefined(
                        webrtcConns,
                        data.from,
                        () => new WebrtcConn(PeerCtor, this, false, data.from, room)
                      );
                      conn.peer.signal(data.signal);
                      if (!hadConn) emitPeerChange();
                    });
                  }
                }
                break;
              default:
                break;
            }
          };
          if (room.key) {
            if (typeof m.data === 'string') {
              decryptJson(buffer.fromBase64(m.data), room.key).then(execMessage).catch(() => {});
            }
          } else {
            execMessage(m.data);
          }
          break;
        }
        default:
          break;
      }
    });
  }
}
