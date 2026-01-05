<template>
  <div ref="rootEl" class="diagnostics-view">
    <div class="settings-block">
      <div class="section-title">Components</div>
      <div class="diag-grid">
        <div class="diag-item">
          <div class="diag-label">App initialized</div>
          <div class="diag-value">{{ store.initialized ? 'Yes' : 'No' }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">IndexedDB ready</div>
          <div class="diag-value">{{ store.idbReady ? 'Yes' : 'No' }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Snapshot mirror</div>
          <div class="diag-value">{{ store.snapshotActive ? 'Active' : 'Inactive' }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Tasks loaded</div>
          <div class="diag-value">{{ store.tasks.length }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Templates loaded</div>
          <div class="diag-value">{{ store.templates.length }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">History days</div>
          <div class="diag-value">{{ store.historyDays.length }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Diagnostics view size</div>
          <div class="diag-value mono">{{ diagSizeLabel }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Build</div>
          <div class="diag-value mono">{{ buildId }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Build time</div>
          <div class="diag-value mono">{{ buildTimeLabel }}</div>
        </div>
      </div>
    </div>

    <div class="settings-block">
      <div class="section-title">Connections</div>
      <div class="diag-grid">
        <div class="diag-item">
          <div class="diag-label">Sync provider</div>
          <div class="diag-value">{{ store.providerConnected ? 'Connected' : 'Disconnected' }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Peer count</div>
          <div class="diag-value">{{ store.peerCount }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">TURN in use</div>
          <div class="diag-value">{{ store.usingTurn ? 'Yes' : 'No' }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Room</div>
          <div class="diag-value mono">{{ store.keys.room || '-' }}</div>
        </div>
        <div class="diag-item">
          <div class="diag-label">Encryption</div>
          <div class="diag-value mono">{{ redactedEnc }}</div>
        </div>
      </div>
    </div>

    <div class="settings-block">
      <div class="section-title">Peers</div>
      <div class="diag-list">
        <div class="diag-row">
          <div class="diag-label">WebRTC peers</div>
          <div class="diag-value">{{ store.webrtcPeers.length ? store.webrtcPeers.join(', ') : 'None' }}</div>
        </div>
        <div class="diag-row">
          <div class="diag-label">Broadcast peers</div>
          <div class="diag-value">{{ store.bcPeers.length ? store.bcPeers.join(', ') : 'None' }}</div>
        </div>
      </div>
    </div>

    <div class="settings-block">
      <div class="section-title">Signaling servers</div>
      <div v-if="signalingRows.length === 0" class="empty">No signaling servers configured.</div>
      <div v-for="row in signalingRows" :key="row.url" class="diag-row">
        <div class="diag-label mono">{{ row.url }}</div>
        <div class="diag-value">
          <span :class="row.connected ? 'status-pill ok' : 'status-pill warn'">
            {{ row.connected ? 'Connected' : row.connecting ? 'Connecting' : 'Disconnected' }}
          </span>
          <span class="muted">last msg: {{ row.lastMessageReceived ? new Date(row.lastMessageReceived).toLocaleTimeString() : '-' }}</span>
        </div>
      </div>
    </div>

    <div class="settings-block log-block">
      <div class="section-title">PWA lifecycle (iOS)</div>
      <div class="log-actions">
        <button class="chip ghost" type="button" @click="store.clearDiagnosticsLog">Clear</button>
      </div>
      <div v-if="iosLifecycleEntries.length === 0" class="empty">No lifecycle events yet.</div>
      <div v-else ref="iosLogEl" class="log-stream">
        <div v-for="entry in iosLifecycleEntries" :key="entry.id" class="log-entry">
          <div class="log-meta">
            <span class="log-time">{{ formatTime(entry.ts) }}</span>
            <span class="log-level" :class="entry.level.toLowerCase()">{{ entry.level }}</span>
            <span class="log-event">{{ entry.event }}</span>
          </div>
          <pre class="log-data">{{ formatData(entry.data) }}</pre>
        </div>
      </div>
    </div>

    <div class="settings-block log-block">
      <div class="section-title">Live log</div>
      <div class="log-actions">
        <button class="chip ghost" type="button" @click="copyLiveLog">Copy</button>
        <button class="chip ghost" type="button" @click="store.clearDiagnosticsLog">Clear</button>
      </div>
      <div ref="logEl" class="log-stream">
        <div v-for="entry in store.logEntries" :key="entry.id" class="log-entry">
          <div class="log-meta">
            <span class="log-time">{{ formatTime(entry.ts) }}</span>
            <span class="log-level" :class="entry.level.toLowerCase()">{{ entry.level }}</span>
            <span class="log-event">{{ entry.event }}</span>
          </div>
          <pre class="log-data">{{ formatData(entry.data) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { redact } from '../lib/core';
import { BUILD_ID, BUILD_TIME } from '../lib/build';
import { useDaylistStore } from '../stores/daylist';
import { useToastBus } from '../services/toast';

const store = useDaylistStore();
const { show: toast } = useToastBus();
const rootEl = ref<HTMLElement | null>(null);
const logEl = ref<HTMLElement | null>(null);
const iosLogEl = ref<HTMLElement | null>(null);
const buildId = BUILD_ID;
const buildTime = BUILD_TIME;
const diagSize = ref({ width: '-', height: '-' });
let resizeObserver: ResizeObserver | null = null;

const buildTimeLabel = computed(() => {
  if (!buildTime) return '-';
  const date = new Date(buildTime);
  if (Number.isNaN(date.valueOf())) return buildTime;
  return `${date.toLocaleString()} (${buildTime})`;
});

const redactedEnc = computed(() => redact(store.keys.enc || '', 4) || '-');
const signalingRows = computed(() => {
  return Object.values(store.signalingStatus).sort((a, b) => a.url.localeCompare(b.url));
});

const updateDiagSize = () => {
  if (!rootEl.value) return;
  const styles = getComputedStyle(rootEl.value);
  diagSize.value = {
    width: styles.width || '-',
    height: styles.height || '-'
  };
};

const diagSizeLabel = computed(() => `${diagSize.value.width} × ${diagSize.value.height}`);

const getReason = (data: unknown) => {
  if (!data || typeof data !== 'object') return '';
  if (!('reason' in data)) return '';
  return String((data as { reason?: unknown }).reason ?? '');
};

const isIosLifecycleEvent = (entry: { event: string; data: unknown }) => {
  const event = entry.event || '';
  if (event.startsWith('lifecycle:')) return true;
  if (event.startsWith('sync:resume_')) return true;
  if (event.startsWith('sync:kick_')) return true;
  if (event === 'sync:hard_reconnect') {
    const reason = getReason(entry.data);
    return (
      reason.startsWith('resume:') ||
      reason.startsWith('kick:') ||
      reason.includes('visibility') ||
      reason.includes('pagehide') ||
      reason.includes('pageshow') ||
      reason.includes('focus') ||
      reason.includes('network')
    );
  }
  if (event === 'network:online' || event === 'network:offline') return true;
  if (event.includes('ios')) return true;
  return false;
};

const iosLifecycleEntries = computed(() => {
  return store.logEntries.filter((entry) => isIosLifecycleEvent(entry));
});

const logTimeFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
  timeZoneName: 'short'
});

const formatTime = (ts: number) => {
  const d = new Date(ts);
  return logTimeFormatter.format(d);
};

const formatData = (data: unknown) => {
  if (data == null) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
};

const formatMaybeTime = (ts?: number) => {
  if (!ts) return null;
  return formatTime(ts);
};

const buildLogCopy = (
  entries: Array<{ ts: number; level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'; event: string; data: unknown }>
) => {
  return entries
    .map((entry) => {
      const header = `[${formatTime(entry.ts)}] ${entry.level} ${entry.event}`;
      const data = formatData(entry.data);
      return data ? `${header}\n${data}` : header;
    })
    .join('\n\n');
};

const buildSyncStateCopy = () => {
  const signalingStatus = Object.values(store.signalingStatus)
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((status) => ({
      url: status.url,
      connected: status.connected,
      connecting: status.connecting,
      lastMessageReceived: status.lastMessageReceived || 0,
      lastMessageReceivedLabel: formatMaybeTime(status.lastMessageReceived)
    }));

  const peerEntries = Object.entries(store.peerStates).sort(([a], [b]) => a.localeCompare(b));
  const peerStates = peerEntries.reduce(
    (acc, [peerId, state]) => {
      acc[peerId] = {
        ...state,
        lastChangeAtLabel: formatMaybeTime(state.lastChangeAt)
      };
      return acc;
    },
    {} as Record<string, unknown>
  );

  const connectedPeers = peerEntries.filter(([, state]) => state.connected).map(([peerId]) => peerId);
  const disconnectedPeers = peerEntries.filter(([, state]) => !state.connected).map(([peerId]) => peerId);

  return {
    providerConnected: store.providerConnected,
    peerCount: store.peerCount,
    webrtcPeers: store.webrtcPeers,
    bcPeers: store.bcPeers,
    connectedPeers,
    disconnectedPeers,
    peerStates,
    signaling: {
      urls: store.signaling,
      status: signalingStatus
    },
    turn: {
      enabled: store.keys.turnEnabled,
      usingTurn: store.usingTurn,
      turnKeySet: !!store.keys.turnKey,
      ice: store.iceState
        ? {
            ...store.iceState,
            atLabel: formatMaybeTime(store.iceState.at)
          }
        : null
    }
  };
};

const buildDiagnosticsCopy = () => {
  const parts: string[] = [];
  const logText = store.logEntries.length ? buildLogCopy(store.logEntries) : '(empty)';
  parts.push('LIVE_LOG', logText);
  parts.push('SYNC_STATE', JSON.stringify(buildSyncStateCopy(), null, 2));
  const state = store.exportJson();
  parts.push('APP_STATE', state || '(unavailable)');
  return parts.join('\n\n');
};

const copyLiveLog = async () => {
  const payload = buildDiagnosticsCopy();
  try {
    await navigator.clipboard.writeText(payload);
    toast('Diagnostics copied');
  } catch {
    window.prompt('Copy diagnostics:', payload);
  }
};

const scrollToBottom = (el: HTMLElement | null) => {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
};

onMounted(() => {
  updateDiagSize();
  if (rootEl.value && 'ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => updateDiagSize());
    resizeObserver.observe(rootEl.value);
  } else {
    window.addEventListener('resize', updateDiagSize);
  }
  scrollToBottom(logEl.value);
  scrollToBottom(iosLogEl.value);
});

onBeforeUnmount(() => {
  if (resizeObserver && rootEl.value) {
    resizeObserver.unobserve(rootEl.value);
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  window.removeEventListener('resize', updateDiagSize);
});
watch(
  () => store.logEntries.length,
  async () => {
    await nextTick();
    scrollToBottom(logEl.value);
    scrollToBottom(iosLogEl.value);
  }
);
</script>
