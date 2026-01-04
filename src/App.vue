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
    <Settings v-if="view === 'main'" class="fab-icon" aria-hidden="true" />
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
import { onMounted, ref, watch } from 'vue';
import { Settings } from 'lucide-vue-next';
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
