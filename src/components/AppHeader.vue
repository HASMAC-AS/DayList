<template>
  <header>
    <div class="brand">
      <div class="logo" aria-hidden="true">OK</div>
      <div>
        <h1>DayList</h1>
        <div class="sub" id="dayLabel">{{ store.dayLabel }}</div>
      </div>
    </div>

    <div class="header-actions">
      <SyncPill v-if="view === 'main'" />
      <button
        v-if="view === 'main'"
        class="icon-btn"
        type="button"
        aria-label="Open settings"
        @click="$emit('openSettings')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm8.94 3.06-.86-.5.1-1.1a1 1 0 0 0-.6-1l-1.1-.5-.3-1.05a1 1 0 0 0-.8-.7l-1.17-.15-.62-.9a1 1 0 0 0-1.05-.38l-1.13.35-.9-.65a1 1 0 0 0-1.1 0l-.9.65-1.13-.35a1 1 0 0 0-1.05.38l-.62.9-1.17.15a1 1 0 0 0-.8.7l-.3 1.05-1.1.5a1 1 0 0 0-.6 1l.1 1.1-.86.5a1 1 0 0 0-.46 1.16l.38 1.1-.7.86a1 1 0 0 0-.02 1.17l.7.9-.38 1.1a1 1 0 0 0 .46 1.16l.86.5-.1 1.1a1 1 0 0 0 .6 1l1.1.5.3 1.05a1 1 0 0 0 .8.7l1.17.15.62.9a1 1 0 0 0 1.05.38l1.13-.35.9.65a1 1 0 0 0 1.1 0l.9-.65 1.13.35a1 1 0 0 0 1.05-.38l.62-.9 1.17-.15a1 1 0 0 0 .8-.7l.3-1.05 1.1-.5a1 1 0 0 0 .6-1l-.1-1.1.86-.5a1 1 0 0 0 .46-1.16l-.38-1.1.7-.9a1 1 0 0 0 .02-1.17l-.7-.86.38-1.1a1 1 0 0 0-.46-1.16Z"
          />
        </svg>
      </button>
      <button
        v-else
        class="back-btn"
        type="button"
        @click="$emit('closeSettings')"
      >
        Back
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import SyncPill from './SyncPill.vue';
import { useDaylistStore } from '../stores/daylist';

defineProps<{ view: 'main' | 'settings' }>();
defineEmits<{ openSettings: []; closeSettings: [] }>();

const store = useDaylistStore();
</script>
