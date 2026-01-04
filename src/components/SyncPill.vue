<template>
  <div
    id="syncPill"
    class="pill"
    :class="store.providerConnected ? 'online' : 'offline'"
    title="Peer-to-peer sync status"
  >
    <span class="dot" aria-hidden="true"></span>
    <span>{{ store.providerConnected ? 'Sync: on' : 'Sync: off' }}</span>
    <span class="mono">peers:</span>
    <span id="peersCount">{{ store.peerCount }}</span>
  </div>
</template>

<script setup lang="ts">
import { useDaylistStore } from '../stores/daylist';

const store = useDaylistStore();
</script>
