<template>
  <div ref="rootRef">
    <div class="row">
      <div class="grow">
        <input
          id="titleInput"
          ref="inputRef"
          v-model="title"
          type="text"
          placeholder="e.g., Drink water / Meds / Stretch / Call dentist..."
          autocomplete="off"
          @focus="ensureInputVisible"
          @keydown.enter.prevent="handleAdd"
        />
      </div>
    </div>

    <div class="row">
      <div class="col grow">
        <div class="hint">List</div>
        <div class="list-picker">
          <span class="list-dot" :style="{ background: selectedColor }" aria-hidden="true"></span>
          <select v-model="listId" aria-label="Task list">
            <option v-for="list in store.lists" :key="list.id" :value="list.id">
              {{ list.name }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <div class="typeRow">
      <label class="radio">
        <input id="typeDaily" v-model="type" type="radio" name="t" value="daily" />
        Daily
      </label>
      <label class="radio">
        <input id="typeScheduled" v-model="type" type="radio" name="t" value="scheduled" />
        One-off
      </label>
      <div class="grow" style="min-width: 220px">
        <div class="hint">Due time (optional)</div>
        <input
          id="dueInput"
          v-model="dueInput"
          type="datetime-local"
          :disabled="type !== 'scheduled'"
          :style="{ opacity: type === 'scheduled' ? '1' : '0.55' }"
          @focus="ensureInputVisible"
        />
      </div>
    </div>

    <SuggestionsList :items="suggestions" @pick="applySuggestion" />

    <div class="composer-actions">
      <button type="button" class="chip ghost" @click="$emit('close')">Cancel</button>
      <button id="addBtn" type="button" class="chip primary" @click="handleAdd">Add task</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import SuggestionsList from './SuggestionsList.vue';
import type { TaskType, TemplateStat } from '../lib/types';
import { DEFAULT_LIST_COLOR } from '../lib/lists';
import { useDaylistStore } from '../stores/daylist';

const emit = defineEmits<{ close: []; added: [] }>();

const store = useDaylistStore();

const title = ref('');
const type = ref<TaskType>('scheduled');
const dueInput = ref('');
const listId = ref(store.activeListId || '');
const rootRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

const selectedColor = computed(() => {
  const list = store.lists.find((item) => item.id === listId.value);
  return list?.color || DEFAULT_LIST_COLOR;
});

const suggestions = computed(() => store.buildSuggestions(title.value.trim(), { listId: listId.value }));

const ensureInputVisible = () => {
  const input = inputRef.value;
  if (!input) return;
  const panel = rootRef.value?.closest('.composer-panel') as HTMLElement | null;
  requestAnimationFrame(() => {
    try {
      if (panel) panel.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (document.activeElement === input) {
        input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    } catch {
      // ignore
    }
  });
};

const ensureDefaultDue = () => {
  if (type.value !== 'scheduled') return;
  if (dueInput.value) return;
};

const handleAdd = () => {
  const dueAt = store.parseDueInput(dueInput.value);
  store.addTask({
    title: title.value,
    type: type.value,
    dueAt,
    listId: listId.value
  });

  title.value = '';
  if (type.value === 'scheduled') {
    ensureDefaultDue();
  }

  requestAnimationFrame(() => {
    const input = document.getElementById('titleInput') as HTMLInputElement | null;
    input?.focus();
  });

  emit('added');
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

watch(
  () => suggestions.value.length,
  async () => {
    await nextTick();
    ensureInputVisible();
  }
);

onMounted(() => {
  ensureDefaultDue();
});

watch(
  () => store.activeListId,
  (id) => {
    if (!listId.value || !store.lists.find((list) => list.id === listId.value)) {
      listId.value = id || '';
    }
  }
);
</script>
