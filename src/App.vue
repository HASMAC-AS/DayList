<template>
  <div class="wrap">
    <AppHeader
      :view="view"
      @open-settings="view = 'settings'"
      @back="handleBack"
    />

    <transition name="view-fade" mode="out-in">
      <div v-if="view === 'main'" key="main" class="main-view">
        <TaskListMain />
      </div>
      <div v-else-if="view === 'settings'" key="settings" class="settings-view">
        <SettingsView @open-diagnostics="view = 'diagnostics'" />
      </div>
      <div v-else key="diagnostics" class="settings-view">
        <DiagnosticsView />
      </div>
    </transition>

    <div v-if="view !== 'main'" class="footer">
      Offline-first PWA: once loaded at least once, it keeps working without internet. Install from your browser menu.
    </div>
  </div>

  <button v-if="view === 'main'" class="fab" type="button" aria-label="Add task" @click="openComposer">
    +
  </button>

  <transition name="composer">
    <div v-if="composerOpen" class="composer-overlay" @click.self="closeComposer">
      <div class="composer-panel">
        <div class="composer-head">
          <div>
            <div class="composer-title">Add a task</div>
            <div class="hint">Daily tasks reset at 03:00 local time.</div>
          </div>
          <button class="icon-btn" type="button" aria-label="Close" @click="closeComposer">X</button>
        </div>
        <TaskComposer @close="closeComposer" @added="closeComposer" />
      </div>
    </div>
  </transition>

  <ToastHost />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppHeader from './components/AppHeader.vue';
import TaskComposer from './components/TaskComposer.vue';
import TaskListMain from './components/TaskListMain.vue';
import SettingsView from './components/SettingsView.vue';
import DiagnosticsView from './components/DiagnosticsView.vue';
import ToastHost from './components/ToastHost.vue';
import { useDaylistStore } from './stores/daylist';

const store = useDaylistStore();
const view = ref<'main' | 'settings' | 'diagnostics'>('main');
const composerOpen = ref(false);

onMounted(() => {
  store.initApp();
});

const openComposer = () => {
  composerOpen.value = true;
  requestAnimationFrame(() => {
    const input = document.getElementById('titleInput') as HTMLInputElement | null;
    input?.focus();
  });
};

const closeComposer = () => {
  composerOpen.value = false;
};

const handleBack = () => {
  if (view.value === 'diagnostics') view.value = 'settings';
  else view.value = 'main';
};
</script>
