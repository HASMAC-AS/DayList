<template>
  <div
    class="task-wrap"
    :class="{ swiped: swiped, 'show-actions': showActions }"
    @touchstart="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
  >
    <div class="task-actions">
      <button
        v-if="task.type === 'daily'"
        class="task-action hide"
        type="button"
        @click="onToggleActive"
      >
        {{ task.active ? 'Hide' : 'Show' }}
      </button>
      <button class="task-action archive" type="button" @click="onArchive">Archive</button>
    </div>
    <div
      class="task"
      :data-id="task.id"
      :style="{ transform: `translateX(${offsetX}px)` }"
      @click="onClickTask"
    >
      <label class="check">
        <input
          type="checkbox"
          class="toggle"
          :checked="completed"
          @change="onToggle"
        />
        <span></span>
      </label>
      <div class="main">
        <div class="rowline">
          <div class="title-wrap">
            <div
              class="title"
              :class="{ done: completed }"
              title="Double-click to rename"
              @dblclick="onRename"
            >
              {{ task.title }}
            </div>
            <span v-if="syncing" class="sync-spinner" aria-hidden="true"></span>
          </div>
          <span v-if="task.type === 'scheduled' && task.dueAt" class="time">{{ dueLabel }}</span>
        </div>
        <div class="meta">
          <span class="tag">{{ task.type === 'scheduled' ? 'one-off' : 'daily' }}</span>
          <span v-if="upcoming" class="tag">upcoming</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatDateTime } from '../lib/core';
import { isCompletedForDay } from '../lib/todayModel';
import type { Task } from '../lib/types';

const props = defineProps<{ task: Task; dayKey: string; upcoming?: boolean; syncing?: boolean; dragging?: boolean }>();

const emit = defineEmits<{
  toggle: [string, boolean];
  archive: [string];
  activate: [string];
  deactivate: [string];
  rename: [string, string];
}>();

const completed = computed(() => isCompletedForDay(props.task, props.dayKey));
const dueLabel = computed(() => (props.task.dueAt ? formatDateTime(props.task.dueAt) : ''));

const startX = ref(0);
const offsetX = ref(0);
const swiped = ref(false);
const hoverActive = ref(false);
const showActions = computed(() => swiped.value || offsetX.value < -10);
const maxSwipe = -140;

const onToggle = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const checked = target.checked;
  emit('toggle', props.task.id, checked);
};

const onToggleActive = () => {
  if (props.task.active) emit('deactivate', props.task.id);
  else emit('activate', props.task.id);
  resetSwipe();
};

const onRename = () => {
  const current = props.task.title || '';
  const next = window.prompt('Rename task:', current);
  if (next == null) return;
  emit('rename', props.task.id, next);
};

const onArchive = () => {
  emit('archive', props.task.id);
  resetSwipe();
};

const onTouchStart = (event: TouchEvent) => {
  startX.value = event.touches[0]?.clientX ?? 0;
};

const onTouchMove = (event: TouchEvent) => {
  const currentX = event.touches[0]?.clientX ?? startX.value;
  const delta = currentX - startX.value;
  if (delta < 0) {
    offsetX.value = Math.max(delta, maxSwipe);
  } else if (!swiped.value) {
    offsetX.value = 0;
  }
};

const onTouchEnd = () => {
  if (offsetX.value < -60) {
    swiped.value = true;
    offsetX.value = maxSwipe;
  } else {
    resetSwipe();
  }
};

const onMouseMove = (event: MouseEvent) => {
  if (props.dragging) return;
  if (swiped.value) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const triggerX = rect.right - rect.width * 0.3;
  if (event.clientX >= triggerX) {
    hoverActive.value = true;
    offsetX.value = maxSwipe;
  } else if (hoverActive.value) {
    hoverActive.value = false;
    offsetX.value = 0;
  }
};

const onMouseLeave = () => {
  if (props.dragging) return;
  if (swiped.value) return;
  hoverActive.value = false;
  offsetX.value = 0;
};

const resetSwipe = () => {
  swiped.value = false;
  hoverActive.value = false;
  offsetX.value = 0;
};

const onClickTask = () => {
  if (swiped.value) resetSwipe();
};
</script>
