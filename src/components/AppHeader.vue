<template>
  <header>
    <div class="header-actions">
      <div v-if="lists.length" class="list-picker">
        <Multiselect
          :model-value="activeListId"
          :options="options"
          :searchable="false"
          :can-clear="false"
          value-prop="value"
          label="label"
          track-by="value"
          aria-label="Active list"
          @update:model-value="onSelect"
        >
          <template #singlelabel="{ value }">
            <span class="list-label">
              <span class="list-dot" :style="{ background: value?.color || DEFAULT_LIST_COLOR }" aria-hidden="true"></span>
              <span class="list-label-text">{{ value?.label || 'List' }}</span>
            </span>
          </template>
          <template #option="{ option }">
            <span class="list-option">
              <span class="list-dot" :style="{ background: option.color }" aria-hidden="true"></span>
              <span class="list-label-text">{{ option.label }}</span>
            </span>
          </template>
        </Multiselect>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Multiselect from '@vueform/multiselect';
import type { TaskList } from '../lib/types';
import { DEFAULT_LIST_COLOR } from '../lib/lists';

const props = defineProps<{
  lists: TaskList[];
  activeListId: string;
}>();
const emit = defineEmits<{ selectList: [string] }>();

const options = computed(() =>
  props.lists.map((list) => ({
    value: list.id,
    label: list.name,
    color: list.color || DEFAULT_LIST_COLOR
  }))
);

const onSelect = (value: string | { value: string } | null) => {
  if (!value) return;
  emit('selectList', typeof value === 'string' ? value : value.value);
};
</script>
