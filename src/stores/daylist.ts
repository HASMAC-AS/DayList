import { computed, reactive, ref, shallowRef } from 'vue';
import * as Y from 'yjs';
import Fuse from 'fuse.js';
import type { WebrtcProvider } from 'y-webrtc';
import { defineStore } from 'pinia';
import {
  BOUNDARY_HOUR,
  DAY_MS,
  errToObj,
  formatDateTime,
  logicalDayKey,
  minutesOfDay,
  normalizeTitle,
  pad2,
  parseDatetimeLocalValue,
  parseSignalingList,
  randomKey,
  suggestionScore,
  toDatetimeLocalValue,
  toJsonSafe
} from '../lib/core';
import {
  DEFAULT_LIST_COLOR,
  DEFAULT_LIST_ID,
  DEFAULT_LIST_NAME,
  TEMPLATE_SEP,
  buildTemplateId,
  parseTemplateId
} from '../lib/lists';
import type {
  HistoryDay,
  HistoryDayEntry,
  Task,
  TaskList,
  TaskType,
  TemplateStat,
  SnapshotV1,
  SnapshotV2,
  SnapshotV3,
  SnapshotKeys
} from '../lib/types';
import { createDebugLogger, bindDebugWindow, type DebugLogger } from '../services/sync/debugLog';
import { createRateLimitedFetch } from '../services/sync/netThrottle';
import { getPeerCount, type PeerConnectionUpdate, type SignalingStatus } from '../services/sync/provider';
import { createSyncSession, type SyncSession } from '../services/sync/session';
import {
  createSnapshotMirror,
  exportSnapshot,
  importSnapshot,
  loadSnapshotFromStorage
} from '../services/sync/snapshot';
import { createYDoc, type YDocHandles } from '../services/sync/ydoc';
import { persistKeysToStorage, resolveInitialKeys, type SyncKeys, writeKeysToUrl } from '../services/sync/keys';
import { DEFAULT_SIGNALING } from '../services/sync/defaults';
import { useToastBus } from '../services/toast';
import { startVersionPolling } from '../services/versionCheck';

const HISTORY_DAYS = 7;
const ACTIVE_LIST_KEY = 'daylist.activeListId.v1';

export const useDaylistStore = defineStore('daylist', () => {
  // iOS Safari (and iOS PWAs) aggressively suspend pages in the background.
  // When the app resumes, WebRTC/WebSocket connections are often dead even if
  // the in-memory objects still think they're "connected".
  const isIOSLike = (() => {
    try {
      const ua = navigator.userAgent || '';
      // iPadOS 13+ reports MacIntel but has touch points.
      const platform = (navigator as Navigator & { platform?: string }).platform || '';
      const maxTouchPoints = (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints || 0;
      return /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
    } catch {
      return false;
    }
  })();
  const isIPhone = (() => {
    try {
      const ua = navigator.userAgent || '';
      return /iPhone/i.test(ua);
    } catch {
      return false;
    }
  })();

  const keys = reactive<SyncKeys>({
    room: '',
    enc: '',
    sig: '',
    turnKey: '',
    turnEnabled: true
  });

  const providerConnected = ref(false);
  const peerCount = ref(0);
  const idbReady = ref(false);
  const nowTs = ref(Date.now());
  const lists = ref<TaskList[]>([]);
  const activeListId = ref(
    (() => {
      try {
        return localStorage.getItem(ACTIVE_LIST_KEY) || DEFAULT_LIST_ID;
      } catch {
        return DEFAULT_LIST_ID;
      }
    })()
  );
  const tasks = ref<Task[]>([]);
  const templates = ref<TemplateStat[]>([]);
  const historyDays = ref<HistoryDay[]>([]);
  const usingTurn = ref(false);
  const signaling = ref<string[]>(DEFAULT_SIGNALING);
  const signalingStatus = reactive<Record<string, SignalingStatus>>({});
  const signalingLastMessageAt = ref(0);
  const webrtcPeers = ref<string[]>([]);
  const bcPeers = ref<string[]>([]);
  const peerStates = reactive<
    Record<
      string,
      {
        connected: boolean;
        lastEvent: string;
        lastChangeAt: number;
        lastReason?: string;
        lastOutcome?: string;
        iceState?: string;
        signalState?: string;
        lastError?: unknown;
      }
    >
  >({});
  const iceState = ref<
    | {
        mode: string;
        transport: string;
        count: number;
        reason: string;
        at: number;
      }
    | null
  >(null);
  const pendingTaskIds = ref<string[]>([]);
  const lastLocalChangeAt = ref(0);
  let lastKickAt = 0;
  const signalingPeerSeenAt = ref(0);
  let lastRelayAttemptAt = 0;
  const RELAY_ATTEMPT_COOLDOWN_MS = 30_000;

  const ydocHandles = shallowRef<YDocHandles | null>(null);
  const provider = shallowRef<WebrtcProvider | null>(null);
  const session = shallowRef<SyncSession | null>(null);
  const snapshotMirror = shallowRef<ReturnType<typeof createSnapshotMirror> | null>(null);
  const logger = shallowRef<DebugLogger | null>(null);
  const initialized = ref(false);
  let stopVersionPoll: (() => void) | null = null;
  let resumeTimer: number | null = null;
  let lastResumeAt = 0;
  let lastHiddenAt = 0;
  let watchdogTimer: number | null = null;
  let lastHardReconnectAt = 0;
  let lastOfflineAt = 0;

  const logEntries = ref<
    Array<{
      id: string;
      ts: number;
      level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
      event: string;
      data: unknown;
    }>
  >([]);
  let logCounter = 0;

  const pushLog = (event: string, data: unknown = null, level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO') => {
    const entry = {
      id: `${Date.now()}-${logCounter++}`,
      ts: Date.now(),
      level,
      event,
      data: toJsonSafe(data)
    };
    logEntries.value = [...logEntries.value.slice(-299), entry];
  };

  const logEvent = (event: string, data: unknown = null, level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO') => {
    pushLog(event, data, level);
    logger.value?.log(event, data, level);
  };

  const logLifecycleEvent = (event: string, data: Record<string, unknown> = {}) => {
    logEvent(`lifecycle:${event}`, data);
  };

  const logLifecycleAction = (source: string, action: string, data: Record<string, unknown> = {}) => {
    logEvent('lifecycle:action', {
      source,
      action,
      ...data
    });
  };

  const updatePeerState = (info: PeerConnectionUpdate) => {
    if (!info.peerId) return;
    if (!peerStates[info.peerId]) {
      peerStates[info.peerId] = {
        connected: false,
        lastEvent: info.event || 'init',
        lastChangeAt: info.at || Date.now()
      };
    }
    const entry = peerStates[info.peerId];
    if (typeof info.connected === 'boolean') entry.connected = info.connected;
    if (info.event) entry.lastEvent = info.event;
    entry.lastChangeAt = info.at || Date.now();
    if (info.reason) entry.lastReason = info.reason;
    if (info.outcome) entry.lastOutcome = info.outcome;
    if (info.iceState !== undefined) entry.iceState = String(info.iceState);
    if (info.signalState !== undefined) entry.signalState = String(info.signalState);
    if (info.error) entry.lastError = errToObj(info.error);
  };

  const maybeForceRelay = (reason: string) => {
    if (!session.value) return;
    if (!usingTurn.value) return;
    if (iceState.value?.transport === 'relay') return;
    const now = Date.now();
    if (now - lastRelayAttemptAt < RELAY_ATTEMPT_COOLDOWN_MS) return;
    lastRelayAttemptAt = now;
    logEvent('ice:relay_attempt', { reason });
    session.value.forceRelay(reason).catch((error) => {
      logEvent('ice:relay_failed', { reason, error: errToObj(error) }, 'WARN');
    });
  };

  const markTaskPending = (id: string) => {
    if (!id) return;
    if (pendingTaskIds.value.includes(id)) return;
    pendingTaskIds.value = [...pendingTaskIds.value, id];
  };

  const isTaskSyncing = (id: string) => pendingTaskIds.value.includes(id);

  const nextTaskOrder = (listId?: string) => {
    const target = listId || activeListIdResolved.value;
    let max = 0;
    tasks.value.forEach((task) => {
      if (target && task.listId !== target) return;
      const value = task.order == null ? task.createdAt || 0 : Number(task.order || 0);
      if (value > max) max = value;
    });
    return max + 1;
  };

  const { show: toast } = useToastBus();

  const activeList = computed(() => {
    if (!lists.value.length) return null;
    return (
      lists.value.find((list) => list.id === activeListId.value) ||
      lists.value.find((list) => list.id === DEFAULT_LIST_ID) ||
      lists.value[0] ||
      null
    );
  });
  const activeListIdResolved = computed(() => activeList.value?.id || activeListId.value || DEFAULT_LIST_ID);
  const tasksForActiveList = computed(() => tasks.value.filter((task) => task.listId === activeListIdResolved.value));

  const dayKey = computed(() => logicalDayKey(nowTs.value));
  const dayLabel = computed(() => `Day: ${dayKey.value} (resets ${pad2(BOUNDARY_HOUR)}:00 local)`);
  const snapshotActive = computed(() => !!snapshotMirror.value);
  const syncReady = computed(() => providerConnected.value && peerCount.value > 0 && pendingTaskIds.value.length === 0 && initialized.value);
  const throttledFetch = createRateLimitedFetch(fetch, 300);

  const ensureTask = (id: string) => {
    const ytask = ydocHandles.value?.yTasks.get(id);
    return ytask instanceof Y.Map ? ytask : null;
  };

  const ensureList = (id: string) => {
    if (!ydocHandles.value) return null;
    let ylist = ydocHandles.value.yLists.get(id);
    if (!(ylist instanceof Y.Map)) {
      ylist = new Y.Map();
      ydocHandles.value.yLists.set(id, ylist);
    }
    return ylist;
  };

  const getList = (id: string) => {
    const ylist = ydocHandles.value?.yLists.get(id);
    return ylist instanceof Y.Map ? ylist : null;
  };

  const listPlain = (ylist: Y.Map<any>, id: string): TaskList => {
    const metaRaw = ylist.get('meta');
    const meta = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : undefined;
    return {
      id,
      name: String(ylist.get('name') || (id === DEFAULT_LIST_ID ? DEFAULT_LIST_NAME : id)),
      color: String(ylist.get('color') || DEFAULT_LIST_COLOR),
      createdAt: Number(ylist.get('createdAt') || 0),
      order: ylist.get('order') == null ? null : Number(ylist.get('order')),
      archivedAt: ylist.get('archivedAt') == null ? null : Number(ylist.get('archivedAt')),
      meta: meta && typeof meta === 'object' ? (meta as Record<string, any>) : undefined
    };
  };

  const ensureListDefaults = (id: string) => {
    const ylist = ensureList(id);
    if (!ylist) return null;
    if (!ylist.has('name')) ylist.set('name', id === DEFAULT_LIST_ID ? DEFAULT_LIST_NAME : id);
    if (!ylist.has('color')) ylist.set('color', DEFAULT_LIST_COLOR);
    if (!ylist.has('createdAt')) ylist.set('createdAt', Date.now());
    return ylist;
  };

  const ensureDefaultList = () => {
    ensureListDefaults(DEFAULT_LIST_ID);
  };

  const resolveListId = (id: string, available: TaskList[] = lists.value) => {
    const trimmed = (id || '').trim() || DEFAULT_LIST_ID;
    if (available.some((list) => list.id === trimmed)) return trimmed;
    const fallback = available.find((list) => list.id === DEFAULT_LIST_ID) || available[0];
    return fallback ? fallback.id : DEFAULT_LIST_ID;
  };

  const ensureMapField = (ytask: Y.Map<any>, field: string) => {
    const got = ytask.get(field);
    if (got instanceof Y.Map) return got;
    const m = new Y.Map();
    ytask.set(field, m);
    return m;
  };

  const ensureDayHistory = (key: string) => {
    const got = ydocHandles.value?.yHistory.get(key);
    if (got instanceof Y.Map) return got;
    const m = new Y.Map();
    ydocHandles.value?.yHistory.set(key, m);
    return m;
  };

  const touchTemplate = (
    listId: string,
    title: string,
    typeHint: TaskType = 'daily',
    dueAt: number | null = null
  ) => {
    const key = normalizeTitle(title);
    if (!key || !ydocHandles.value) return null;
    const listKey = (listId || DEFAULT_LIST_ID).trim() || DEFAULT_LIST_ID;
    const templateId = buildTemplateId(listKey, key);

    ensureListDefaults(listKey);

    let yt = ydocHandles.value.yTemplates.get(templateId);
    if (!(yt instanceof Y.Map)) {
      yt = new Y.Map();
      ydocHandles.value.yTemplates.set(templateId, yt);
      yt.set('title', title.trim());
      yt.set('usageCount', 0);
      yt.set('firstUsedAt', Date.now());
      yt.set('meanMinutes', minutesOfDay());
      yt.set('lastType', typeHint);
    }

    const now = Date.now();
    yt.set('usageCount', Number(yt.get('usageCount') || 0) + 1);
    yt.set('lastUsedAt', now);
    yt.set('lastType', typeHint);

    const usedMinutes = minutesOfDay(dueAt ?? now);
    const mean = Number(yt.get('meanMinutes') || usedMinutes);
    const alpha = 0.2;
    yt.set('meanMinutes', mean * (1 - alpha) + usedMinutes * alpha);

    return templateId;
  };

  const taskPlain = (ytask: Y.Map<any>): Task => {
    const completions: Record<string, boolean> = {};
    const compMap = ytask.get('completions');
    if (compMap instanceof Y.Map) {
      compMap.forEach((v, k) => {
        completions[k] = !!v;
      });
    }

    return {
      id: String(ytask.get('id') || ''),
      listId: String(ytask.get('listId') || DEFAULT_LIST_ID),
      title: String(ytask.get('title') || ''),
      type: String(ytask.get('type') || 'daily') as TaskType,
      createdAt: Number(ytask.get('createdAt') || 0),
      order: ytask.get('order') == null ? null : Number(ytask.get('order')),
      dueAt: ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt')),
      active: ytask.get('active') !== false,
      archivedAt: ytask.get('archivedAt') == null ? null : Number(ytask.get('archivedAt')),
      doneAt: ytask.get('doneAt') == null ? null : Number(ytask.get('doneAt')),
      templateKey: ytask.get('templateKey') == null ? null : String(ytask.get('templateKey')),
      completions
    };
  };

  const buildHistoryDays = (listId: string | null = null, daysBack = HISTORY_DAYS) => {
    if (!ydocHandles.value) return [] as HistoryDay[];
    const out: HistoryDay[] = [];
    const now = nowTs.value;

    for (let i = 0; i < daysBack; i++) {
      const key = logicalDayKey(now - i * DAY_MS);
      const m = ydocHandles.value.yHistory.get(key);
      const entries = m instanceof Y.Map ? [...m.entries()] : [];
      entries.sort((a, b) => Number(a[1]) - Number(b[1]));

      const items = entries
        .map(([taskId, completedAt]) => {
          const ytask = ydocHandles.value?.yTasks.get(taskId);
          if (!(ytask instanceof Y.Map)) {
            return {
              taskId,
              completedAt: Number(completedAt || 0),
              title: '(missing task)'
            };
          }
          const taskListId = String(ytask.get('listId') || DEFAULT_LIST_ID);
          if (listId && taskListId !== listId) return null;
          const title = String(ytask.get('title') || '(untitled)');
          return {
            taskId,
            completedAt: Number(completedAt || 0),
            title
          };
        })
        .filter((entry): entry is HistoryDayEntry => !!entry);

      out.push({
        dayKey: key,
        entries: items
      });
    }

    return out;
  };

  const rebuildDerivedState = () => {
    if (!ydocHandles.value) return;

    const listList: TaskList[] = [];
    ydocHandles.value.yLists.forEach((ylist, id) => {
      if (!(ylist instanceof Y.Map)) return;
      listList.push(listPlain(ylist, id));
    });
    listList.sort((a, b) => {
      const aOrder = a.order == null ? a.createdAt || 0 : Number(a.order || 0);
      const bOrder = b.order == null ? b.createdAt || 0 : Number(b.order || 0);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const taskList: Task[] = [];
    ydocHandles.value.yTasks.forEach((ytask) => {
      if (!(ytask instanceof Y.Map)) return;
      taskList.push(taskPlain(ytask));
    });

    const templateList: TemplateStat[] = [];
    ydocHandles.value.yTemplates.forEach((yt, key) => {
      if (!(yt instanceof Y.Map)) return;
      const parsed = parseTemplateId(String(key));
      templateList.push({
        key: String(key),
        listId: parsed.listId,
        title: String(yt.get('title') || parsed.baseKey || key),
        usageCount: Number(yt.get('usageCount') || 0),
        firstUsedAt: Number(yt.get('firstUsedAt') || 0),
        lastUsedAt: Number(yt.get('lastUsedAt') || 0),
        meanMinutes: Number(yt.get('meanMinutes') || 0),
        lastType: String(yt.get('lastType') || 'daily') as TaskType
      });
    });

    lists.value = listList;
    tasks.value = taskList;
    templates.value = templateList;
    const resolvedActive = resolveListId(activeListId.value, listList);
    if (resolvedActive !== activeListId.value) {
      activeListId.value = resolvedActive;
      try {
        localStorage.setItem(ACTIVE_LIST_KEY, resolvedActive);
      } catch {
        // ignore
      }
    }
    historyDays.value = buildHistoryDays(resolvedActive);
  };

  const migrateMultiList = () => {
    if (!ydocHandles.value) return;

    const { ydoc, yTasks, yTemplates } = ydocHandles.value;
    ydoc.transact(() => {
      ensureDefaultList();
      const listIds = new Set<string>([DEFAULT_LIST_ID]);

      yTasks.forEach((ytask) => {
        if (!(ytask instanceof Y.Map)) return;
        const current = ytask.get('listId');
        const listId = String(current || DEFAULT_LIST_ID).trim() || DEFAULT_LIST_ID;
        if (current == null || String(current) !== listId) ytask.set('listId', listId);
        listIds.add(listId);

        const templateKey = ytask.get('templateKey');
        if (templateKey != null) {
          const keyStr = String(templateKey);
          if (!keyStr.includes(TEMPLATE_SEP)) {
            ytask.set('templateKey', buildTemplateId(listId, keyStr));
          }
        }
      });

      const legacyTemplates: Array<{ key: string; yt: Y.Map<any> }> = [];
      yTemplates.forEach((yt, key) => {
        if (!(yt instanceof Y.Map)) return;
        const keyStr = String(key);
        if (!keyStr.includes(TEMPLATE_SEP)) {
          legacyTemplates.push({ key: keyStr, yt });
          listIds.add(DEFAULT_LIST_ID);
          return;
        }
        const parsed = parseTemplateId(keyStr);
        listIds.add(parsed.listId);
      });

      legacyTemplates.forEach(({ key, yt }) => {
        const newKey = buildTemplateId(DEFAULT_LIST_ID, key);
        if (!yTemplates.has(newKey)) yTemplates.set(newKey, yt);
        yTemplates.delete(key);
      });

      listIds.forEach((id) => {
        ensureListDefaults(id);
      });
    });
  };

  const updateSyncBadge = () => {
    peerCount.value = getPeerCount(provider.value);
    providerConnected.value = provider.value?.connected ?? false;
    if (peerCount.value > 0 && providerConnected.value && pendingTaskIds.value.length) {
      pendingTaskIds.value = [];
    }
  };

  const hasSignalingConnection = () =>
    Object.values(signalingStatus).some((status) => status && status.connected);

  const hardReconnect = (reason: string) => {
    const now = Date.now();
    if (now - lastHardReconnectAt < 5000) return;
    lastHardReconnectAt = now;
    logEvent('sync:hard_reconnect', { reason });
    if (session.value) {
      session.value
        .restart(reason)
        .catch((error) => logEvent('sync:hard_reconnect_failed', { reason, error: errToObj(error) }, 'WARN'));
      return;
    }
    connectSync();
  };

  const kickSignaling = (reason: string) => {
    const now = Date.now();
    if (now - lastKickAt < 4000) return;
    lastKickAt = now;
    if (!provider.value || !providerConnected.value || !session.value) {
      logEvent('sync:kick_fallback', { reason });
      connectSync();
      return;
    }
    if (webrtcPeers.value.length > 0 || bcPeers.value.length > 0) {
      logEvent('sync:kick_skip_pending_peers', {
        reason,
        webrtcPeers: webrtcPeers.value.length,
        bcPeers: bcPeers.value.length
      });
      return;
    }
    if (peerCount.value > 0) return;
    logEvent('sync:kick_signaling', { reason });
    try {
      // Safari/iOS has a long history of half-open WebSocket/WebRTC state after a
      // background/suspend. y-webrtc's disconnect/connect can leave sync stuck until
      // a full reload, so force a provider restart instead.
      if (isIOSLike) {
        logEvent('sync:kick_ios_hard', { reason });
        hardReconnect(`kick:${reason}`);
        return;
      }
      session.value.softReconnect(reason);
    } catch (error) {
      logEvent('sync:kick_failed', { reason, error: errToObj(error) }, 'WARN');
      connectSync();
    }
  };

  const resumeSync = (reason: string) => {
    if (!initialized.value) return;
    const calledAt = Date.now();
    if (calledAt - lastResumeAt < 2000) return;
    lastResumeAt = calledAt;

    // If we just came back from the background, remember how long we were away.
    // iOS often kills WebRTC/WebSocket connectivity while suspended.
    const sleptMs = !document.hidden && lastHiddenAt ? Math.max(0, calledAt - lastHiddenAt) : 0;
    if (!document.hidden && lastHiddenAt) lastHiddenAt = 0;
    if (resumeTimer != null) {
      window.clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    resumeTimer = window.setTimeout(() => {
      const now = Date.now();
      const age = signalingLastMessageAt.value ? now - signalingLastMessageAt.value : Infinity;
      const signalOk = hasSignalingConnection();
      const staleSignal = signalingLastMessageAt.value > 0 && age > 25_000;

      // iOS WebKit frequently resumes with half-open sockets / ICE state. This manifests as
      // "Sync: on" but no updates until a full page reload. Force a full provider restart
      // on resume from background, and also when signaling looks stale.
      if (isIOSLike && (sleptMs > 0 || staleSignal)) {
        logEvent('sync:resume_ios_hard', { reason, sleptMs, ageMs: age, staleSignal });
        hardReconnect(`resume:${reason}`);
        return;
      }
      if (reason.includes('online') || reason.includes('network')) {
        hardReconnect(`resume:${reason}`);
        return;
      }

      if (peerCount.value === 0) {
        if (webrtcPeers.value.length > 0 || bcPeers.value.length > 0) {
          logEvent('sync:resume_waiting_peers', {
            reason,
            webrtcPeers: webrtcPeers.value.length,
            bcPeers: bcPeers.value.length
          });
          return;
        }
        kickSignaling(`resume:${reason}`);
        return;
      }

      if (providerConnected.value && signalOk && age < 15000) {
        logEvent('sync:resume_skip', { reason, ageMs: age, connected: providerConnected.value });
        return;
      }

      if (session.value && providerConnected.value && signalOk) {
        logEvent('sync:resume_soft', { reason, ageMs: age });
        session.value.softReconnect(`resume:${reason}`);
        return;
      }

      logEvent('sync:resume_reconnect', { reason, ageMs: age });
      connectSync();
    }, 200);
  };

  const connectSync = async () => {
    if (!ydocHandles.value) return;

    const room = (keys.room || '').trim();
    const enc = (keys.enc || '').trim();
    const sigRaw = (keys.sig || '').trim();
    const turnKey = (keys.turnKey || '').trim();
    const turnEnabled = keys.turnEnabled !== false;

    if (!room) {
      toast('Connect key cannot be empty');
      return;
    }
    if (!enc) {
      toast('Encryption key cannot be empty');
      return;
    }

    persistKeysToStorage(localStorage, { room, enc, sig: sigRaw, turnKey, turnEnabled });
    writeKeysToUrl({ room, enc, sig: sigRaw, turnKey, turnEnabled });

    const sigList = parseSignalingList(sigRaw);
    const sig = sigList.length ? sigList : DEFAULT_SIGNALING;
    signaling.value = sig;
    signalingPeerSeenAt.value = 0;
    signalingLastMessageAt.value = 0;
    peerCount.value = 0;
    providerConnected.value = false;
    webrtcPeers.value = [];
    bcPeers.value = [];
    Object.keys(peerStates).forEach((peerId) => {
      delete peerStates[peerId];
    });
    iceState.value = null;
    usingTurn.value = false;
    // Reset cached signaling connection state. On iOS Safari in particular the page can be
    // frozen/suspended without firing clean disconnect events, leaving stale \"connected\" flags
    // around that can trick our resume logic.
    Object.keys(signalingStatus).forEach((url) => {
      delete signalingStatus[url];
    });

    if (session.value) session.value.dispose();
    provider.value = null;
    session.value = await createSyncSession({
      doc: ydocHandles.value,
      room,
      enc,
      signaling: sig,
      turnKey,
      turnEnabled,
      fetchFn: throttledFetch,
      storage: localStorage,
      platform: { isIPhone },
      debugSignaling: !!logger.value?.enabled,
      onProvider: (next) => {
        provider.value = next;
      },
      onStatus: ({ connected }) => {
        providerConnected.value = connected;
        updateSyncBadge();
      },
      onPeers: (peers) => {
        const nextWebrtc = Array.isArray(peers.webrtcPeers) ? peers.webrtcPeers : [];
        const prevWebrtc = webrtcPeers.value.slice();
        webrtcPeers.value = nextWebrtc;
        bcPeers.value = peers.bcPeers;
        const now = Date.now();
        nextWebrtc.forEach((peerId) => {
          if (!peerStates[peerId]) {
            peerStates[peerId] = {
              connected: false,
              lastEvent: 'peer_listed',
              lastChangeAt: now
            };
          }
        });
        prevWebrtc
          .filter((peerId) => !nextWebrtc.includes(peerId))
          .forEach((peerId) => {
            updatePeerState({ peerId, event: 'peer_removed', connected: false, at: now });
          });
      },
      onAwarenessChange: () => {
        updateSyncBadge();
        rebuildDerivedState();
      },
      onSignalingStatus: (status) => {
        signalingStatus[status.url] = status;
        if (status.lastMessageReceived) {
          signalingLastMessageAt.value = Math.max(signalingLastMessageAt.value, status.lastMessageReceived);
        }
      },
      onPeerSeen: (info) => {
        signalingPeerSeenAt.value = info.at;
      },
      onPeerState: (info) => {
        updatePeerState(info);
        if (info.event === 'ice_state' && String(info.iceState) === 'failed') {
          maybeForceRelay(`peer:${info.peerId}`);
        }
      },
      onIce: ({ config, reason }) => {
        usingTurn.value = config.mode !== 'stun';
        iceState.value = {
          mode: config.mode,
          transport: config.transport,
          count: config.iceServers.length,
          reason,
          at: Date.now()
        };
        logEvent('ice:config', { reason, mode: config.mode, transport: config.transport, count: config.iceServers.length });
        if (reason.includes('user_connect')) {
          if (config.mode === 'stun') toast('Using STUN-only ICE');
          else if (config.mode === 'turn') toast('Using TURN-first ICE');
          else toast('Using TURN+STUN ICE');
        }
      },
      onLog: logEvent
    });

    await session.value.start('user_connect');
  };

  const setActiveList = (id: string) => {
    const nextId = resolveListId(id);
    if (nextId === activeListId.value) return;
    activeListId.value = nextId;
    try {
      localStorage.setItem(ACTIVE_LIST_KEY, nextId);
    } catch {
      // ignore
    }
    historyDays.value = buildHistoryDays(nextId);
  };

  const createList = (input: { name: string; color?: string; meta?: Record<string, any> }) => {
    if (!ydocHandles.value) return '';
    const name = String(input.name || '').trim();
    if (!name) return '';
    const color = String(input.color || DEFAULT_LIST_COLOR).trim() || DEFAULT_LIST_COLOR;
    const id = crypto.randomUUID();

    ydocHandles.value.ydoc.transact(() => {
      const ylist = ensureList(id);
      if (!ylist) return;
      ylist.set('name', name);
      ylist.set('color', color);
      ylist.set('createdAt', Date.now());
      ylist.set('order', lists.value.length);
      if (input.meta && typeof input.meta === 'object') {
        ylist.set('meta', toJsonSafe(input.meta));
      }
    });

    snapshotMirror.value?.flush('createList', true);
    return id;
  };

  const updateList = (id: string, patch: Partial<TaskList>) => {
    if (!ydocHandles.value) return;
    const ylist = getList(id);
    if (!ylist) return;

    ydocHandles.value.ydoc.transact(() => {
      if (patch.name != null) {
        const name = String(patch.name || '').trim();
        if (name) ylist.set('name', name);
      }
      if (patch.color != null) {
        const color = String(patch.color || '').trim();
        if (color) ylist.set('color', color);
      }
      if (patch.order !== undefined) ylist.set('order', patch.order == null ? null : Number(patch.order));
      if (patch.archivedAt !== undefined) {
        ylist.set('archivedAt', patch.archivedAt == null ? null : Number(patch.archivedAt));
      }
      if (patch.meta !== undefined) {
        if (patch.meta && typeof patch.meta === 'object') {
          ylist.set('meta', toJsonSafe(patch.meta));
        }
      }
    });

    snapshotMirror.value?.flush('updateList', true);
  };

  const renameList = (id: string, name: string) => {
    updateList(id, { name });
  };

  const setListColor = (id: string, color: string) => {
    updateList(id, { color });
  };

  const addTask = (input: { title: string; type: TaskType; dueAt: number | null; listId?: string }) => {
    if (!ydocHandles.value) return;
    const title = input.title.trim();
    if (!title) return;

    const listId = resolveListId(input.listId || activeListId.value);
    ensureListDefaults(listId);

    let dueAt = input.dueAt;
    if (input.type !== 'scheduled') {
      dueAt = null;
    }

    const id = crypto.randomUUID();
    const needsSync = peerCount.value === 0 || !providerConnected.value;

    ydocHandles.value.ydoc.transact(() => {
      const ytask = new Y.Map();
      ytask.set('id', id);
      ytask.set('listId', listId);
      ytask.set('title', title);
      ytask.set('type', input.type);
      ytask.set('createdAt', Date.now());
      ytask.set('order', nextTaskOrder(listId));
      ytask.set('dueAt', dueAt);
      ytask.set('active', true);
      ytask.set('archivedAt', null);
      ytask.set('doneAt', null);
      ytask.set('completions', new Y.Map());
      ytask.set('templateKey', touchTemplate(listId, title, input.type, dueAt));
      ydocHandles.value?.yTasks.set(id, ytask);
    });

    if (needsSync) markTaskPending(id);
    snapshotMirror.value?.flush('addTask', true);
  };

  const reorderTasks = (orderedIds: string[]) => {
    if (!ydocHandles.value) return;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;
    ydocHandles.value.ydoc.transact(() => {
      orderedIds.forEach((id, index) => {
        const ytask = ensureTask(id);
        if (!ytask) return;
        ytask.set('order', index);
      });
    });
    snapshotMirror.value?.flush('reorderTasks', true);
  };

  const toggleCompletion = (id: string, checked: boolean) => {
    if (!ydocHandles.value) return;
    const key = logicalDayKey();

    ydocHandles.value.ydoc.transact(() => {
      const ytask = ensureTask(id);
      if (!ytask) return;

      const type = String(ytask.get('type') || 'daily') as TaskType;
      const completions = ensureMapField(ytask, 'completions');
      const dayHist = ensureDayHistory(key);

      if (checked) {
        completions.set(key, true);
        dayHist.set(id, Date.now());
        if (type === 'scheduled') ytask.set('doneAt', Date.now());
      } else {
        completions.delete(key);
        dayHist.delete(id);
        if (type === 'scheduled') ytask.set('doneAt', null);
      }
    });

    snapshotMirror.value?.flush('toggleCompletion', true);
  };

  const renameTask = (id: string, newTitle: string) => {
    if (!ydocHandles.value) return;
    const title = (newTitle || '').trim();
    if (!title) return;

    ydocHandles.value.ydoc.transact(() => {
      const ytask = ensureTask(id);
      if (!ytask) return;
      ytask.set('title', title);
      const type = String(ytask.get('type') || 'daily') as TaskType;
      const listId = String(ytask.get('listId') || DEFAULT_LIST_ID);
      const dueAt = ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt'));
      ytask.set('templateKey', touchTemplate(listId, title, type, dueAt));
    });

    snapshotMirror.value?.flush('renameTask', true);
  };

  const setTaskActive = (id: string, active: boolean) => {
    if (!ydocHandles.value) return;
    ydocHandles.value.ydoc.transact(() => {
      const ytask = ensureTask(id);
      if (!ytask) return;
      ytask.set('active', !!active);
    });
    snapshotMirror.value?.flush('setTaskActive', true);
  };

  const archiveTask = (id: string) => {
    if (!ydocHandles.value) return;
    ydocHandles.value.ydoc.transact(() => {
      const ytask = ensureTask(id);
      if (!ytask) return;
      ytask.set('archivedAt', Date.now());
    });
    snapshotMirror.value?.flush('archiveTask', true);
  };

  const exportJson = () => {
    if (!ydocHandles.value) return '';
    const snapshot = exportSnapshot(ydocHandles.value, { historyDays: 999999 });
    const backup: SnapshotV3 = {
      ...snapshot,
      v: 3,
      keys: {
        room: keys.room,
        enc: keys.enc,
        sig: keys.sig,
        turnKey: keys.turnKey,
        turnEnabled: keys.turnEnabled
      }
    };
    return JSON.stringify(backup, null, 2);
  };

  const importJson = async (snapshot: SnapshotV1 | SnapshotV2 | SnapshotV3) => {
    if (!ydocHandles.value) return;
    if (snapshot && (snapshot.v === 2 || snapshot.v === 3) && (snapshot as SnapshotV2 | SnapshotV3).keys) {
      const nextKeys = (snapshot as SnapshotV2 | SnapshotV3).keys as SnapshotKeys;
      keys.room = nextKeys.room || keys.room;
      keys.enc = nextKeys.enc || keys.enc;
      keys.sig = nextKeys.sig || keys.sig;
      keys.turnKey = nextKeys.turnKey || keys.turnKey;
      if (typeof nextKeys.turnEnabled === 'boolean') keys.turnEnabled = nextKeys.turnEnabled;
      persistKeysToStorage(localStorage, {
        room: keys.room,
        enc: keys.enc,
        sig: keys.sig,
        turnKey: keys.turnKey,
        turnEnabled: keys.turnEnabled
      });
      writeKeysToUrl({
        room: keys.room,
        enc: keys.enc,
        sig: keys.sig,
        turnKey: keys.turnKey,
        turnEnabled: keys.turnEnabled
      });
    }

    const baseSnapshot: SnapshotV1 | SnapshotV3 =
      snapshot && snapshot.v === 2
        ? {
            v: 1,
            exportedAt: snapshot.exportedAt,
            tasks: snapshot.tasks,
            templates: snapshot.templates,
            history: snapshot.history
          }
        : (snapshot as SnapshotV1 | SnapshotV3);

    importSnapshot(ydocHandles.value, baseSnapshot);
    snapshotMirror.value?.flush('importSnapshot', true);
    if (snapshot && (snapshot.v === 2 || snapshot.v === 3) && (snapshot as SnapshotV2 | SnapshotV3).keys) {
      await connectSync();
    }
  };

  const wipeLocal = async () => {
    if (!ydocHandles.value) return;

    try {
      if (session.value) {
        session.value.dispose();
        session.value = null;
      }
      provider.value = null;

      if (snapshotMirror.value) {
        snapshotMirror.value.dispose();
        snapshotMirror.value = null;
      }

      localStorage.removeItem('daylist.snapshot.v1');
      localStorage.removeItem('daylist.snapshot.v3');
      localStorage.removeItem(ACTIVE_LIST_KEY);
      localStorage.removeItem('daylist.meteredIceCache.v1');

      if (ydocHandles.value.persistence?.clearData) {
        await ydocHandles.value.persistence.clearData();
      }

      try {
        ydocHandles.value.ydoc.destroy();
      } catch {
        // ignore
      }

      toast('Local data cleared. Reloading...');
      window.location.reload();
    } catch (e) {
      logger.value?.log('wipe:failed', { error: errToObj(e) }, 'ERROR');
      toast('Wipe failed');
    }
  };

  const buildSuggestions = (query: string, opts: { listId?: string; max?: number } = {}) => {
    const now = Date.now();
    const listId = resolveListId(opts.listId || activeListId.value);
    const max = opts.max ?? 6;
    const list = templates.value.filter((item) => item.listId === listId);
    const fuse = new Fuse(list, {
      keys: ['title'],
      includeScore: true,
      threshold: 0.42,
      ignoreLocation: true,
      minMatchCharLength: 1
    });

    let candidates: Array<{ item: TemplateStat; score: number }> = [];
    if (!query) {
      candidates = list
        .map((item) => ({ item, score: suggestionScore(item, 0.65, now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
    } else {
      candidates = fuse
        .search(query, { limit: 20 })
        .map((r) => ({ item: r.item, score: suggestionScore(r.item, r.score, now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
    }

    const seen = new Set<string>();
    return candidates
      .filter(({ item }) => {
        const key = String(item.title || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ item }) => ({
        ...item,
        usageLabel: item.usageCount ? `- used ${item.usageCount}x` : '',
        lastLabel: item.lastUsedAt ? `- last ${formatDateTime(item.lastUsedAt)}` : '',
        timeLabel: `- ~${pad2(Math.floor(item.meanMinutes / 60))}:${pad2(Math.round(item.meanMinutes % 60))}`
      }));
  };

  const initApp = async () => {
    if (initialized.value) return;
    initialized.value = true;

    const log = createDebugLogger({ href: location.href, storage: localStorage });
    logger.value = log;
    bindDebugWindow(log);

    logEvent('boot:env', {
      href: location.href,
      origin: location.origin,
      secureContext: !!window.isSecureContext,
      ua: navigator.userAgent
    });

    const doc = createYDoc(logEvent);
    ydocHandles.value = doc;

    if (doc.persistence) {
      logEvent('idb:waiting_for_synced');
      await new Promise((resolve) => {
        if (doc.idbSynced.value) return resolve(true);
        const handler = () => {
          try {
            doc.persistence?.off('synced', handler);
          } catch {
            // ignore
          }
          resolve(true);
        };
        doc.persistence?.on('synced', handler);
      });

      idbReady.value = true;
      logEvent('idb:ready', { at: doc.idbSyncedAt.value, counts: { lists: doc.yLists.size, tasks: doc.yTasks.size } });

      try {
        const prev = await doc.persistence.get?.('meta:lastRunAt');
        logEvent('idb:meta_read', { prev });
        await doc.persistence.set?.('meta:lastRunAt', Date.now());
        logEvent('idb:meta_write_ok');

      } catch (e) {
        logEvent('idb:meta_write_failed', { error: errToObj(e) }, 'WARN');
      }
    } else {
      logEvent('idb:disabled_using_snapshot_only', null, 'WARN');
    }

    const snapshot = loadSnapshotFromStorage(localStorage);
    if (snapshot) {
      const templateCount =
        snapshot.v === 3
          ? Object.values(snapshot.templates || {}).reduce((sum, list) => sum + (list ? Object.keys(list).length : 0), 0)
          : snapshot.templates
            ? Object.keys(snapshot.templates).length
            : 0;
      logEvent('snapshot:boot_found', {
        bytes: JSON.stringify(snapshot).length,
        exportedAt: snapshot.exportedAt,
        v: snapshot.v,
        snapshotCounts: {
          lists: snapshot.v === 3 && snapshot.lists ? Object.keys(snapshot.lists).length : 0,
          tasks: snapshot.tasks?.length || 0,
          templates: templateCount,
          historyDays: snapshot.history ? Object.keys(snapshot.history).length : 0
        }
      });
      importSnapshot(doc, snapshot);
      logEvent('snapshot:boot_imported');
    } else {
      logEvent('snapshot:boot_none');
    }

    migrateMultiList();

    snapshotMirror.value = createSnapshotMirror({
      doc,
      storage: localStorage,
      historyDays: 120,
      debounceMs: 250,
      flushIntervalMs: 10_000,
      onToast: toast,
      onLog: logEvent
    });
    snapshotMirror.value.flush('boot', true);

    doc.ydoc.on('update', (update, origin) => {
      snapshotMirror.value?.markDirty();

      const originName =
        origin == null
          ? 'null'
          : typeof origin === 'string'
            ? origin
            : origin.constructor?.name || typeof origin;

      if (origin == null || typeof origin === 'string') {
        lastLocalChangeAt.value = Date.now();
      }

      logEvent('ydoc:update', {
        updateBytes: update?.length ?? null,
        origin: originName,
        counts: {
          lists: doc.yLists.size,
          tasks: doc.yTasks.size,
          templates: doc.yTemplates.size,
          historyDays: doc.yHistory.size
        }
      });

      rebuildDerivedState();
    });

    doc.ydoc.on('afterTransaction', (tr) => {

      const originName =
        tr?.origin == null
          ? 'null'
          : typeof tr.origin === 'string'
            ? tr.origin
            : tr.origin?.constructor?.name || typeof tr.origin;

      const changed: Array<{ type: string; keyCount: number }> = [];
      try {
        tr.changed.forEach((subs, type) => {
          const keyCount = subs?.size ?? 0;
          let typeName = type?.constructor?.name || 'Type';
          if (type === doc.yLists) typeName = 'yLists';
          if (type === doc.yTasks) typeName = 'yTasks';
          if (type === doc.yTemplates) typeName = 'yTemplates';
          if (type === doc.yHistory) typeName = 'yHistory';
          changed.push({ type: typeName, keyCount });
        });
      } catch {
        // ignore
      }

      logEvent('ydoc:afterTransaction', {
        local: !!tr.local,
        origin: originName,
        changed
      }, 'DEBUG');
    });

    const resolved = resolveInitialKeys({
      href: location.href,
      storage: localStorage,
      prompt: window.prompt,
      randomKey
    });

    keys.room = resolved.room;
    keys.enc = resolved.enc;
    keys.sig = resolved.sig;
    keys.turnKey = resolved.turnKey;
    keys.turnEnabled = resolved.turnEnabled;

    rebuildDerivedState();

    await connectSync();

    setInterval(() => {
      nowTs.value = Date.now();
      historyDays.value = buildHistoryDays(activeListId.value);
    }, 30_000);

    toast('Ready');

    if (stopVersionPoll) stopVersionPoll();
    stopVersionPoll = startVersionPolling({
      intervalMs: 10_000,
      onUpdate: (info) => {
        logEvent('version:update_available', info);
        toast('Update available. Reload to fetch.');
      },
      onError: (error) => {
        logEvent('version:check_failed', { error: errToObj(error) }, 'DEBUG');
      },
      log: logEvent
    });

    document.addEventListener('visibilitychange', () => {
      const at = Date.now();
      logLifecycleEvent('visibilitychange', { at, hidden: document.hidden });
      if (document.hidden) {
        lastHiddenAt = at;
        // When iOS suspends the app it may not deliver clean disconnect events.
        // Mark signaling timestamps stale so our resume logic doesn't trust cached state.
        signalingLastMessageAt.value = 0;
        signalingPeerSeenAt.value = 0;
        logLifecycleAction('visibilitychange', 'mark_signaling_stale', { at });
        return;
      }
      logLifecycleAction('visibilitychange', 'resume_sync', { reason: 'visibility' });
      resumeSync('visibility');
    });

    // Some iOS transitions fire pagehide/pageshow instead of (or in addition to) visibility.
    window.addEventListener('pagehide', (event) => {
      const at = Date.now();
      lastHiddenAt = at;
      logLifecycleEvent('pagehide', { at, persisted: (event as PageTransitionEvent).persisted });
    });
    window.addEventListener('pageshow', (event) => {
      const at = Date.now();
      const persisted = (event as PageTransitionEvent).persisted;
      logLifecycleEvent('pageshow', { at, persisted });
      if (persisted) {
        logLifecycleAction('pageshow', 'resume_sync', { reason: 'pageshow:bfcache', persisted });
        resumeSync('pageshow:bfcache');
      }
    });
    window.addEventListener('focus', () => {
      const at = Date.now();
      logLifecycleEvent('focus', { at });
      logLifecycleAction('focus', 'resume_sync', { reason: 'focus' });
      resumeSync('focus');
    });
    window.addEventListener('blur', () => {
      logLifecycleEvent('blur', { at: Date.now() });
    });
    window.addEventListener('online', () => {
      logEvent('network:online');
      logLifecycleEvent('online', { at: Date.now() });
      logLifecycleAction('online', 'resume_sync', { reason: 'network:online' });
      resumeSync('network:online');
    });
    window.addEventListener('offline', () => {
      lastOfflineAt = Date.now();
      logEvent('network:offline', { at: lastOfflineAt });
      logLifecycleEvent('offline', { at: lastOfflineAt });
      signalingLastMessageAt.value = 0;
      logLifecycleAction('offline', 'mark_signaling_stale', { at: lastOfflineAt });
    });

    if (watchdogTimer != null) window.clearInterval(watchdogTimer);
    watchdogTimer = window.setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const lastSignal = signalingLastMessageAt.value || 0;
      const staleSignal = lastSignal > 0 && now - lastSignal > 25_000;
      const neverSignaled = lastSignal === 0 && initialized.value;
      const recentLocalChange = lastLocalChangeAt.value > 0 && now - lastLocalChangeAt.value < 6000;
      if (staleSignal) {
        if (navigator.onLine) hardReconnect('watchdog:stale_signal');
        else resumeSync('watchdog:stale_signal');
      } else if (!providerConnected.value && (staleSignal || neverSignaled)) {
        resumeSync('watchdog:disconnected');
      } else if (
        peerCount.value === 0 &&
        recentLocalChange &&
        webrtcPeers.value.length === 0 &&
        bcPeers.value.length === 0
      ) {
        kickSignaling('watchdog:local_change');
      }
    }, 15_000);

    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        logEvent('storage:estimate', { usage: est.usage, quota: est.quota });
      }
      if (navigator.storage?.persisted) {
        const persisted = await navigator.storage.persisted();
        logEvent('storage:persisted', { persisted });
      }
    } catch (e) {
      logEvent('storage:estimate_failed', { error: errToObj(e) }, 'WARN');
    }
  };

  const parseDueInput = (value: string) => {
    if (!value) return null;
    return parseDatetimeLocalValue(value);
  };

  const formatDueInput = (value: number) => toDatetimeLocalValue(value);

  const buildDefaultDue = () => {
    const now = Date.now();
    return Math.ceil((now + 30 * 60000) / (5 * 60000)) * (5 * 60000);
  };

  return {
    keys,
    providerConnected,
    peerCount,
    idbReady,
    nowTs,
    lists,
    activeListId,
    activeList,
    tasks,
    tasksForActiveList,
    templates,
    historyDays,
    usingTurn,
    signaling,
    signalingStatus,
    webrtcPeers,
    bcPeers,
    peerStates,
    iceState,
    logEntries,
    dayKey,
    dayLabel,
    snapshotActive,
    syncReady,
    initialized,
    initApp,
    connectSync,
    setActiveList,
    createList,
    updateList,
    renameList,
    setListColor,
    addTask,
    reorderTasks,
    toggleCompletion,
    renameTask,
    setTaskActive,
    archiveTask,
    exportJson,
    importJson,
    wipeLocal,
    isTaskSyncing,
    buildSuggestions,
    parseDueInput,
    formatDueInput,
    buildDefaultDue,
    clearDiagnosticsLog: () => {
      logEntries.value = [];
    }
  };
});
