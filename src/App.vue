<template>
  <div class="wrap">
    <AppHeader
      :view="view"
      :lists="store.lists"
      :active-list-id="store.activeListId"
      @back="handleBack"
      @select-list="store.setActiveList"
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

    </div>
  </div>

  <button v-if="view === 'main'" class="fab fab-left" type="button" aria-label="Open settings" @click="view = 'settings'">
    <svg viewBox="0 0 24 24" class="fab-icon" aria-hidden="true">
      <circle cx="12" cy="12" r="3"></circle>
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .65.39 1.24 1 1.51.3.13.64.19.99.19H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
      ></path>
    </svg>
  </button>

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
import { onMounted, ref, watch } from 'vue';
import TaskComposer from './components/TaskComposer.vue';
import TaskListMain from './components/TaskListMain.vue';
import SettingsView from './components/SettingsView.vue';
import DiagnosticsView from './components/DiagnosticsView.vue';
import ToastHost from './components/ToastHost.vue';
import AppHeader from './components/AppHeader.vue';
import { useDaylistStore } from './stores/daylist';

const store = useDaylistStore();
const view = ref<'main' | 'settings' | 'diagnostics'>('main');
const composerOpen = ref(false);

onMounted(() => {
  store.initApp();
});

watch(composerOpen, (open) => {
  const body = document.body;
  if (!body) return;
  if (open) {
    const scrollY = window.scrollY || 0;
    body.dataset.scrollY = String(scrollY);
    body.classList.add('modal-open');
    body.style.top = `-${scrollY}px`;
  } else {
    const y = Number(body.dataset.scrollY || '0');
    body.classList.remove('modal-open');
    body.style.top = '';
    window.scrollTo(0, y);
  }
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
