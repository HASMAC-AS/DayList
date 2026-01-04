<template>
  <div class="wrap">

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
  <button
    class="fab fab-left"
    type="button"
    :aria-label="view === 'main' ? 'Open settings' : 'Back'"
    @click="handleBack"
  >
    <svg v-if="view === 'main'" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm8.94 3.06-.86-.5.1-1.1a1 1 0 0 0-.6-1l-1.1-.5-.3-1.05a1 1 0 0 0-.8-.7l-1.17-.15-.62-.9a1 1 0 0 0-1.05-.38l-1.13.35-.9-.65a1 1 0 0 0-1.1 0l-.9.65-1.13-.35a1 1 0 0 0-1.05.38l-.62.9-1.17.15a1 1 0 0 0-.8.7l-.3 1.05-1.1.5a1 1 0 0 0-.6 1l.1 1.1-.86.5a1 1 0 0 0-.46 1.16l.38 1.1-.7.86a1 1 0 0 0-.02 1.17l.7.9-.38 1.1a1 1 0 0 0 .46 1.16l.86.5-.1 1.1a1 1 0 0 0 .6 1l1.1.5.3 1.05a1 1 0 0 0 .8.7l1.17.15.62.9a1 1 0 0 0 1.05.38l1.13-.35.9.65a1 1 0 0 0 1.1 0l.9-.65 1.13.35a1 1 0 0 0 1.05-.38l.62-.9 1.17-.15a1 1 0 0 0 .8-.7l.3-1.05 1.1-.5a1 1 0 0 0 .6-1l-.1-1.1.86-.5a1 1 0 0 0 .46-1.16l-.38-1.1.7-.9a1 1 0 0 0 .02-1.17l-.7-.86.38-1.1a1 1 0 0 0-.46-1.16Z"
      />
    </svg>
    <span v-else>&larr;</span>
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
  if (view.value === 'main') {
    view.value = 'settings';
  } else if (view.value === 'diagnostics') {
    view.value = 'settings';
  } else {
    view.value = 'main';
  }
};
</script>
