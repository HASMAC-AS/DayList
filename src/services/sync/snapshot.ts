import * as Y from 'yjs';
import { BOUNDARY_HOUR, DAY_MS, debounce, errToObj, toJsonSafe } from '../../lib/core';
import type { SnapshotV1 } from '../../lib/types';
import type { YDocHandles } from './ydoc';

const SNAPSHOT_KEY = 'daylist.snapshot.v1';

function docCounts(doc: YDocHandles) {
  return {
    tasks: doc.yTasks.size,
    templates: doc.yTemplates.size,
    historyDays: doc.yHistory.size
  };
}

export function exportSnapshot(doc: YDocHandles, opts: { historyDays?: number; now?: number } = {}): SnapshotV1 {
  const historyDays = opts.historyDays ?? 120;
  const now = opts.now ?? Date.now();
  const tasks: SnapshotV1['tasks'] = [];

  doc.yTasks.forEach((ytask, id) => {
    tasks.push({
      id,
      title: String(ytask.get('title') || ''),
      type: String(ytask.get('type') || 'daily') as SnapshotV1['tasks'][number]['type'],
      createdAt: Number(ytask.get('createdAt') || 0),
      order: ytask.get('order') == null ? null : Number(ytask.get('order')),
      dueAt: ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt')),
      active: ytask.get('active') !== false,
      archivedAt: ytask.get('archivedAt') == null ? null : Number(ytask.get('archivedAt')),
      doneAt: ytask.get('doneAt') == null ? null : Number(ytask.get('doneAt')),
      templateKey: ytask.get('templateKey') == null ? null : String(ytask.get('templateKey')),
      completions: (() => {
        const m = ytask.get('completions');
        if (!(m instanceof Y.Map)) return {};
        const out: Record<string, boolean> = {};
        m.forEach((v, k) => {
          out[k] = !!v;
        });
        return out;
      })()
    });
  });

  const templates: SnapshotV1['templates'] = {};
  doc.yTemplates.forEach((yt, key) => {
    templates[key] = {
      title: String(yt.get('title') || ''),
      usageCount: Number(yt.get('usageCount') || 0),
      firstUsedAt: Number(yt.get('firstUsedAt') || 0),
      lastUsedAt: Number(yt.get('lastUsedAt') || 0),
      meanMinutes: Number(yt.get('meanMinutes') || 0),
      lastType: String(yt.get('lastType') || 'daily') as SnapshotV1['templates'][string]['lastType']
    };
  });

  const cutoffTs = now - historyDays * DAY_MS;
  const history: SnapshotV1['history'] = {};
  doc.yHistory.forEach((ymap, dayKey) => {
    if (!(ymap instanceof Y.Map)) return;
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dayKey);
    if (!m) return;
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), BOUNDARY_HOUR, 0, 0, 0).getTime();
    if (ts < cutoffTs) return;
    const o: Record<string, number> = {};
    ymap.forEach((completedAt, taskId) => {
      o[taskId] = Number(completedAt || 0);
    });
    history[dayKey] = o;
  });

  return { v: 1, exportedAt: now, tasks, templates, history };
}

export function importSnapshot(doc: YDocHandles, snapshot: SnapshotV1) {
  if (!snapshot || snapshot.v !== 1) throw new Error('Unsupported snapshot format');

  doc.ydoc.transact(() => {
    if (snapshot.templates && typeof snapshot.templates === 'object') {
      for (const [key, t] of Object.entries(snapshot.templates)) {
        if (!key) continue;
        let yt = doc.yTemplates.get(key);
        if (!(yt instanceof Y.Map)) {
          yt = new Y.Map();
          doc.yTemplates.set(key, yt);
        }
        if (!yt.has('title')) yt.set('title', String(t.title || key));
        if (!yt.has('usageCount')) yt.set('usageCount', Number(t.usageCount || 0));
        if (!yt.has('firstUsedAt')) yt.set('firstUsedAt', Number(t.firstUsedAt || 0));
        if (!yt.has('lastUsedAt')) yt.set('lastUsedAt', Number(t.lastUsedAt || 0));
        if (!yt.has('meanMinutes')) yt.set('meanMinutes', Number(t.meanMinutes || 0));
        if (!yt.has('lastType')) yt.set('lastType', String(t.lastType || 'daily'));
      }
    }

    if (Array.isArray(snapshot.tasks)) {
      for (const t of snapshot.tasks) {
        if (!t || !t.id) continue;
        if (doc.yTasks.has(t.id)) continue;
        const ytask = new Y.Map();
        ytask.set('id', String(t.id));
        ytask.set('title', String(t.title || ''));
        ytask.set('type', String(t.type || 'daily'));
        ytask.set('createdAt', Number(t.createdAt || Date.now()));
        if (t.order != null) ytask.set('order', Number(t.order));
        ytask.set('dueAt', t.dueAt == null ? null : Number(t.dueAt));
        ytask.set('active', t.active !== false);
        ytask.set('archivedAt', t.archivedAt == null ? null : Number(t.archivedAt));
        ytask.set('doneAt', t.doneAt == null ? null : Number(t.doneAt));
        ytask.set('templateKey', t.templateKey == null ? null : String(t.templateKey));
        const comps = new Y.Map();
        if (t.completions && typeof t.completions === 'object') {
          for (const [k, v] of Object.entries(t.completions)) comps.set(k, !!v);
        }
        ytask.set('completions', comps);
        doc.yTasks.set(String(t.id), ytask);
      }
    }

    if (snapshot.history && typeof snapshot.history === 'object') {
      for (const [dayKey, map] of Object.entries(snapshot.history)) {
        if (!map || typeof map !== 'object') continue;
        let ymap = doc.yHistory.get(dayKey);
        if (!(ymap instanceof Y.Map)) {
          ymap = new Y.Map();
          doc.yHistory.set(dayKey, ymap);
        }
        for (const [taskId, completedAt] of Object.entries(map)) {
          if (!taskId) continue;
          if (!ymap.has(taskId)) ymap.set(taskId, Number(completedAt || 0));
        }
      }
    }
  });
}

export function loadSnapshotFromStorage(storage: Storage): SnapshotV1 | null {
  try {
    const raw = storage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1) return null;
    return obj as SnapshotV1;
  } catch {
    return null;
  }
}

export function createSnapshotMirror(opts: {
  doc: YDocHandles;
  storage: Storage;
  historyDays: number;
  debounceMs: number;
  flushIntervalMs: number;
  onToast?: (msg: string) => void;
  onLog?: (event: string, data?: unknown, level?: string) => void;
}) {
  let dirty = false;
  let disposed = false;

  const flush = (reason: string, force = false) => {
    if (disposed) return;
    const lifecycleFlush = reason === 'pagehide' || reason === 'beforeunload' || reason === 'visibility:hidden';
    if (!dirty && !force && !lifecycleFlush) return;

    try {
      const before = docCounts(opts.doc);
      const snapshot = exportSnapshot(opts.doc, { historyDays: opts.historyDays });
      const json = JSON.stringify(snapshot);

      opts.storage.setItem(SNAPSHOT_KEY, json);
      dirty = false;

      opts.onLog?.('snapshot:write', {
        reason,
        bytes: json.length,
        exportedAt: snapshot.exportedAt,
        counts: {
          tasks: snapshot.tasks?.length || 0,
          templates: snapshot.templates ? Object.keys(snapshot.templates).length : 0,
          historyDays: snapshot.history ? Object.keys(snapshot.history).length : 0
        },
        beforeDoc: before,
        afterDoc: docCounts(opts.doc)
      });
    } catch (e) {
      opts.onLog?.('snapshot:write_failed', { reason, error: toJsonSafe(errToObj(e)) }, 'ERROR');
    }
  };

  const debouncedFlush = debounce(() => flush('debounced'), opts.debounceMs);
  const intervalId = window.setInterval(() => flush('interval'), opts.flushIntervalMs);

  const onPageHide = () => flush('pagehide');
  const onBeforeUnload = () => flush('beforeunload');
  const onVisibility = () => {
    if (document.hidden) flush('visibility:hidden');
  };

  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    markDirty() {
      dirty = true;
      debouncedFlush();
    },
    flush,
    dispose() {
      disposed = true;
      clearInterval(intervalId);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
