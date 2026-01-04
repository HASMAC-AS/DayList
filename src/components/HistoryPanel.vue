<template>
  <div id="historyList">
    <div v-for="day in store.historyDays" :key="day.dayKey" class="history-day">
      <div class="history-head">
        <div class="history-date">{{ day.dayKey }}</div>
        <div class="history-count">{{ day.entries.length }} done</div>
      </div>
      <div v-if="day.entries.length" class="history-items">
        <span v-for="entry in day.entries" :key="entry.taskId" class="history-item">
          {{ entry.title }}
        </span>
      </div>
      <div v-else class="empty">No completions logged.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDaylistStore } from '../stores/daylist';

const store = useDaylistStore();
</script>
