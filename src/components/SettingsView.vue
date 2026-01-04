<template>
  <div>
    <div class="settings-header">
      <div class="section-title">Settings</div>
      <button class="chip primary" type="button" @click="$emit('openDiagnostics')">Diagnostics</button>
    </div>
    <section class="settings-block">
      <div class="section-title">Upcoming</div>
      <div id="upcomingList">
        <div v-if="sections.scheduledUpcoming.length === 0" class="empty">Nothing scheduled.</div>
        <TaskRow
          v-for="task in sections.scheduledUpcoming"
          :key="task.id"
          :task="task"
          :day-key="sections.dayKey"
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
      <details open>
        <summary>History</summary>
        <div class="bd">
          <HistoryPanel />
        </div>
      </details>
    </section>

    <section class="settings-block">
      <SyncBackupPanel />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { buildTodaySections } from '../lib/todayModel';
import { useDaylistStore } from '../stores/daylist';
import TaskRow from './TaskRow.vue';
import HistoryPanel from './HistoryPanel.vue';
import SyncBackupPanel from './SyncBackupPanel.vue';

defineEmits<{ openDiagnostics: [] }>();

const store = useDaylistStore();
const sections = computed(() => buildTodaySections(store.tasks, store.nowTs));
</script>
