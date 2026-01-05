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
          :style="dropdownStyle"
          @update:model-value="onSelect"
        >
          <template #singlelabel="{ value }">
            <span class="list-label">
              <span class="list-label-text">{{ value?.label || 'List' }}</span>
            </span>
          </template>
          <template #option="{ option }">
            <span class="list-option">
              <span class="list-label-text">{{ option.label }}</span>
            </span>
          </template>
        </Multiselect>
        <span ref="measureRef" class="list-measure">{{ selectedLabel }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Multiselect from '@vueform/multiselect';
import type { TaskList } from '../lib/types';
import { DEFAULT_LIST_COLOR } from '../lib/lists';

const props = defineProps<{
  lists: TaskList[];
  activeListId: string;
}>();
const emit = defineEmits<{ selectList: [string] }>();
const measureRef = ref<HTMLElement | null>(null);
const dropdownWidth = ref<number | null>(null);

const options = computed(() =>
  props.lists.map((list) => ({
    value: list.id,
    label: list.name,
    color: list.color || DEFAULT_LIST_COLOR
  }))
);

const selectedLabel = computed(() => {
  const current = props.lists.find((list) => list.id === props.activeListId) || props.lists[0];
  return current?.name || 'List';
});

const updateWidth = () => {
  const labelWidth = measureRef.value?.getBoundingClientRect().width || 0;
  const extra = 56;
  const minWidth = 120;
  const maxWidth = typeof window === 'undefined' ? labelWidth + extra : window.innerWidth - 48;
  dropdownWidth.value = Math.min(maxWidth, Math.max(minWidth, Math.ceil(labelWidth + extra)));
};

const dropdownStyle = computed(() => {
  if (!dropdownWidth.value) return undefined;
  return { width: `${dropdownWidth.value}px` };
});

onMounted(() => {
  updateWidth();
  window.addEventListener('resize', updateWidth);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateWidth);
});

watch(selectedLabel, async () => {
  await nextTick();
  updateWidth();
});

const onSelect = (value: string | { value: string } | null) => {
  if (!value) return;
  emit('selectList', typeof value === 'string' ? value : value.value);
};
</script>
