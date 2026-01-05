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
import type { HistoryDay, Task, TaskType, TemplateStat, SnapshotV1, SnapshotV2, SnapshotKeys } from '../lib/types';
import { createDebugLogger, bindDebugWindow, type DebugLogger } from '../services/sync/debugLog';
import { getIceServers } from '../services/sync/meteredTurn';
import { createRateLimitedFetch } from '../services/sync/netThrottle';
import { connectProvider, getPeerCount, type SignalingStatus } from '../services/sync/provider';
import {
  createSnapshotMirror,
  exportSnapshot,
  importSnapshot,
  loadSnapshotFromStorage
} from '../services/sync/snapshot';
import { createYDoc, type YDocHandles } from '../services/sync/ydoc';
import { persistKeysToStorage, resolveInitialKeys, type SyncKeys, writeKeysToUrl } from '../services/sync/keys';
import { useToastBus } from '../services/toast';
import { startVersionPolling } from '../services/versionCheck';

const DEFAULT_SIGNALING = ['wss://daylist-signaling.onrender.com/ws', 'wss://signaling.yjs.dev'];
const HISTORY_DAYS = 7;
const TURN_UPGRADE_DELAY_MS = 800;
const TURN_SIGNAL_GRACE_MS = 800;
const TURN_MAX_WAIT_MS = 4000;

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
  const tasks = ref<Task[]>([]);
  const templates = ref<TemplateStat[]>([]);
  const historyDays = ref<HistoryDay[]>([]);
  const usingTurn = ref(false);
  const signaling = ref<string[]>(DEFAULT_SIGNALING);
  const signalingStatus = reactive<Record<string, SignalingStatus>>({});
  const signalingLastMessageAt = ref(0);
  const webrtcPeers = ref<string[]>([]);
  const bcPeers = ref<string[]>([]);
  const pendingTaskIds = ref<string[]>([]);
  const lastLocalChangeAt = ref(0);
  let lastKickAt = 0;
  const signalingPeerSeenAt = ref(0);

  const ydocHandles = shallowRef<YDocHandles | null>(null);
  const provider = shallowRef<WebrtcProvider | null>(null);
  const snapshotMirror = shallowRef<ReturnType<typeof createSnapshotMirror> | null>(null);
  const logger = shallowRef<DebugLogger | null>(null);
  const initialized = ref(false);
  let turnUpgradeTimer: number | null = null;
  let stopVersionPoll: (() => void) | null = null;
  let resumeTimer: number | null = null;
  let lastResumeAt = 0;
  let lastHiddenAt = 0;
  let watchdogTimer: number | null = null;
  let lastHardReconnectAt = 0;
  let lastOfflineAt = 0;
  let turnUpgradeStartAt = 0;

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

  const markTaskPending = (id: string) => {
    if (!id) return;
    if (pendingTaskIds.value.includes(id)) return;
    pendingTaskIds.value = [...pendingTaskIds.value, id];
  };

  const isTaskSyncing = (id: string) => pendingTaskIds.value.includes(id);

  const nextTaskOrder = () => {
    let max = 0;
    tasks.value.forEach((task) => {
      const value = task.order == null ? task.createdAt || 0 : Number(task.order || 0);
      if (value > max) max = value;
    });
    return max + 1;
  };

  const { show: toast } = useToastBus();

  const dayKey = computed(() => logicalDayKey(nowTs.value));
  const dayLabel = computed(() => `Day: ${dayKey.value} (resets ${pad2(BOUNDARY_HOUR)}:00 local)`);
  const snapshotActive = computed(() => !!snapshotMirror.value);
  const throttledFetch = createRateLimitedFetch(fetch, 300);

  const ensureTask = (id: string) => {
    const ytask = ydocHandles.value?.yTasks.get(id);
    return ytask instanceof Y.Map ? ytask : null;
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

  const touchTemplate = (title: string, typeHint: TaskType = 'daily', dueAt: number | null = null) => {
    const key = normalizeTitle(title);
    if (!key || !ydocHandles.value) return null;

    let yt = ydocHandles.value.yTemplates.get(key);
    if (!(yt instanceof Y.Map)) {
      yt = new Y.Map();
      ydocHandles.value.yTemplates.set(key, yt);
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

    return key;
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

  const buildHistoryDays = (daysBack = HISTORY_DAYS) => {
    if (!ydocHandles.value) return [] as HistoryDay[];
    const out: HistoryDay[] = [];
    const now = nowTs.value;

    for (let i = 0; i < daysBack; i++) {
      const key = logicalDayKey(now - i * DAY_MS);
      const m = ydocHandles.value.yHistory.get(key);
      const entries = m instanceof Y.Map ? [...m.entries()] : [];
      entries.sort((a, b) => Number(a[1]) - Number(b[1]));

      const items = entries.map(([taskId, completedAt]) => {
        const ytask = ydocHandles.value?.yTasks.get(taskId);
        const title = ytask instanceof Y.Map ? String(ytask.get('title') || '(untitled)') : '(missing task)';
        return {
          taskId,
          completedAt: Number(completedAt || 0),
          title
        };
      });

      out.push({
        dayKey: key,
        entries: items
      });
    }

    return out;
  };

  const rebuildDerivedState = () => {
    if (!ydocHandles.value) return;

    const taskList: Task[] = [];
    ydocHandles.value.yTasks.forEach((ytask) => {
      if (!(ytask instanceof Y.Map)) return;
      taskList.push(taskPlain(ytask));
    });

    const templateList: TemplateStat[] = [];
    ydocHandles.value.yTemplates.forEach((yt, key) => {
      if (!(yt instanceof Y.Map)) return;
      templateList.push({
        key,
        title: String(yt.get('title') || key),
        usageCount: Number(yt.get('usageCount') || 0),
        firstUsedAt: Number(yt.get('firstUsedAt') || 0),
        lastUsedAt: Number(yt.get('lastUsedAt') || 0),
        meanMinutes: Number(yt.get('meanMinutes') || 0),
        lastType: String(yt.get('lastType') || 'daily') as TaskType
      });
    });

    tasks.value = taskList;
    templates.value = templateList;
    historyDays.value = buildHistoryDays();
  };

  const updateSyncBadge = () => {
    peerCount.value = getPeerCount(provider.value);
    providerConnected.value = provider.value?.connected ?? false;
    if (peerCount.value > 0 && providerConnected.value && pendingTaskIds.value.length) {
      pendingTaskIds.value = [];
    }
  };

  const clearTurnUpgradeTimer = () => {
    if (turnUpgradeTimer != null) {
      window.clearTimeout(turnUpgradeTimer);
      turnUpgradeTimer = null;
    }
  };

  const hasSignalingConnection = () =>
    Object.values(signalingStatus).some((status) => status && status.connected);

  const hardReconnect = (reason: string) => {
    const now = Date.now();
    if (now - lastHardReconnectAt < 5000) return;
    lastHardReconnectAt = now;
    logEvent('sync:hard_reconnect', { reason });
    connectSync();
  };

  const kickSignaling = (reason: string) => {
    const now = Date.now();
    if (now - lastKickAt < 4000) return;
    lastKickAt = now;
    if (!provider.value || !providerConnected.value) {
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
      provider.value.disconnect();
      provider.value.connect();
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

      if (provider.value && providerConnected.value && signalOk) {
        logEvent('sync:resume_soft', { reason, ageMs: age });
        try {
          provider.value.disconnect();
          provider.value.connect();
          return;
        } catch (error) {
          logEvent('sync:resume_soft_failed', { reason, error: errToObj(error) }, 'WARN');
        }
      }

      logEvent('sync:resume_reconnect', { reason, ageMs: age });
      connectSync();
    }, 200);
  };

  const connectSync = async () => {
    if (!ydocHandles.value) return;
    const hasPeers = () => peerCount.value > 0;
    const hasRecentSignalPeer = () =>
      signalingPeerSeenAt.value > 0 && Date.now() - signalingPeerSeenAt.value < TURN_SIGNAL_GRACE_MS;

    const maybeSkipSecondary = (reason: string) => {
      if (!turnUpgradeTimer) return false;
      if (!hasPeers()) return false;
      logEvent('ice:secondary_skip_peers', {
        reason,
        peerCount: peerCount.value,
        webrtcPeers: webrtcPeers.value.length,
        bcPeers: bcPeers.value.length
      });
      clearTurnUpgradeTimer();
      return true;
    };

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
    // Reset cached signaling connection state. On iOS Safari in particular the page can be
    // frozen/suspended without firing clean disconnect events, leaving stale "connected" flags
    // around that can trick our resume logic.
    Object.keys(signalingStatus).forEach((url) => {
      delete signalingStatus[url];
    });

    const hasTurnServer = (iceServers: RTCIceServer[]) =>
      iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => typeof url === 'string' && (url.startsWith('turn:') || url.startsWith('turns:')));
      });

    const iceKey = (server: RTCIceServer) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return `${urls.join('|')}|${server.username || ''}|${String(server.credential || '')}`;
    };

    const mergeIceServers = (primary: RTCIceServer[], secondary: RTCIceServer[]) => {
      const seen = new Set<string>();
      const merged: RTCIceServer[] = [];
      const addServer = (server: RTCIceServer) => {
        const key = iceKey(server);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(server);
      };
      primary.forEach(addServer);
      secondary.forEach(addServer);
      return merged;
    };

    const connectWithIce = async (iceServers: RTCIceServer[], context: string) => {
      const hasTurn = iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => typeof url === 'string' && (url.startsWith('turn:') || url.startsWith('turns:')));
      });
      usingTurn.value = hasTurn;
      peerCount.value = 0;
      providerConnected.value = false;
      webrtcPeers.value = [];
      bcPeers.value = [];

      if (provider.value) {
        try {
          provider.value.destroy();
        } catch {
          // ignore
        }
        provider.value = null;
      }

      provider.value = await connectProvider({
        doc: ydocHandles.value,
        room,
        enc,
        signaling: sig,
        iceServers,
        onAwarenessChange: () => {
          updateSyncBadge();
          rebuildDerivedState();
          maybeSkipSecondary('awareness');
        },
        onPeerSeen: (info) => {
          signalingPeerSeenAt.value = info.at;
        },
        onStatus: () => {
          updateSyncBadge();
        },
        onSignalingStatus: (status) => {
          signalingStatus[status.url] = status;
          if (status.lastMessageReceived) {
            signalingLastMessageAt.value = Math.max(signalingLastMessageAt.value, status.lastMessageReceived);
          }
        },
        onPeers: (peers) => {
          webrtcPeers.value = peers.webrtcPeers;
          bcPeers.value = peers.bcPeers;
          maybeSkipSecondary('peers');
        },
        onLog: logEvent
      });

      updateSyncBadge();
      logEvent('sync:provider_connected', { context, usingTurn: hasTurn });

      if (context === 'turn-primary' && !hasTurn && turnKey) toast('TURN fetch failed; staying STUN-only');
      else if (context === 'turn-primary' && hasTurn) toast('Using TURN-first ICE');
      else if (context === 'stun-primary') toast('Using STUN-only ICE');
    };

    clearTurnUpgradeTimer();
    turnUpgradeStartAt = 0;
    const stunOnlyPromise = getIceServers({
      turnKey,
      allowTurn: false,
      fetchFn: throttledFetch,
      storage: localStorage,
      now: () => Date.now(),
      log: logEvent
    });

    let turnIce: RTCIceServer[] | null = null;
    let turnHasTurn = false;
    if (turnKey && turnEnabled) {
      turnIce = await getIceServers({
        turnKey,
        allowTurn: true,
        fetchFn: throttledFetch,
        storage: localStorage,
        now: () => Date.now(),
        log: logEvent
      });
      turnHasTurn = hasTurnServer(turnIce);
    }

    const stunOnlyIce = await stunOnlyPromise;

    if (turnIce && turnHasTurn) {
      await connectWithIce(turnIce, 'turn-primary');
    } else {
      await connectWithIce(stunOnlyIce, 'stun-primary');
    }

    if (turnKey && turnEnabled) {
      if (!turnIce || !turnHasTurn) return;

      const secondaryIce = isIPhone ? stunOnlyIce : mergeIceServers(turnIce, stunOnlyIce);
      const turnKeys = new Set(turnIce.map((server) => iceKey(server)));
      const secondaryKeys = new Set(secondaryIce.map((server) => iceKey(server)));
      const hasSecondaryDiff =
        secondaryKeys.size !== turnKeys.size ||
        Array.from(secondaryKeys).some((key) => !turnKeys.has(key));
      const secondaryContext = isIPhone ? 'stun-secondary' : 'turn+stun-secondary';

      if (!secondaryIce.length || !hasSecondaryDiff) {
        logEvent('ice:secondary_skip_same', { target: secondaryContext });
        return;
      }

      const scheduleSecondary = (delayMs: number, reason: string) => {
        clearTurnUpgradeTimer();
        if (!turnUpgradeStartAt) turnUpgradeStartAt = Date.now();
        turnUpgradeTimer = window.setTimeout(runSecondary, delayMs);
        logEvent('ice:secondary_scheduled', { delayMs, reason, target: secondaryContext });
      };

      const runSecondary = async () => {
        if (!turnUpgradeTimer) return;
        const now = Date.now();
        if (!turnUpgradeStartAt) turnUpgradeStartAt = now;
        if (hasRecentSignalPeer() && now - turnUpgradeStartAt < TURN_MAX_WAIT_MS) {
          logEvent('ice:secondary_delay_signal', {
            delayMs: TURN_SIGNAL_GRACE_MS,
            seenMsAgo: now - signalingPeerSeenAt.value,
            target: secondaryContext
          });
          scheduleSecondary(TURN_SIGNAL_GRACE_MS, 'signal_recent');
          return;
        }
        logEvent('ice:secondary_check', {
          delayMs: TURN_UPGRADE_DELAY_MS,
          peerCount: peerCount.value,
          webrtcPeers: webrtcPeers.value.length,
          bcPeers: bcPeers.value.length,
          target: secondaryContext
        });
        if (hasPeers()) {
          logEvent('ice:secondary_skip_peers', {
            reason: 'delay_check',
            peerCount: peerCount.value,
            webrtcPeers: webrtcPeers.value.length,
            bcPeers: bcPeers.value.length,
            target: secondaryContext
          });
          clearTurnUpgradeTimer();
          return;
        }

        logEvent('ice:secondary_connecting', { target: secondaryContext });
        await connectWithIce(secondaryIce, secondaryContext);
        clearTurnUpgradeTimer();
      };

      scheduleSecondary(TURN_UPGRADE_DELAY_MS, 'initial');
    }
  };

  const addTask = (input: { title: string; type: TaskType; dueAt: number | null }) => {
    if (!ydocHandles.value) return;
    const title = input.title.trim();
    if (!title) return;

    let dueAt = input.dueAt;
    if (input.type !== 'scheduled') {
      dueAt = null;
    }

    const id = crypto.randomUUID();
    const needsSync = peerCount.value === 0 || !providerConnected.value;

    ydocHandles.value.ydoc.transact(() => {
      const ytask = new Y.Map();
      ytask.set('id', id);
      ytask.set('title', title);
      ytask.set('type', input.type);
      ytask.set('createdAt', Date.now());
      ytask.set('order', nextTaskOrder());
      ytask.set('dueAt', dueAt);
      ytask.set('active', true);
      ytask.set('archivedAt', null);
      ytask.set('doneAt', null);
      ytask.set('completions', new Y.Map());
      ytask.set('templateKey', touchTemplate(title, input.type, dueAt));
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
      const dueAt = ytask.get('dueAt') == null ? null : Number(ytask.get('dueAt'));
      ytask.set('templateKey', touchTemplate(title, type, dueAt));
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
    const backup: SnapshotV2 = {
      ...snapshot,
      v: 2,
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

  const importJson = async (snapshot: SnapshotV1 | SnapshotV2) => {
    if (!ydocHandles.value) return;
    if (snapshot && snapshot.v === 2 && (snapshot as SnapshotV2).keys) {
      const nextKeys = (snapshot as SnapshotV2).keys as SnapshotKeys;
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

    const baseSnapshot: SnapshotV1 =
      snapshot && snapshot.v === 2
        ? {
            v: 1,
            exportedAt: snapshot.exportedAt,
            tasks: snapshot.tasks,
            templates: snapshot.templates,
            history: snapshot.history
          }
        : (snapshot as SnapshotV1);

    importSnapshot(ydocHandles.value, baseSnapshot);
    snapshotMirror.value?.flush('importSnapshot', true);
    if (snapshot && snapshot.v === 2 && (snapshot as SnapshotV2).keys) {
      await connectSync();
    }
  };

  const wipeLocal = async () => {
    if (!ydocHandles.value) return;

    try {
      if (provider.value) {
        try {
          provider.value.destroy();
        } catch {
          // ignore
        }
        provider.value = null;
      }

      if (snapshotMirror.value) {
        snapshotMirror.value.dispose();
        snapshotMirror.value = null;
      }

      localStorage.removeItem('daylist.snapshot.v1');
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

  const buildSuggestions = (query: string, max = 6) => {
    const now = Date.now();
    const list = templates.value.slice();
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

    return candidates.map(({ item }) => ({
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
      logEvent('idb:ready', { at: doc.idbSyncedAt.value, counts: { tasks: doc.yTasks.size } });

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
      logEvent('snapshot:boot_found', {
        bytes: JSON.stringify(snapshot).length,
        exportedAt: snapshot.exportedAt,
        v: snapshot.v,
        snapshotCounts: {
          tasks: snapshot.tasks?.length || 0,
          templates: snapshot.templates ? Object.keys(snapshot.templates).length : 0,
          historyDays: snapshot.history ? Object.keys(snapshot.history).length : 0
        }
      });
      importSnapshot(doc, snapshot);
      logEvent('snapshot:boot_imported');
    } else {
      logEvent('snapshot:boot_none');
    }

    snapshotMirror.value = createSnapshotMirror({
      doc,
      storage: localStorage,
      historyDays: 120,
      debounceMs: 250,
      flushIntervalMs: 10_000,
      onToast: toast,
      onLog: logEvent
    });

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
        counts: { tasks: doc.yTasks.size, templates: doc.yTemplates.size, historyDays: doc.yHistory.size }
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
      historyDays.value = buildHistoryDays();
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
      if (document.hidden) {
        lastHiddenAt = Date.now();
        logEvent('lifecycle:hidden', { at: lastHiddenAt });
        // When iOS suspends the app it may not deliver clean disconnect events.
        // Mark signaling timestamps stale so our resume logic doesn't trust cached state.
        signalingLastMessageAt.value = 0;
        signalingPeerSeenAt.value = 0;
        return;
      }
      resumeSync('visibility');
    });

    // Some iOS transitions fire pagehide/pageshow instead of (or in addition to) visibility.
    window.addEventListener('pagehide', (event) => {
      lastHiddenAt = Date.now();
      logEvent('lifecycle:pagehide', { at: lastHiddenAt, persisted: (event as PageTransitionEvent).persisted });
    });
    window.addEventListener('focus', () => resumeSync('focus'));
    window.addEventListener('online', () => {
      logEvent('network:online');
      resumeSync('network:online');
    });
    window.addEventListener('offline', () => {
      lastOfflineAt = Date.now();
      logEvent('network:offline', { at: lastOfflineAt });
      signalingLastMessageAt.value = 0;
    });
    window.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) resumeSync('pageshow:bfcache');
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
    tasks,
    templates,
    historyDays,
    usingTurn,
    signaling,
    signalingStatus,
    webrtcPeers,
    bcPeers,
    logEntries,
    dayKey,
    dayLabel,
    snapshotActive,
    initialized,
    initApp,
    connectSync,
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
