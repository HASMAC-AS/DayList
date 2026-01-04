<template>
  <div id="todayList" class="main-list">
    <div v-if="tasks.length === 0" class="empty">No tasks yet. Tap + to add one.</div>
    <TaskRow
      v-for="task in tasks"
      :key="task.id"
      :task="task"
      :day-key="sections.dayKey"
      @toggle="store.toggleCompletion"
      @archive="store.archiveTask"
      @activate="(id) => store.setTaskActive(id, true)"
      @deactivate="(id) => store.setTaskActive(id, false)"
      @rename="store.renameTask"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { buildTodaySections } from '../lib/todayModel';
import { useDaylistStore } from '../stores/daylist';
import TaskRow from './TaskRow.vue';

const store = useDaylistStore();
const sections = computed(() => buildTodaySections(store.tasks, store.nowTs));

const tasks = computed(() => {
  return [...sections.value.daily, ...sections.value.scheduledDue];
});
</script>
