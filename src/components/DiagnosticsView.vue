<template>
  <div class="diagnostics-view">
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
          <div class="diag-label">Build</div>
          <div class="diag-value mono">{{ buildId }}</div>
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
      <div class="section-title">Live log</div>
      <div class="log-actions">
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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { redact } from '../lib/core';
import { BUILD_ID } from '../lib/build';
import { useDaylistStore } from '../stores/daylist';

const store = useDaylistStore();
const logEl = ref<HTMLElement | null>(null);
const buildId = BUILD_ID;

const redactedEnc = computed(() => redact(store.keys.enc || '', 4) || '-');
const signalingRows = computed(() => {
  return Object.values(store.signalingStatus).sort((a, b) => a.url.localeCompare(b.url));
});

const formatTime = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleTimeString();
};

const formatData = (data: unknown) => {
  if (data == null) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
};

const scrollToBottom = () => {
  if (!logEl.value) return;
  logEl.value.scrollTop = logEl.value.scrollHeight;
};

onMounted(scrollToBottom);
watch(
  () => store.logEntries.length,
  async () => {
    await nextTick();
    scrollToBottom();
  }
);
</script>
