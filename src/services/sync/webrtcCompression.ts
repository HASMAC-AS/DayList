import Peer from 'simple-peer/simplepeer.min.js';
import { errToObj } from '../../lib/core';

type CompressionFormat = 'deflate' | 'gzip';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
type LogFn = (event: string, data?: unknown, level?: LogLevel) => void;

const DEFAULT_FORMAT: CompressionFormat = 'gzip';
const TYPE_BINARY = 0;
const TYPE_TEXT = 1;

const sendQueue = new WeakMap<object, Promise<void>>();
const recvQueue = new WeakMap<object, Promise<void>>();
let patched = false;

const supportsCompression = () =>
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const toUint8 = async (input: unknown): Promise<Uint8Array> => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new Error('Unsupported WebRTC payload type.');
};

const toArrayBuffer = (data: Uint8Array) =>
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

const compress = async (payload: Uint8Array, format: CompressionFormat) => {
  const stream = new CompressionStream(format);
  const writer = stream.writable.getWriter();
  await writer.write(payload);
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
};

const decompress = async (payload: Uint8Array, format: CompressionFormat) => {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  await writer.write(payload);
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
};

const packPayload = async (input: unknown) => {
  if (typeof input === 'string') {
    if (!encoder) throw new Error('TextEncoder unavailable.');
    const encoded = encoder.encode(input);
    const out = new Uint8Array(encoded.length + 1);
    out[0] = TYPE_TEXT;
    out.set(encoded, 1);
    return out;
  }
  const data = await toUint8(input);
  const out = new Uint8Array(data.length + 1);
  out[0] = TYPE_BINARY;
  out.set(data, 1);
  return out;
};

const unpackPayload = (data: Uint8Array) => {
  if (data.length === 0) throw new Error('Empty WebRTC payload.');
  const type = data[0];
  const body = data.subarray(1);
  if (type === TYPE_BINARY) {
    return { type: 'binary' as const, data: body };
  }
  if (type === TYPE_TEXT) {
    if (!decoder) throw new Error('TextDecoder unavailable.');
    return { type: 'text' as const, data: decoder.decode(body) };
  }
  throw new Error(`Unknown WebRTC payload type: ${type}`);
};

const queueTask = (map: WeakMap<object, Promise<void>>, peer: object, task: () => Promise<void>) => {
  const prev = map.get(peer) || Promise.resolve();
  const next = prev.then(task, task);
  map.set(peer, next.catch(() => {}));
};

const handleCompressionError = (peer: any, error: unknown, stage: 'send' | 'recv', onLog?: LogFn) => {
  onLog?.('webrtc:compression_error', { stage, error: errToObj(error) }, 'ERROR');
  if (!peer || typeof peer.destroy !== 'function') return;
  if (peer.destroyed || peer.destroying) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    peer.destroy(err);
  } catch {
    // ignore
  }
};

export function ensureWebrtcCompression(opts?: { format?: CompressionFormat; onLog?: LogFn }) {
  if (patched) return;
  if (typeof RTCPeerConnection === 'undefined') return;
  if (!supportsCompression()) {
    opts?.onLog?.('webrtc:compression_missing', { reason: 'CompressionStream unavailable.' }, 'ERROR');
    throw new Error('WebRTC compression requires CompressionStream/DecompressionStream support.');
  }

  const format = opts?.format ?? DEFAULT_FORMAT;
  patched = true;
  opts?.onLog?.('webrtc:compression_enabled', { format });
  const originalSend = Peer.prototype.send;
  const originalOnChannelMessage = Peer.prototype._onChannelMessage;

  Peer.prototype.send = function sendCompressed(chunk: unknown) {
    const peer = this as any;
    queueTask(sendQueue, peer, async () => {
      try {
        if (peer.destroyed || peer.destroying) return;
        const payload = await packPayload(chunk);
        const compressed = await compress(payload, format);
        if (peer.destroyed || peer.destroying) return;
        originalSend.call(peer, compressed);
      } catch (error) {
        handleCompressionError(peer, error, 'send', opts?.onLog);
      }
    });
  };

  Peer.prototype._onChannelMessage = function onCompressedMessage(event: { data?: unknown }) {
    const peer = this as any;
    if (peer.destroyed) return;
    queueTask(recvQueue, peer, async () => {
      try {
        if (peer.destroyed) return;
        const input = await toUint8(event?.data);
        const decompressed = await decompress(input, format);
        const unpacked = unpackPayload(decompressed);
        if (peer.destroyed) return;
        if (unpacked.type === 'text') {
          originalOnChannelMessage.call(peer, { data: unpacked.data });
          return;
        }
        originalOnChannelMessage.call(peer, { data: toArrayBuffer(unpacked.data) });
      } catch (error) {
        handleCompressionError(peer, error, 'recv', opts?.onLog);
      }
    });
  };
}
