<template>
  <details :open="open" @toggle="$emit('toggle', $event)">
    <summary>Sync & Backup</summary>
    <div class="bd">
      <div class="hint">
        Keys are stored in the URL query for easy sharing:
        <span class="mono">?room=...&amp;enc=...</span>
        (and optionally <span class="mono">&amp;sig=...</span>, <span class="mono">&amp;turnKey=...</span>).
      </div>

      <div class="row" style="align-items: flex-end; margin-top: 10px">
        <div class="grow">
          <div class="hint">Connect key (room). Same value =&gt; peers try to discover each other.</div>
          <input id="roomInput" v-model="store.keys.room" type="text" />
        </div>
        <div class="grow">
          <div class="hint">Encryption key (required). Used to encrypt signaling messages.</div>
          <input id="encInput" v-model="store.keys.enc" type="password" placeholder="required" />
        </div>
        <button id="reconnectBtn" @click="store.connectSync">Reconnect</button>
      </div>

      <div class="row" style="align-items: flex-end; margin-top: 10px">
        <div class="grow">
          <div class="hint">
            Metered TURN API key (recommended). If set, we fetch TURN/STUN credentials and use them as the primary ICE
            servers.
          </div>
          <input id="turnKeyInput" v-model="store.keys.turnKey" type="password" placeholder="optional but recommended" />
        </div>
        <label class="checkbox">
          <input
            id="turnEnabledInput"
            v-model="store.keys.turnEnabled"
            type="checkbox"
            @change="applyTurnToggle"
          />
          Use TURN
        </label>
      </div>

      <div class="row" style="align-items: flex-end; margin-top: 10px">
        <div class="grow">
          <div class="hint">Signaling servers (comma-separated). Leave blank to use defaults.</div>
          <input id="sigInput" v-model="store.keys.sig" type="text" placeholder="wss://signaling.yjs.dev, wss://..." />
        </div>
      </div>

      <div class="row" style="margin-top: 12px">
        <div class="grow">
          <div class="hint">Settings JSON (room + enc + signaling + TURN). Copy/paste between clients.</div>
          <textarea
            id="settingsJson"
            v-model="settingsJsonDraft"
            class="mono"
            rows="4"
            spellcheck="false"
            @focus="jsonFocused = true"
            @blur="jsonFocused = false"
          ></textarea>
        </div>
        <div class="col">
          <button id="copySettingsBtn" @click="copySettingsJson">Copy JSON</button>
          <button id="applySettingsBtn" @click="applySettingsJson">Apply JSON</button>
        </div>
      </div>

      <div class="hint" style="margin-top: 10px">
        WebRTC works across the internet; TURN usually makes it \"just work\" across strict NATs/corporate Wi-Fi.
        Using TURN costs bandwidth - so that API key is basically a small money faucet. Toggle it off to test LAN-only.
      </div>

      <div class="spacer"></div>

      <div class="row">
        <button id="exportBtn" @click="exportSnapshot">Export JSON</button>
        <button id="copyLinkBtn" @click="copyLink">Copy link</button>
        <label class="chip" style="cursor: pointer">
          Import JSON
          <input id="importFile" type="file" accept="application/json" style="display: none" @change="importSnapshot" />
        </label>
        <button class="danger" id="wipeBtn" @click="wipeLocal">Wipe local data</button>
      </div>

      <div class="hint" style="margin-top: 10px">
        Primary storage is on-device (IndexedDB). A lightweight snapshot is also mirrored to
        <span class="mono">localStorage</span>.
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDaylistStore } from '../stores/daylist';
import { persistKeysToStorage, writeKeysToUrl } from '../services/sync/keys';
import { useToastBus } from '../services/toast';

defineProps<{ open?: boolean }>();
defineEmits<{ toggle: [Event] }>();

const store = useDaylistStore();
const { show: toast } = useToastBus();

const buildSettingsPayload = () => ({
  v: 1,
  room: store.keys.room,
  enc: store.keys.enc,
  sig: store.keys.sig,
  turnKey: store.keys.turnKey,
  turnEnabled: store.keys.turnEnabled
});

const settingsJson = computed(() => JSON.stringify(buildSettingsPayload(), null, 2));
const settingsJsonDraft = ref(settingsJson.value);
const jsonFocused = ref(false);

watch(settingsJson, (next) => {
  if (!jsonFocused.value) settingsJsonDraft.value = next;
});

const copyLink = async () => {
  writeKeysToUrl(store.keys);
  const link = window.location.href;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied');
  } catch {
    window.prompt('Copy this link:', link);
  }
};

const copySettingsJson = async () => {
  try {
    await navigator.clipboard.writeText(settingsJson.value);
    toast('Settings JSON copied');
  } catch {
    window.prompt('Copy settings JSON:', settingsJson.value);
  }
};

const applyTurnToggle = async () => {
  persistKeysToStorage(localStorage, store.keys);
  writeKeysToUrl(store.keys);
  await store.connectSync();
};

const applySettingsJson = async () => {
  try {
    const parsed = JSON.parse(settingsJsonDraft.value || '{}');
    const payload = parsed && typeof parsed === 'object' && 'keys' in parsed ? parsed.keys : parsed;
    if (!payload || typeof payload !== 'object') {
      toast('Invalid settings JSON');
      return;
    }
    const next = payload as Partial<{
      room: string;
      enc: string;
      sig: string;
      turnKey: string;
      turnEnabled: boolean;
    }>;
    if (typeof next.room === 'string') store.keys.room = next.room;
    if (typeof next.enc === 'string') store.keys.enc = next.enc;
    if (typeof next.sig === 'string') store.keys.sig = next.sig;
    if (typeof next.turnKey === 'string') store.keys.turnKey = next.turnKey;
    if (typeof next.turnEnabled === 'boolean') store.keys.turnEnabled = next.turnEnabled;
    await store.connectSync();
    toast('Settings applied');
  } catch {
    toast('Settings JSON invalid');
  }
};

const exportSnapshot = () => {
  const json = store.exportJson();
  if (!json) return;
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `daylist-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

  const importSnapshot = async (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
    await store.importJson(JSON.parse(text));
    toast('Imported');
    } catch {
      toast('Import failed (invalid JSON)');
    } finally {
      input.value = '';
    }
  };

const wipeLocal = async () => {
  const ok = window.confirm('This will delete ALL local data (IndexedDB + localStorage mirror). Continue?');
  if (!ok) return;
  await store.wipeLocal();
};
</script>
