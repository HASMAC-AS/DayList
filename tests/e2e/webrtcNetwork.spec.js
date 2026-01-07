import { test, expect } from '@playwright/test';
import WebSocket, { WebSocketServer } from 'ws';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import crypto from 'node:crypto';

const TURN_IMAGE = process.env.DAYLIST_TURN_IMAGE || 'coturn/coturn:4.6.2';
const TURN_USER = 'daylist';
const TURN_PASS = 'daylist-pass';

const dockerAvailable = () => {
  if (process.env.DAYLIST_E2E_WEBRTC === '0') return false;
  const res = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return res.status === 0;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const startSignalingServer = async () => {
  const port = await getFreePort();
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const topicsBySocket = new Map();
  const peersBySocket = new Map();
  const peersByTopic = new Map();

  const listPeers = (topics) => {
    const peers = new Set();
    topics.forEach((topic) => {
      const entries = peersByTopic.get(topic);
      if (!entries) return;
      entries.forEach((peerId) => peers.add(peerId));
    });
    return Array.from(peers);
  };

  const broadcast = (topic, message) => {
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
      const topics = topicsBySocket.get(client);
      if (!topics || !topics.has(topic)) return;
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  };

  const recordPeer = (socket, topic, peerId) => {
    if (!peerId) return;
    const socketPeers = peersBySocket.get(socket);
    if (!socketPeers) return;
    let topicPeers = socketPeers.get(topic);
    if (!topicPeers) {
      topicPeers = new Set();
      socketPeers.set(topic, topicPeers);
    }
    if (topicPeers.has(peerId)) return;
    topicPeers.add(peerId);

    let allPeers = peersByTopic.get(topic);
    if (!allPeers) {
      allPeers = new Set();
      peersByTopic.set(topic, allPeers);
    }
    allPeers.add(peerId);
    broadcast(topic, { type: 'peer-joined', id: peerId, room: topic });
  };

  wss.on('connection', (socket) => {
    topicsBySocket.set(socket, new Set());
    peersBySocket.set(socket, new Map());

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'subscribe') {
        const topics = Array.isArray(msg.topics) ? msg.topics.filter((topic) => typeof topic === 'string') : [];
        const socketTopics = topicsBySocket.get(socket);
        if (socketTopics) {
          topics.forEach((topic) => socketTopics.add(topic));
        }
        const peers = listPeers(topics);
        socket.send(JSON.stringify({ type: 'welcome', peers }));
        return;
      }

      if (msg.type === 'unsubscribe') {
        const topics = Array.isArray(msg.topics) ? msg.topics.filter((topic) => typeof topic === 'string') : [];
        const socketTopics = topicsBySocket.get(socket);
        if (socketTopics) {
          topics.forEach((topic) => socketTopics.delete(topic));
        }
        return;
      }

      if (msg.type === 'publish' && typeof msg.topic === 'string') {
        if (msg.data && typeof msg.data === 'object') {
          const data = msg.data;
          if (data.type === 'announce' && typeof data.from === 'string') {
            recordPeer(socket, msg.topic, data.from);
          }
        }
        broadcast(msg.topic, msg);
      }
    });

    socket.on('close', () => {
      const socketPeers = peersBySocket.get(socket);
      if (socketPeers) {
        socketPeers.forEach((peerIds, topic) => {
          const allPeers = peersByTopic.get(topic);
          if (!allPeers) return;
          peerIds.forEach((peerId) => {
            allPeers.delete(peerId);
            broadcast(topic, { type: 'peer-left', id: peerId, room: topic });
          });
          if (allPeers.size === 0) peersByTopic.delete(topic);
        });
      }
      topicsBySocket.delete(socket);
      peersBySocket.delete(socket);
    });
  });

  const close = () =>
    new Promise((resolve) => {
      wss.close(() => resolve());
    });

  return { port, url: `ws://127.0.0.1:${port}`, close };
};

const startTurnServer = async () => {
  const turnPort = await getFreePort();
  const relayPort = await getFreePort();
  const name = `daylist-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const output = [];
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '-p',
    `127.0.0.1:${turnPort}:3478/udp`,
    '-p',
    `127.0.0.1:${turnPort}:3478/tcp`,
    '-p',
    `127.0.0.1:${relayPort}:${relayPort}/udp`,
    TURN_IMAGE,
    '--no-cli',
    '--no-tls',
    '--no-dtls',
    '--fingerprint',
    '--realm',
    'daylist',
    '--lt-cred-mech',
    '--user',
    `${TURN_USER}:${TURN_PASS}`,
    '--external-ip',
    '127.0.0.1',
    '--min-port',
    String(relayPort),
    '--max-port',
    String(relayPort)
  ];

  const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (chunk) => output.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => output.push(chunk.toString()));

  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });

  await delay(800);
  if (exited) {
    const combined = output.join('').trim();
    throw new Error(`TURN server failed to start${combined ? `: ${combined}` : ''}`);
  }

  const stop = async () => {
    spawnSync('docker', ['stop', name], { stdio: 'ignore' });
    await once(proc, 'exit').catch(() => {});
  };

  return { turnPort, relayPort, username: TURN_USER, credential: TURN_PASS, stop };
};

const buildHeadlessUrl = ({ room, enc, sig, turnKey }) => {
  const params = new URLSearchParams();
  params.set('room', room);
  params.set('enc', enc);
  params.set('sig', sig);
  params.set('turnKey', turnKey);
  params.set('turn', '1');
  return `/headless.html?${params.toString()}`;
};

const createPeer = async (browser, opts) => {
  const context = await browser.newContext();
  await context.route('**/metered.live/api/v1/turn/credentials**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          urls: [
            `turn:127.0.0.1:${opts.turnPort}?transport=udp`,
            `turn:127.0.0.1:${opts.turnPort}?transport=tcp`
          ],
          username: opts.turnUser,
          credential: opts.turnPass
        }
      ])
    })
  );
  const page = await context.newPage();
  await page.goto(buildHeadlessUrl(opts), { waitUntil: 'domcontentloaded' });
  return { context, page };
};

const waitForPeers = async (page, expectedPeers) => {
  await page.waitForFunction(
    (count) => {
      const status = window.daylistHeadless?.status;
      if (!status) return false;
      const signalingOk = Array.isArray(status.signaling) && status.signaling.some((item) => item.connected);
      return status.connected && signalingOk && status.peers >= count;
    },
    expectedPeers,
    { timeout: 25_000 }
  );
  await page.waitForFunction(() => window.daylistHeadless?.status?.usingTurn === true, null, {
    timeout: 25_000
  });
};

test.describe('WebRTC network', () => {
  test.skip(!dockerAvailable(), 'Docker not available for TURN server.');

  test('connects multiple clients via signaling + turn', async ({ browser }) => {
    test.setTimeout(120_000);
    const signaling = await startSignalingServer();
    const turn = await startTurnServer();

    const room = `daylist-${crypto.randomBytes(6).toString('hex')}`;
    const enc = crypto.randomBytes(12).toString('hex');
    const sig = signaling.url;
    const turnKey = 'local';

    const peers = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        peers.push(
          await createPeer(browser, {
            room,
            enc,
            sig,
            turnKey,
            turnPort: turn.turnPort,
            turnUser: turn.username,
            turnPass: turn.credential
          })
        );
      }

      await Promise.all(peers.map((peer) => waitForPeers(peer.page, 2)));

      const statuses = await Promise.all(
        peers.map((peer) => peer.page.evaluate(() => window.daylistHeadless?.status))
      );
      statuses.forEach((status) => {
        expect(status?.connected).toBe(true);
        expect(status?.peers).toBeGreaterThanOrEqual(2);
        expect(status?.usingTurn).toBe(true);
      });
    } finally {
      await Promise.all(peers.map((peer) => peer.context.close().catch(() => {})));
      await turn.stop().catch(() => {});
      await signaling.close().catch(() => {});
    }
  });
});
