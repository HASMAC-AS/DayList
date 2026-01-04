import { BUILD_ID, BUILD_TIME } from '../lib/build';

export interface VersionInfo {
  buildId?: string;
  buildTime?: string;
}

export function startVersionPolling(opts: {
  intervalMs?: number;
  onUpdate?: (info: VersionInfo) => void;
  onError?: (error: unknown) => void;
  log?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG') => void;
}) {
  const intervalMs = opts.intervalMs ?? 10_000;
  const currentId = String(BUILD_ID || '');
  const currentTime = Date.parse(String(BUILD_TIME || '')) || 0;
  let stopped = false;
  let updateFound = false;

  const check = async () => {
    if (stopped || updateFound) return;
    try {
      const base = import.meta.env.BASE_URL || './';
      const url = `${base}version.json?ts=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as VersionInfo;
      const nextId = String(json?.buildId || '');
      const nextTime = Date.parse(String(json?.buildTime || '')) || 0;
      const newer = (nextId && nextId !== currentId) || (nextTime && nextTime > currentTime);
      if (!newer) return;
      updateFound = true;
      opts.log?.('version:update_available', { currentId, currentTime, nextId, nextTime });
      try {
        const reg = await navigator.serviceWorker?.getRegistration?.();
        await reg?.update?.();
      } catch {
        // ignore SW update errors
      }
      opts.onUpdate?.({ buildId: nextId, buildTime: json?.buildTime });
    } catch (error) {
      opts.onError?.(error);
    }
  };

  const timer = window.setInterval(check, intervalMs);
  check();

  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
