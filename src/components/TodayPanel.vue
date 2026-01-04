<template>
  <div>
    <div id="todayList">
      <template v-if="sections.daily.length">
        <div class="section-title">Daily</div>
        <TaskRow
          v-for="task in sections.daily"
          :key="task.id"
          :task="task"
          :day-key="sections.dayKey"
          :syncing="store.isTaskSyncing(task.id)"
          @toggle="store.toggleCompletion"
          @archive="store.archiveTask"
          @activate="(id) => store.setTaskActive(id, true)"
          @deactivate="(id) => store.setTaskActive(id, false)"
          @rename="store.renameTask"
        />
      </template>

      <template v-if="sections.scheduledDue.length">
        <div class="section-title">Due now</div>
        <TaskRow
          v-for="task in sections.scheduledDue"
          :key="task.id"
          :task="task"
          :day-key="sections.dayKey"
          :syncing="store.isTaskSyncing(task.id)"
          @toggle="store.toggleCompletion"
          @archive="store.archiveTask"
          @activate="(id) => store.setTaskActive(id, true)"
          @deactivate="(id) => store.setTaskActive(id, false)"
          @rename="store.renameTask"
        />
      </template>

      <div v-if="!sections.daily.length && !sections.scheduledDue.length" class="empty">\n        No tasks yet. Add one above.\n      </div>
    </div>

    <details id="upcomingDetails">
      <summary>Upcoming (<span id="upcomingCount">{{ sections.scheduledUpcoming.length }}</span>)</summary>
      <div class="bd">
        <div id="upcomingList">
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
          <div v-if="!sections.scheduledUpcoming.length" class="empty">Nothing scheduled.</div>
        </div>
      </div>
    </details>

    <details>
      <summary>History</summary>
      <div class="bd">
        <HistoryPanel />
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { buildTodaySections } from '../lib/todayModel';
import { useDaylistStore } from '../stores/daylist';
import TaskRow from './TaskRow.vue';
import HistoryPanel from './HistoryPanel.vue';

const store = useDaylistStore();

const sections = computed(() => buildTodaySections(store.tasks, store.nowTs));
</script>
