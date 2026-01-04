import { debounce, errToObj, toJsonSafe } from '../../lib/core';

const LS_DEBUG_ENABLED = 'daylist.debug.enabled';
const LS_DEBUG_LOG = 'daylist.debug.log.v1';
const DEBUG_LOG_MAX = 600;

export interface DebugLogger {
  enabled: boolean;
  log: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG') => void;
  getLogs: () => unknown[];
  clearLogs: () => void;
  enable: () => void;
  disable: () => void;
}

function safeGet(storage: Storage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isDebugEnabled(href: string, storage: Storage) {
  try {
    const url = new URL(href);
    const q = (url.searchParams.get('debug') || '').trim();
    if (q) return q === '1' || q.toLowerCase() === 'true';
  } catch {
    // ignore
  }
  return (safeGet(storage, LS_DEBUG_ENABLED) || '').trim() === '1';
}

export function createDebugLogger(opts: { href: string; storage: Storage; onError?: (e: unknown) => void }): DebugLogger {
  let buffer = (() => {
    try {
      const raw = safeGet(opts.storage, LS_DEBUG_LOG);
      if (!raw) return [] as unknown[];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [] as unknown[];
    }
  })();

  const enabled = isDebugEnabled(opts.href, opts.storage);

  const flushDebugLog = debounce(() => {
    try {
      safeSet(opts.storage, LS_DEBUG_LOG, JSON.stringify(buffer.slice(-DEBUG_LOG_MAX)));
    } catch (e) {
      opts.onError?.(e);
    }
  }, 250);

  const log: DebugLogger['log'] = (event, data = null, level = 'INFO') => {
    const entry = {
      t: Date.now(),
      iso: new Date().toISOString(),
      level,
      event,
      data: toJsonSafe(data)
    };

    if (enabled) {
      buffer.push(entry);
      if (buffer.length > DEBUG_LOG_MAX) buffer = buffer.slice(-DEBUG_LOG_MAX);
      flushDebugLog();
      const prefix = `[DayList] ${entry.iso} ${level} ${event}`;
      if (data == null) console.log(prefix);
      else console.log(prefix, data);
    }
  };

  return {
    enabled,
    log,
    getLogs: () => buffer.slice(),
    clearLogs: () => {
      buffer = [];
      safeRemove(opts.storage, LS_DEBUG_LOG);
    },
    enable: () => {
      safeSet(opts.storage, LS_DEBUG_ENABLED, '1');
      location.reload();
    },
    disable: () => {
      safeRemove(opts.storage, LS_DEBUG_ENABLED);
      location.reload();
    }
  };
}

export function bindDebugWindow(logger: DebugLogger) {
  (window as typeof window & { daylistDebug?: any }).daylistDebug = {
    enabled: logger.enabled,
    getLogs: logger.getLogs,
    clearLogs: logger.clearLogs,
    enable: logger.enable,
    disable: logger.disable
  };

  window.addEventListener('error', (e) => {
    logger.log(
      'window:error',
      {
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        error: errToObj(e.error)
      },
      'ERROR'
    );
  });

  window.addEventListener('unhandledrejection', (e) => {
    logger.log('window:unhandledrejection', { reason: errToObj(e.reason) }, 'ERROR');
  });
}
