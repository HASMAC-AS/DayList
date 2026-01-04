<template>
  <details>
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
        <button id="copyLinkBtn" @click="copyLink">Copy link</button>
      </div>

      <div class="row" style="align-items: flex-end; margin-top: 10px">
        <div class="grow">
          <div class="hint">
            Metered TURN API key (recommended). If set, we fetch TURN/STUN credentials and use them as the primary ICE
            servers.
          </div>
          <input id="turnKeyInput" v-model="store.keys.turnKey" type="password" placeholder="optional but recommended" />
        </div>
      </div>

      <div class="row" style="align-items: flex-end; margin-top: 10px">
        <div class="grow">
          <div class="hint">Signaling servers (comma-separated). Leave blank to use defaults.</div>
          <input id="sigInput" v-model="store.keys.sig" type="text" placeholder="wss://signaling.yjs.dev, wss://..." />
        </div>
      </div>

      <div class="hint" style="margin-top: 10px">
        WebRTC works across the internet; TURN usually makes it \"just work\" across strict NATs/corporate Wi-Fi.
        Using TURN costs bandwidth - so that API key is basically a small money faucet.
      </div>

      <div class="spacer"></div>

      <div class="row">
        <button id="exportBtn" @click="exportSnapshot">Export JSON</button>
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
import { useDaylistStore } from '../stores/daylist';
import { writeKeysToUrl } from '../services/sync/keys';
import { useToastBus } from '../services/toast';

const store = useDaylistStore();
const { show: toast } = useToastBus();

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
    store.importJson(JSON.parse(text));
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
