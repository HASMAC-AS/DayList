<template>
  <div>
    <div class="row">
      <div class="grow">
        <input
          id="titleInput"
          v-model="title"
          type="text"
          placeholder="e.g., Drink water / Meds / Stretch / Call dentist..."
          autocomplete="off"
          @keydown.enter.prevent="handleAdd"
        />
      </div>
      <button id="addBtn" style="min-width: 120px" @click="handleAdd">Add</button>
    </div>

    <div class="typeRow">
      <label class="radio">
        <input id="typeDaily" v-model="type" type="radio" name="t" value="daily" />
        Daily
      </label>
      <label class="radio">
        <input id="typeScheduled" v-model="type" type="radio" name="t" value="scheduled" />
        Scheduled
      </label>
      <div class="grow" style="min-width: 220px">
        <div class="hint">Due time (only for scheduled tasks)</div>
        <input
          id="dueInput"
          v-model="dueInput"
          type="datetime-local"
          :disabled="type !== 'scheduled'"
          :style="{ opacity: type === 'scheduled' ? '1' : '0.55' }"
        />
      </div>
    </div>

    <SuggestionsList :items="suggestions" @pick="applySuggestion" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import SuggestionsList from './SuggestionsList.vue';
import type { TaskType, TemplateStat } from '../lib/types';
import { useDaylistStore } from '../stores/daylist';

const store = useDaylistStore();

const title = ref('');
const type = ref<TaskType>('daily');
const dueInput = ref('');

const suggestions = computed(() => store.buildSuggestions(title.value.trim()));

const ensureDefaultDue = () => {
  if (type.value !== 'scheduled') return;
  if (dueInput.value) return;
  const next = store.buildDefaultDue();
  dueInput.value = store.formatDueInput(next);
};

const handleAdd = () => {
  const dueAt = store.parseDueInput(dueInput.value);
  store.addTask({
    title: title.value,
    type: type.value,
    dueAt
  });

  title.value = '';
  if (type.value === 'scheduled') {
    ensureDefaultDue();
  }

  requestAnimationFrame(() => {
    const input = document.getElementById('titleInput') as HTMLInputElement | null;
    input?.focus();
  });
};

const applySuggestion = (item: TemplateStat) => {
  title.value = item.title;
  type.value = item.lastType;
  ensureDefaultDue();
  requestAnimationFrame(() => {
    const input = document.getElementById('titleInput') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.setSelectionRange(0, input.value.length);
    }
  });
};

watch(type, () => {
  ensureDefaultDue();
});

onMounted(() => {
  ensureDefaultDue();
});
</script>
