<template>
  <div class="settings-stack">
    <section class="settings-block">
      <div class="section-title">Upcoming</div>
      <div id="upcomingList">
        <div v-if="sections.scheduledUpcoming.length === 0" class="empty">Nothing scheduled.</div>
        <TaskRow
          v-for="task in sections.scheduledUpcoming"
          :key="task.id"
          :task="task"
          :day-key="sections.dayKey"
          :syncing="store.isTaskSyncing(task.id)"
          upcoming
          @toggle="store.toggleCompletion"
          @archive="store.archiveTask"
          @activate="(id) => store.setTaskActive(id, true)"
          @deactivate="(id) => store.setTaskActive(id, false)"
          @rename="store.renameTask"
        />
      </div>
    </section>

    <section class="settings-block">
      <details>
        <summary>History</summary>
        <div class="bd">
          <HistoryPanel />
        </div>
      </details>
    </section>

    <section class="settings-block">
      <SyncBackupPanel />
    </section>

    <section class="settings-block settings-actions-bottom">
      <button class="chip ghost" type="button" :disabled="reloading" @click="reloadApp">Reload</button>
      <button class="chip primary" type="button" @click="$emit('openDiagnostics')">Diagnostics</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { buildTodaySections } from '../lib/todayModel';
import { useDaylistStore } from '../stores/daylist';
import { persistKeysToStorage, writeKeysToUrl } from '../services/sync/keys';
import TaskRow from './TaskRow.vue';
import HistoryPanel from './HistoryPanel.vue';
import SyncBackupPanel from './SyncBackupPanel.vue';

defineEmits<{ openDiagnostics: [] }>();

const store = useDaylistStore();
const sections = computed(() => buildTodaySections(store.tasks, store.nowTs));
const reloading = ref(false);

const reloadApp = () => {
  if (reloading.value) return;
  reloading.value = true;
  persistKeysToStorage(localStorage, store.keys);
  writeKeysToUrl(store.keys);
  window.setTimeout(() => {
    window.location.reload();
  }, 50);
};
</script>
