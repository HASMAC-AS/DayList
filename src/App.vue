<template>
  <div class="wrap">
    <AppHeader />

    <div class="card" style="--delay: 0ms">
      <div class="hd">
        <div style="font-weight: 800">Add a task</div>
        <div class="hint">Daily tasks reset at 03:00 local time. Scheduled tasks appear when their due time arrives.</div>
      </div>
      <div class="bd">
        <TaskComposer />
      </div>
    </div>

    <div class="spacer"></div>

    <div class="card" style="--delay: 80ms">
      <div class="hd">
        <div style="font-weight: 800">Today</div>
        <div class="hint">Check things off; they'll reset automatically at 03:00.</div>
      </div>
      <div class="bd">
        <TodayPanel />
      </div>
    </div>

    <SyncBackupPanel />

    <div class="footer">
      Offline-first PWA: once loaded at least once, it keeps working without internet. Install from your browser menu.
    </div>
  </div>

  <ToastHost />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import AppHeader from './components/AppHeader.vue';
import TaskComposer from './components/TaskComposer.vue';
import TodayPanel from './components/TodayPanel.vue';
import SyncBackupPanel from './components/SyncBackupPanel.vue';
import ToastHost from './components/ToastHost.vue';
import { useDaylistStore } from './stores/daylist';

const store = useDaylistStore();

onMounted(() => {
  store.initApp();
});
</script>
