import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { errToObj } from '../../lib/core';

export interface YDocHandles {
  ydoc: Y.Doc;
  yTasks: Y.Map<Y.Map<any>>;
  yLists: Y.Map<Y.Map<any>>;
  yTemplates: Y.Map<Y.Map<any>>;
  yHistory: Y.Map<Y.Map<any>>;
  persistence: IndexeddbPersistence | null;
  idbSynced: { value: boolean };
  idbSyncedAt: { value: number };
  log?: (event: string, data?: unknown, level?: 'INFO' | 'WARN' | 'ERROR') => void;
}

export function createYDoc(log?: YDocHandles['log']): YDocHandles {
  const ydoc = new Y.Doc();
  const idbSynced = { value: false };
  const idbSyncedAt = { value: 0 };

  let persistence: IndexeddbPersistence | null = null;
  try {
    persistence = new IndexeddbPersistence('daylist-v1', ydoc);
    log?.('idb:init_ok', { docName: 'daylist-v1' });

    persistence.on('synced', () => {
      idbSynced.value = true;
      idbSyncedAt.value = Date.now();
      log?.('idb:synced', { at: idbSyncedAt.value });
    });
  } catch (e) {
    persistence = null;
    log?.('idb:init_failed', { error: errToObj(e) }, 'ERROR');
  }

  const yTasks = ydoc.getMap<Y.Map<any>>('tasks');
  const yLists = ydoc.getMap<Y.Map<any>>('lists');
  const yTemplates = ydoc.getMap<Y.Map<any>>('templates');
  const yHistory = ydoc.getMap<Y.Map<any>>('history');

  return {
    ydoc,
    yTasks,
    yLists,
    yTemplates,
    yHistory,
    persistence,
    idbSynced,
    idbSyncedAt,
    log
  };
}
