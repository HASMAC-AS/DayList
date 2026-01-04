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
      ~
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
      <circle cx="12" cy="12" r="3.25" />
      <path
        d="M19.2 15a2 2 0 0 0 .4 2.1l.15.15a2.4 2.4 0 0 1-3.4 3.4l-.15-.15a2 2 0 0 0-2.1-.4 2 2 0 0 0-1.2 1.9V22a2.4 2.4 0 0 1-4.8 0v-.2a2 2 0 0 0-1.2-1.9 2 2 0 0 0-2.1.4l-.15.15a2.4 2.4 0 0 1-3.4-3.4l.15-.15a2 2 0 0 0 .4-2.1 2 2 0 0 0-1.9-1.2H2a2.4 2.4 0 0 1 0-4.8h.2a2 2 0 0 0 1.9-1.2 2 2 0 0 0-.4-2.1l-.15-.15a2.4 2.4 0 0 1 3.4-3.4l.15.15a2 2 0 0 0 2.1.4 2 2 0 0 0 1.2-1.9V2a2.4 2.4 0 0 1 4.8 0v.2a2 2 0 0 0 1.2 1.9 2 2 0 0 0 2.1-.4l.15-.15a2.4 2.4 0 0 1 3.4 3.4l-.15.15a2 2 0 0 0-.4 2.1 2 2 0 0 0 1.9 1.2H22a2.4 2.4 0 0 1 0 4.8h-.2a2 2 0 0 0-1.9 1.2Z"
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
