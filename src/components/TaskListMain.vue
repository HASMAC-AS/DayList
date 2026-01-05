<template>
  <div class="main-list">
    <transition-group id="todayList" name="task-slide" tag="div" class="task-list">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="task-drag-item"
        :class="{
          dragging: draggingId === task.id,
          'drag-over': dragOverId === task.id,
          before: dragOverId === task.id && dropPosition === 'before',
          after: dragOverId === task.id && dropPosition === 'after'
        }"
        draggable="true"
        @dragstart="onDragStart($event, task.id)"
        @dragend="onDragEnd"
        @dragover.prevent="onDragOver($event, task.id)"
        @drop.prevent="onDrop($event, task.id)"
      >
        <TaskRow
          :task="task"
          :day-key="dayKey"
          :syncing="store.isTaskSyncing(task.id)"
          :dragging="draggingId === task.id"
          @toggle="store.toggleCompletion"
          @archive="store.archiveTask"
          @activate="(id) => store.setTaskActive(id, true)"
          @deactivate="(id) => store.setTaskActive(id, false)"
          @rename="store.renameTask"
        />
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { logicalDayKey } from '../lib/core';
import { useDaylistStore } from '../stores/daylist';
import TaskRow from './TaskRow.vue';

const store = useDaylistStore();
const dayKey = computed(() => logicalDayKey(store.nowTs));
const draggingId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
const dropPosition = ref<'before' | 'after' | null>(null);

const tasks = computed(() => {
  const now = store.nowTs;
  const orderValue = (task: { order?: number | null; createdAt: number }) =>
    task.order == null ? task.createdAt || 0 : Number(task.order || 0);
  return store.tasksForActiveList
    .filter((task) => {
      if (!task || task.archivedAt) return false;
      if (task.type === 'daily') return task.active !== false;
      return (task.dueAt || 0) <= now;
    })
    .slice()
    .sort((a, b) => orderValue(a) - orderValue(b));
});

const onDragStart = (event: DragEvent, id: string) => {
  draggingId.value = id;
  dragOverId.value = null;
  dropPosition.value = null;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
};

const onDragOver = (event: DragEvent, id: string) => {
  if (!draggingId.value || draggingId.value === id) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  dragOverId.value = id;
  dropPosition.value = before ? 'before' : 'after';
};

const onDrop = (_event: DragEvent, id: string) => {
  const dragId = draggingId.value;
  if (!dragId) return;
  const list = tasks.value.map((task) => task.id);
  const without = list.filter((taskId) => taskId !== dragId);
  let targetIndex = without.indexOf(id);
  if (targetIndex === -1) targetIndex = without.length;
  if (dropPosition.value === 'after') targetIndex += 1;
  without.splice(targetIndex, 0, dragId);
  store.reorderTasks(without);
  onDragEnd();
};

const onDragEnd = () => {
  draggingId.value = null;
  dragOverId.value = null;
  dropPosition.value = null;
};
</script>
