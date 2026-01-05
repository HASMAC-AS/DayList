<template>
  <header>
    <div class="brand">
      <div class="logo" aria-hidden="true">OK</div>
      <div>
        <h1>DayList</h1>
      </div>
    </div>

    <div class="header-actions">
      <div v-if="lists.length" class="list-picker">
        <span class="list-dot" :style="{ background: activeColor }" aria-hidden="true"></span>
        <select :value="activeListId" aria-label="Active list" @change="onSelect">
          <option v-for="list in lists" :key="list.id" :value="list.id">
            {{ list.name }}
          </option>
        </select>
      </div>
      <button v-if="view !== 'main'" class="back-btn" type="button" @click="$emit('back')">Back</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TaskList } from '../lib/types';
import { DEFAULT_LIST_COLOR } from '../lib/lists';

const props = defineProps<{
  view: 'main' | 'settings' | 'diagnostics';
  lists: TaskList[];
  activeListId: string;
}>();
const emit = defineEmits<{ back: []; selectList: [string] }>();

const activeColor = computed(() => {
  const list = props.lists.find((item) => item.id === props.activeListId);
  return list?.color || DEFAULT_LIST_COLOR;
});

const onSelect = (event: Event) => {
  const target = event.target as HTMLSelectElement | null;
  if (!target) return;
  emit('selectList', target.value);
};
</script>
