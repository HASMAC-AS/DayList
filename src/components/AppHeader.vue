<template>
  <header>
    <div class="brand">
      <div class="logo" aria-hidden="true">OK</div>
      <div>
        <h1>DayList</h1>
        <div class="sub" id="dayLabel">{{ store.dayLabel }}</div>
      </div>
    </div>

    <SyncPill />
  </header>
</template>

<script setup lang="ts">
import SyncPill from './SyncPill.vue';
import { useDaylistStore } from '../stores/daylist';

const store = useDaylistStore();
</script>
