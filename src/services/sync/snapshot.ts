import * as Y from 'yjs';
import { BOUNDARY_HOUR, DAY_MS, debounce, errToObj, toJsonSafe } from '../../lib/core';
import { DEFAULT_LIST_COLOR, DEFAULT_LIST_ID, DEFAULT_LIST_NAME, buildTemplateId, parseTemplateId } from '../../lib/lists';
import type { SnapshotV1, SnapshotV3 } from '../../lib/types';
import type { YDocHandles } from './ydoc';

const SNAPSHOT_KEY_V1 = 'daylist.snapshot.v1';
const SNAPSHOT_KEY_V3 = 'daylist.snapshot.v3';

function docCounts(doc: YDocHandles) {
  return {
    lists: doc.yLists.size,
    tasks: doc.yTasks.size,
    templates: doc.yTemplates.size,
    historyDays: doc.yHistory.size
  };
}

export function exportSnapshot(doc: YDocHandles, opts: { historyDays?: number; now?: number } = {}): SnapshotV3 {
  const historyDays = opts.historyDays ?? 120;
  const now = opts.now ?? Date.now();
  const tasks: SnapshotV3['tasks'] = [];
  const lists: SnapshotV3['lists'] = {};

  doc.yLists.forEach((ylist, id) => {
    if (!(ylist instanceof Y.Map)) return;
    const metaRaw = ylist.get('meta');
    const metaSafe = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? toJsonSafe(metaRaw) : undefined;
    lists[id] = {
      name: String(ylist.get('name') || (id === DEFAULT_LIST_ID ? DEFAULT_LIST_NAME : id)),
      color: String(ylist.get('color') || DEFAULT_LIST_COLOR),
      createdAt: Number(ylist.get('createdAt') || 0),
      order: ylist.get('order') == null ? null : Number(ylist.get('order')),
      archivedAt: ylist.get('archivedAt') == null ? null : Number(ylist.get('archivedAt')),
      meta:
        metaSafe && typeof metaSafe === 'object' && !Array.isArray(metaSafe)
          ? (metaSafe as Record<string, any>)
          : undefined
    };
  });

  doc.yTasks.forEach((ytask, id) => {
    tasks.push({
      id,
      listId: String(ytask.get('listId') || DEFAULT_LIST_ID),
      title: String(ytask.get('title') || ''),
      type: String(ytask.get('type') || 'daily') as SnapshotV3['tasks'][number]['type'],
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

  const templates: SnapshotV3['templates'] = {};
  doc.yTemplates.forEach((yt, key) => {
    const { listId, baseKey } = parseTemplateId(String(key));
    if (!templates[listId]) templates[listId] = {};
    templates[listId][baseKey] = {
      title: String(yt.get('title') || ''),
      usageCount: Number(yt.get('usageCount') || 0),
      firstUsedAt: Number(yt.get('firstUsedAt') || 0),
      lastUsedAt: Number(yt.get('lastUsedAt') || 0),
      meanMinutes: Number(yt.get('meanMinutes') || 0),
      lastType: String(yt.get('lastType') || 'daily') as SnapshotV3['templates'][string][string]['lastType']
    };
  });

  const cutoffTs = now - historyDays * DAY_MS;
  const history: SnapshotV3['history'] = {};
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

  if (!Object.keys(lists).length) {
    lists[DEFAULT_LIST_ID] = {
      name: DEFAULT_LIST_NAME,
      color: DEFAULT_LIST_COLOR,
      createdAt: now
    };
  }

  return { v: 3, exportedAt: now, lists, tasks, templates, history };
}

export function importSnapshot(doc: YDocHandles, snapshot: SnapshotV1 | SnapshotV3) {
  if (!snapshot || (snapshot.v !== 1 && snapshot.v !== 3)) throw new Error('Unsupported snapshot format');

  doc.ydoc.transact(() => {
    const ensureList = (id: string, list?: SnapshotV3['lists'][string]) => {
      let ylist = doc.yLists.get(id);
      if (!(ylist instanceof Y.Map)) {
        ylist = new Y.Map();
        doc.yLists.set(id, ylist);
      }
      if (!ylist.has('name')) ylist.set('name', String(list?.name || (id === DEFAULT_LIST_ID ? DEFAULT_LIST_NAME : id)));
      if (!ylist.has('color')) ylist.set('color', String(list?.color || DEFAULT_LIST_COLOR));
      if (!ylist.has('createdAt')) ylist.set('createdAt', Number(list?.createdAt || Date.now()));
      if (!ylist.has('order') && list?.order != null) ylist.set('order', Number(list.order));
      if (!ylist.has('archivedAt') && list?.archivedAt != null) ylist.set('archivedAt', Number(list.archivedAt));
      if (!ylist.has('meta') && list?.meta && typeof list.meta === 'object') {
        ylist.set('meta', toJsonSafe(list.meta));
      }
    };

    ensureList(DEFAULT_LIST_ID);

    if (snapshot.v === 3) {
      if (snapshot.lists && typeof snapshot.lists === 'object') {
        for (const [id, list] of Object.entries(snapshot.lists)) {
          if (!id) continue;
          ensureList(id, list);
        }
      }
    }

    if (snapshot.v === 1) {
      if (snapshot.templates && typeof snapshot.templates === 'object') {
        for (const [key, t] of Object.entries(snapshot.templates)) {
          if (!key) continue;
          const templateId = buildTemplateId(DEFAULT_LIST_ID, key);
          let yt = doc.yTemplates.get(templateId);
          if (!(yt instanceof Y.Map)) {
            yt = new Y.Map();
            doc.yTemplates.set(templateId, yt);
          }
          if (!yt.has('title')) yt.set('title', String(t.title || key));
          if (!yt.has('usageCount')) yt.set('usageCount', Number(t.usageCount || 0));
          if (!yt.has('firstUsedAt')) yt.set('firstUsedAt', Number(t.firstUsedAt || 0));
          if (!yt.has('lastUsedAt')) yt.set('lastUsedAt', Number(t.lastUsedAt || 0));
          if (!yt.has('meanMinutes')) yt.set('meanMinutes', Number(t.meanMinutes || 0));
          if (!yt.has('lastType')) yt.set('lastType', String(t.lastType || 'daily'));
        }
      }
    } else if (snapshot.templates && typeof snapshot.templates === 'object') {
      for (const [listId, listTemplates] of Object.entries(snapshot.templates)) {
        if (!listTemplates || typeof listTemplates !== 'object') continue;
        if (!listId) continue;
        ensureList(listId);
        for (const [key, t] of Object.entries(listTemplates)) {
          if (!key) continue;
          const templateId = buildTemplateId(listId, key);
          let yt = doc.yTemplates.get(templateId);
          if (!(yt instanceof Y.Map)) {
            yt = new Y.Map();
            doc.yTemplates.set(templateId, yt);
          }
          if (!yt.has('title')) yt.set('title', String(t.title || key));
          if (!yt.has('usageCount')) yt.set('usageCount', Number(t.usageCount || 0));
          if (!yt.has('firstUsedAt')) yt.set('firstUsedAt', Number(t.firstUsedAt || 0));
          if (!yt.has('lastUsedAt')) yt.set('lastUsedAt', Number(t.lastUsedAt || 0));
          if (!yt.has('meanMinutes')) yt.set('meanMinutes', Number(t.meanMinutes || 0));
          if (!yt.has('lastType')) yt.set('lastType', String(t.lastType || 'daily'));
        }
      }
    }

    if (Array.isArray(snapshot.tasks)) {
      for (const t of snapshot.tasks) {
        if (!t || !t.id) continue;
        if (doc.yTasks.has(t.id)) continue;
        const ytask = new Y.Map();
        const listId = snapshot.v === 3 ? String((t as SnapshotV3['tasks'][number]).listId || DEFAULT_LIST_ID) : DEFAULT_LIST_ID;
        ensureList(listId);
        ytask.set('id', String(t.id));
        ytask.set('listId', listId);
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

export function loadSnapshotFromStorage(storage: Storage): SnapshotV1 | SnapshotV3 | null {
  try {
    const raw = storage.getItem(SNAPSHOT_KEY_V3);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.v === 3) return obj as SnapshotV3;
    }
  } catch {
    // fall through
  }

  try {
    const raw = storage.getItem(SNAPSHOT_KEY_V1);
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

      opts.storage.setItem(SNAPSHOT_KEY_V3, json);
      dirty = false;

      const templateCount = snapshot.templates
        ? Object.values(snapshot.templates).reduce((sum, list) => sum + (list ? Object.keys(list).length : 0), 0)
        : 0;

      opts.onLog?.('snapshot:write', {
        reason,
        bytes: json.length,
        exportedAt: snapshot.exportedAt,
        counts: {
          lists: snapshot.lists ? Object.keys(snapshot.lists).length : 0,
          tasks: snapshot.tasks?.length || 0,
          templates: templateCount,
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
