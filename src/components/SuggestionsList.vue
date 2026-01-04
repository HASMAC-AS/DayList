<template>
  <div id="suggestions">
    <div
      v-for="item in items"
      :key="item.key"
      class="sugg"
      :data-skey="item.key"
      title="Click to use"
      @click="$emit('pick', item)"
    >
      <div class="sugg-title">{{ item.title }}</div>
      <div class="sugg-meta">
        {{ item.lastType }} {{ item.usageLabel }} {{ item.lastLabel }} {{ item.timeLabel }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TemplateStat } from '../lib/types';

defineProps<{ items: Array<TemplateStat & { usageLabel: string; lastLabel: string; timeLabel: string }> }>();

defineEmits<{ pick: [TemplateStat] }>();
</script>
