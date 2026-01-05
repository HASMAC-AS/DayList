<template>
  <div class="main-list">
    <div class="barrel-shell">
      <div
        class="barrel-track"
        :class="{ animating: isAnimating }"
        :style="{ transform: `translateX(${trackOffset * 33.3333}%)` }"
        @transitionend="onTrackTransitionEnd"
      >
        <div
          v-for="pane in panes"
          :key="pane.slot"
          class="barrel-pane"
          :class="{ inactive: !pane.active, incoming: pane.incoming, outgoing: pane.outgoing }"
        >
          <div id="todayList" class="task-list">
            <div
              v-for="task in tasksForList(pane.id)"
              :key="task.id"
              class="task-drag-item"
              :class="{
                dragging: pane.active && draggingId === task.id,
                'drag-over': pane.active && dragOverId === task.id,
                before: pane.active && dragOverId === task.id && dropPosition === 'before',
                after: pane.active && dragOverId === task.id && dropPosition === 'after'
              }"
              :draggable="pane.active"
              @dragstart="pane.active ? onDragStart($event, task.id) : undefined"
              @dragend="pane.active ? onDragEnd() : undefined"
              @dragover.prevent="pane.active ? onDragOver($event, task.id) : undefined"
              @drop.prevent="pane.active ? onDrop($event, task.id) : undefined"
            >
              <TaskRow
                :task="task"
                :day-key="dayKey"
                :syncing="store.isTaskSyncing(task.id)"
                :dragging="pane.active && draggingId === task.id"
                @toggle="store.toggleCompletion"
                @archive="store.archiveTask"
                @activate="(id) => store.setTaskActive(id, true)"
                @deactivate="(id) => store.setTaskActive(id, false)"
                @rename="store.renameTask"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { logicalDayKey } from '../lib/core';
import { useDaylistStore } from '../stores/daylist';
import TaskRow from './TaskRow.vue';

const store = useDaylistStore();
const dayKey = computed(() => logicalDayKey(store.nowTs));
const draggingId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
const dropPosition = ref<'before' | 'after' | null>(null);
const trackOffset = ref(-1);
const isAnimating = ref(false);
const pendingCenter = ref<string | null>(null);
const panes = ref<
  Array<{
    slot: 'left' | 'center' | 'right';
    id: string | null;
    active: boolean;
    incoming: boolean;
    outgoing: boolean;
  }>
>([
  { slot: 'left', id: null, active: false, incoming: false, outgoing: false },
  { slot: 'center', id: null, active: true, incoming: false, outgoing: false },
  { slot: 'right', id: null, active: false, incoming: false, outgoing: false }
]);

const listIds = computed(() => store.lists.map((list) => list.id));
const getListIndex = (id: string) => listIds.value.findIndex((listId) => listId === id);

const setPanesForCenter = (centerId: string) => {
  const index = getListIndex(centerId);
  const left = index > 0 ? listIds.value[index - 1] : null;
  const right = index >= 0 && index < listIds.value.length - 1 ? listIds.value[index + 1] : null;
  panes.value = [
    { slot: 'left', id: left, active: false, incoming: false, outgoing: false },
    { slot: 'center', id: centerId, active: true, incoming: false, outgoing: false },
    { slot: 'right', id: right, active: false, incoming: false, outgoing: false }
  ];
};

const setPanesForTransition = (fromId: string, toId: string, direction: 'forward' | 'back') => {
  const fromIndex = getListIndex(fromId);
  const left = direction === 'back' ? toId : fromIndex > 0 ? listIds.value[fromIndex - 1] : null;
  const right =
    direction === 'forward'
      ? toId
      : fromIndex >= 0 && fromIndex < listIds.value.length - 1
        ? listIds.value[fromIndex + 1]
        : null;
  panes.value = [
    { slot: 'left', id: left, active: false, incoming: direction === 'back', outgoing: false },
    { slot: 'center', id: fromId, active: true, incoming: false, outgoing: true },
    { slot: 'right', id: right, active: false, incoming: direction === 'forward', outgoing: false }
  ];
};

const finishTransition = () => {
  if (!pendingCenter.value) return;
  setPanesForCenter(pendingCenter.value);
  pendingCenter.value = null;
  trackOffset.value = -1;
  isAnimating.value = false;
};

const tasksForList = (listId: string | null) => {
  if (!listId) return [];
  const now = store.nowTs;
  const orderValue = (task: { order?: number | null; createdAt: number }) =>
    task.order == null ? task.createdAt || 0 : Number(task.order || 0);
  return store.tasks
    .filter((task) => {
      if (!task || task.archivedAt) return false;
      if (task.listId !== listId) return false;
      if (task.type === 'daily') return task.active !== false;
      return (task.dueAt || 0) <= now;
    })
    .slice()
    .sort((a, b) => orderValue(a) - orderValue(b));
};

watch(
  listIds,
  () => {
    if (store.activeListId) setPanesForCenter(store.activeListId);
  },
  { immediate: true }
);

watch(
  () => store.activeListId,
  (nextId, prevId) => {
    if (!nextId || nextId === prevId) return;
    const nextIndex = getListIndex(nextId);
    const prevIndex = prevId ? getListIndex(prevId) : -1;
    if (nextIndex === -1 || prevIndex === -1) {
      setPanesForCenter(nextId);
      return;
    }
    if (isAnimating.value) finishTransition();
    const direction = nextIndex > prevIndex ? 'forward' : 'back';
    setPanesForTransition(prevId, nextId, direction);
    pendingCenter.value = nextId;
    isAnimating.value = true;
    trackOffset.value = direction === 'forward' ? -2 : 0;
  }
);

const onTrackTransitionEnd = (event: TransitionEvent) => {
  if (event.propertyName !== 'transform') return;
  finishTransition();
};

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
  const list = tasksForList(store.activeListId).map((task) => task.id);
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
