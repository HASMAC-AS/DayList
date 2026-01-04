<template>
  <div class="task" :data-id="task.id">
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
        <div
          class="title"
          :class="{ done: completed }"
          title="Double-click to rename"
          @dblclick="onRename"
        >
          {{ task.title }}
        </div>
        <span v-if="task.type === 'scheduled' && task.dueAt" class="time">{{ dueLabel }}</span>
      </div>
      <div class="meta">
        <span class="tag">{{ task.type === 'scheduled' ? 'scheduled' : 'daily' }}</span>
        <span v-if="upcoming" class="tag">upcoming</span>
      </div>
    </div>
    <div class="actions">
      <button
        v-if="task.type === 'daily'"
        class="chip act"
        :data-act="task.active ? 'deactivate' : 'activate'"
        @click="onToggleActive"
      >
        {{ task.active ? 'Hide' : 'Show' }}
      </button>
      <button class="chip" data-act="archive" @click="$emit('archive', task.id)">Archive</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatDateTime } from '../lib/core';
import { isCompletedForDay } from '../lib/todayModel';
import type { Task } from '../lib/types';

const props = defineProps<{ task: Task; dayKey: string; upcoming?: boolean }>();

const emit = defineEmits<{
  toggle: [string, boolean];
  archive: [string];
  activate: [string];
  deactivate: [string];
  rename: [string, string];
}>();

const completed = computed(() => isCompletedForDay(props.task, props.dayKey));
const dueLabel = computed(() => (props.task.dueAt ? formatDateTime(props.task.dueAt) : ''));

const onToggle = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const checked = target.checked;
  emit('toggle', props.task.id, checked);
};

const onToggleActive = () => {
  if (props.task.active) emit('deactivate', props.task.id);
  else emit('activate', props.task.id);
};

const onRename = () => {
  const current = props.task.title || '';
  const next = window.prompt('Rename task:', current);
  if (next == null) return;
  emit('rename', props.task.id, next);
};
</script>
