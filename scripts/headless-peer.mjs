import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const projectRoot = resolve(__dirname, '..');
const distDir = resolve(projectRoot, 'dist');

const parseBool = (value, fallback = true) => {
  if (value == null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return fallback;
};

const requireValue = (value, label) => {
  const cleaned = String(value || '').trim();
  if (!cleaned) throw new Error(`Missing required setting: ${label}`);
  return cleaned;
};

const redact = (value, keep = 4) => {
  const t = String(value || '');
  if (!t) return '';
  if (t.length <= keep * 2) return '*'.repeat(t.length);
  return `${t.slice(0, keep)}...${t.slice(-keep)} (len=${t.length})`;
};

const mimeType = (filePath) => {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.map') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
};

const startStaticServer = async (rootDir, port) => {
  await fs.stat(rootDir);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      if (pathname === '/') pathname = '/index.html';
      const targetPath = resolve(rootDir, `.${pathname}`);
      if (!targetPath.startsWith(rootDir)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      const stat = await fs.stat(targetPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', mimeType(targetPath));
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(targetPath).pipe(res);
    } catch (error) {
      res.statusCode = 500;
      res.end('Internal error');
      console.error('[headless-peer] static-server-error', error);
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise(true);
    });
  });

  return server;
};

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const buildHeadlessUrl = ({ baseUrl, room, enc, sig, turnKey, turnEnabled }) => {
  const params = new URLSearchParams();
  params.set('room', room);
  params.set('enc', enc);
  if (sig) params.set('sig', sig);
  if (turnKey) params.set('turnKey', turnKey);
  params.set('turn', turnEnabled ? '1' : '0');
  return `${baseUrl}/headless.html?${params.toString()}`;
};

const normalizeSettings = (input) => {
  if (!input || typeof input !== 'object') return {};
  const base = input.sync && typeof input.sync === 'object' ? input.sync : input;
  const readString = (value) => (value == null ? '' : String(value).trim());
  const sigRaw = base.sig ?? base.signaling ?? base.signalingUrls ?? '';
  const sig = Array.isArray(sigRaw) ? sigRaw.map((s) => String(s || '').trim()).filter(Boolean).join(',') : readString(sigRaw);
  const turnEnabledRaw = base.turnEnabled ?? base.turn;
  const turnEnabled =
    typeof turnEnabledRaw === 'boolean' ? turnEnabledRaw : parseBool(turnEnabledRaw, undefined);
  return {
    room: readString(base.room),
    enc: readString(base.enc),
    sig,
    turnKey: readString(base.turnKey),
    turnEnabled
  };
};

const resolveSettingsPath = async (settingsPath) => {
  const stat = await fs.stat(settingsPath).catch(() => null);
  if (stat && stat.isDirectory()) return resolve(settingsPath, 'settings.json');
  return settingsPath;
};

const loadSettingsFile = async (settingsPath, required) => {
  if (!settingsPath) return null;
  try {
    const resolvedPath = await resolveSettingsPath(settingsPath);
    const raw = await fs.readFile(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch (error) {
    if (!required && error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const buildSafeUrl = ({ baseUrl, room, enc, sig, turnKey, turnEnabled }) => {
  const params = new URLSearchParams();
  params.set('room', redact(room));
  params.set('enc', redact(enc));
  if (sig) params.set('sig', redact(sig));
  if (turnKey) params.set('turnKey', redact(turnKey));
  params.set('turn', turnEnabled ? '1' : '0');
  return `${baseUrl}/headless.html?${params.toString()}`;
};

const runBrowserSession = async ({ url, profileDir }) => {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const page = context.pages()[0] || (await context.newPage());
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    const prefix = `[browser:${type}]`;
    if (type === 'error') console.error(prefix, text);
    else if (type === 'warning') console.warn(prefix, text);
    else console.log(prefix, text);
  });
  page.on('pageerror', (error) => {
    console.error('[browser:pageerror]', error);
  });
  page.on('crash', () => {
    console.error('[browser] page crashed');
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  let stopped = false;
  const closeWatcher = new Promise((resolvePromise) => {
    const done = () => {
      if (stopped) return;
      stopped = true;
      resolvePromise(true);
    };
    page.on('close', done);
    page.on('crash', done);
    context.on('close', done);
  });

  const statusLoop = async () => {
    while (!stopped) {
      await delay(30_000);
      if (stopped) break;
      const status = await page.evaluate(() => (window.daylistHeadless ? window.daylistHeadless.status : null));
      if (!status) throw new Error('Missing window.daylistHeadless.status');
      if (status.lastError && status.lastError.message) {
        throw new Error(`Headless error: ${status.lastError.message}`);
      }
    }
  };

  try {
    await Promise.race([closeWatcher, statusLoop()]);
  } finally {
    stopped = true;
    await context.close().catch(() => {});
  }
};

const main = async () => {
  const settingsPathEnv = (process.env.DAYLIST_SETTINGS_FILE || '').trim();
  const settingsPath = settingsPathEnv || '/data/settings.json';
  const settings = await loadSettingsFile(settingsPath, !!settingsPathEnv);
  const settingsInfo = settings ? settingsPath : null;

  const room = requireValue(process.env.DAYLIST_ROOM || settings?.room, 'DAYLIST_ROOM or settings.room');
  const enc = requireValue(process.env.DAYLIST_ENC || settings?.enc, 'DAYLIST_ENC or settings.enc');
  const sig = (process.env.DAYLIST_SIG || '').trim() || settings?.sig || '';
  const turnKey = (process.env.DAYLIST_TURN_KEY || '').trim() || settings?.turnKey || '';
  const turnEnabled = parseBool(process.env.DAYLIST_TURN, settings?.turnEnabled ?? true);
  const port = Number(process.env.DAYLIST_PORT || 4173);
  const profileDir = process.env.DAYLIST_PROFILE_DIR || '/data/chrome-profile';

  await fs.mkdir(profileDir, { recursive: true });

  const server = await startStaticServer(distDir, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = buildHeadlessUrl({ baseUrl, room, enc, sig, turnKey, turnEnabled });
  const safeUrl = buildSafeUrl({ baseUrl, room, enc, sig, turnKey, turnEnabled });

  console.log('[headless-peer] dist', distDir);
  console.log('[headless-peer] profile', profileDir);
  if (settingsInfo) console.log('[headless-peer] settings', settingsInfo);
  console.log('[headless-peer] room', redact(room));
  console.log('[headless-peer] enc', redact(enc));
  console.log('[headless-peer] sig', sig ? redact(sig) : '(default)');
  console.log('[headless-peer] turnKey', turnKey ? redact(turnKey) : '(none)');
  console.log('[headless-peer] turnEnabled', turnEnabled ? '1' : '0');
  console.log('[headless-peer] url', safeUrl);

  const shutdown = async () => {
    console.log('[headless-peer] shutdown');
    server.close();
    await delay(200);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      await runBrowserSession({ url, profileDir });
    } catch (error) {
      console.error('[headless-peer] session failed', error);
    }
    await delay(1000);
  }
};

main().catch((error) => {
  console.error('[headless-peer] fatal', error);
  process.exit(1);
});
