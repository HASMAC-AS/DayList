<template>
  <div class="wrap">
    <AppHeader
      :lists="store.lists"
      :active-list-id="store.activeListId"
      @select-list="store.setActiveList"
    />

  <transition name="view-fade" mode="out-in" @before-enter="applyPendingScroll">
      <div v-if="view === 'main'" key="main" class="main-view">
        <TaskListMain />
      </div>
      <div v-else-if="view === 'settings'" key="settings" class="settings-view">
        <SettingsView @open-diagnostics="navigateTo('diagnostics')" />
      </div>
      <div v-else key="diagnostics" class="settings-view">
        <DiagnosticsView />
      </div>
    </transition>

    <div v-if="view !== 'main'" class="footer">

    </div>
  </div>

  <button
    v-if="view === 'main'"
    class="fab fab-left"
    type="button"
    aria-label="Open settings"
    @click="navigateTo('settings')"
  >
    <Settings2 class="fab-icon" aria-hidden="true" />
  </button>

  <button
    v-else
    class="fab fab-left fab-back"
    type="button"
    aria-label="Back"
    @click="handleBack"
  >
    <ArrowLeft class="fab-icon" aria-hidden="true" />
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

  <div v-if="!syncReady && showSyncIndicator" class="sync-indicator" role="status" aria-live="polite">
    <span class="sync-spinner" aria-hidden="true"></span>
    connecting
  </div>

  <ToastHost />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowLeft, Settings2 } from 'lucide-vue-next';
import TaskComposer from './components/TaskComposer.vue';
import TaskListMain from './components/TaskListMain.vue';
import SettingsView from './components/SettingsView.vue';
import DiagnosticsView from './components/DiagnosticsView.vue';
import ToastHost from './components/ToastHost.vue';
import AppHeader from './components/AppHeader.vue';
import { useDaylistStore } from './stores/daylist';
import { DEFAULT_LIST_COLOR } from './lib/lists';

const store = useDaylistStore();
const view = ref<'main' | 'settings' | 'diagnostics'>('main');
const composerOpen = ref(false);
const syncReady = computed(() => store.syncReady);
const listColor = computed(() => store.activeList?.color || DEFAULT_LIST_COLOR);
const pendingScrollY = ref<number | null>(null);
let scrollTicking = false;
let lastHistoryUpdate = 0;
let historyUpdateTimer: number | null = null;
let lastRecordedScrollY: number | null = null;
const showSyncIndicator = ref(false);
let syncDelayTimer: number | null = null;
let syncInteractionListening = false;
const syncInteractionOptions: AddEventListenerOptions = { capture: true };
const HISTORY_SCROLL_THROTTLE_MS = 250;

const BASE_ACCENT_LIGHT = '#1f4b99';
const BASE_ACCENT_DARK = '#6ea8ff';

const getScrollY = () => window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;

const ensureHistoryState = (next: 'main' | 'settings' | 'diagnostics', replace = false, scrollY = 0) => {
  const state = { ...(history.state || {}), view: next, scrollY };
  if (replace) history.replaceState(state, '', window.location.href);
  else history.pushState(state, '', window.location.href);
  lastRecordedScrollY = scrollY;
};

const updateHistoryScroll = () => {
  if (!history.state) return;
  const scrollY = getScrollY();
  if (lastRecordedScrollY === scrollY) return;
  lastRecordedScrollY = scrollY;
  history.replaceState({ ...history.state, scrollY }, '', window.location.href);
};

const scheduleHistoryScroll = () => {
  const now = Date.now();
  const elapsed = now - lastHistoryUpdate;
  if (elapsed >= HISTORY_SCROLL_THROTTLE_MS) {
    if (historyUpdateTimer !== null) {
      window.clearTimeout(historyUpdateTimer);
      historyUpdateTimer = null;
    }
    lastHistoryUpdate = now;
    updateHistoryScroll();
    return;
  }
  if (historyUpdateTimer !== null) return;
  historyUpdateTimer = window.setTimeout(() => {
    historyUpdateTimer = null;
    lastHistoryUpdate = Date.now();
    updateHistoryScroll();
  }, HISTORY_SCROLL_THROTTLE_MS - elapsed);
};

const queueScrollRestore = (scrollY: number) => {
  pendingScrollY.value = scrollY;
};

const applyPendingScroll = () => {
  if (pendingScrollY.value == null) return;
  const target = pendingScrollY.value;
  pendingScrollY.value = null;
  window.scrollTo(0, target);
};

const handleScroll = () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    scheduleHistoryScroll();
  });
};

const clearSyncDelay = () => {
  if (syncDelayTimer !== null) {
    window.clearTimeout(syncDelayTimer);
    syncDelayTimer = null;
  }
};

const handleSyncInteraction = () => {
  if (syncReady.value) return;
  showSyncIndicator.value = true;
  if (syncInteractionListening) {
    document.removeEventListener('pointerdown', handleSyncInteraction, syncInteractionOptions);
    syncInteractionListening = false;
  }
};

const startSyncWait = () => {
  showSyncIndicator.value = false;
  clearSyncDelay();
  syncDelayTimer = window.setTimeout(() => {
    if (!syncReady.value) {
      showSyncIndicator.value = true;
    }
  }, 5000);
  if (!syncInteractionListening) {
    document.addEventListener('pointerdown', handleSyncInteraction, syncInteractionOptions);
    syncInteractionListening = true;
  }
};

const stopSyncWait = () => {
  clearSyncDelay();
  showSyncIndicator.value = false;
  if (syncInteractionListening) {
    document.removeEventListener('pointerdown', handleSyncInteraction, syncInteractionOptions);
    syncInteractionListening = false;
  }
};

const setView = (next: 'main' | 'settings' | 'diagnostics', fromPop = false, scrollY = 0) => {
  if (view.value === next) return;
  if (fromPop) {
    queueScrollRestore(scrollY);
  } else {
    updateHistoryScroll();
    queueScrollRestore(0);
  }
  view.value = next;
  if (!fromPop) ensureHistoryState(next, false, 0);
};

const navigateTo = (next: 'main' | 'settings' | 'diagnostics') => {
  setView(next, false);
};

onMounted(() => {
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }
  const initial = (history.state && history.state.view) || 'main';
  view.value = initial;
  ensureHistoryState(initial, true, getScrollY());
  window.addEventListener('popstate', (event) => {
    const next = (event.state && event.state.view) || 'main';
    const scrollY = typeof event.state?.scrollY === 'number' ? event.state.scrollY : 0;
    setView(next, true, scrollY);
  });
  window.addEventListener('scroll', handleScroll, { passive: true });
  store.initApp();
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
  if (historyUpdateTimer !== null) {
    window.clearTimeout(historyUpdateTimer);
    historyUpdateTimer = null;
  }
  stopSyncWait();
});

watch(syncReady, (ready) => {
  if (ready) stopSyncWait();
  else startSyncWait();
}, { immediate: true });

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const hexToRgb = (hex: string) => {
  const cleaned = hex.replace('#', '').trim();
  if (!cleaned) return null;
  if (cleaned.length === 3) {
    const r = Number.parseInt(`${cleaned[0]}${cleaned[0]}`, 16);
    const g = Number.parseInt(`${cleaned[1]}${cleaned[1]}`, 16);
    const b = Number.parseInt(`${cleaned[2]}${cleaned[2]}`, 16);
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    const r = Number.parseInt(cleaned.slice(0, 2), 16);
    const g = Number.parseInt(cleaned.slice(2, 4), 16);
    const b = Number.parseInt(cleaned.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
};

const rgbToHex = (rgb: { r: number; g: number; b: number }) => {
  const toHex = (value: number) => clamp(value).toString(16).padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
};

const mix = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, amount: number) => ({
  r: clamp(a.r + (b.r - a.r) * amount),
  g: clamp(a.g + (b.g - a.g) * amount),
  b: clamp(a.b + (b.b - a.b) * amount)
});

const luminance = (rgb: { r: number; g: number; b: number }) => {
  const toLinear = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
};

const ensureAccentForLight = (rgb: { r: number; g: number; b: number }) => {
  const luma = luminance(rgb);
  if (luma > 0.62) return mix(rgb, { r: 0, g: 0, b: 0 }, 0.25);
  if (luma < 0.22) return mix(rgb, { r: 255, g: 255, b: 255 }, 0.12);
  return rgb;
};

const ensureAccentForDark = (rgb: { r: number; g: number; b: number }) => {
  const luma = luminance(rgb);
  if (luma < 0.5) return mix(rgb, { r: 255, g: 255, b: 255 }, 0.35);
  return rgb;
};

const applyListTheme = (hex: string) => {
  const listRgb = hexToRgb(hex) || hexToRgb(DEFAULT_LIST_COLOR);
  const baseLight = hexToRgb(BASE_ACCENT_LIGHT);
  const baseDark = hexToRgb(BASE_ACCENT_DARK);
  if (!listRgb || !baseLight || !baseDark) return;

  const accentLight = ensureAccentForLight(mix(baseLight, listRgb, 0.55));
  const accentLight2 = mix(accentLight, { r: 255, g: 255, b: 255 }, 0.2);
  const accentDark = ensureAccentForDark(mix(baseDark, listRgb, 0.5));
  const accentDark2 = mix(accentDark, { r: 255, g: 255, b: 255 }, 0.25);

  const root = document.documentElement;
  root.style.setProperty('--list-color', rgbToHex(listRgb));
  root.style.setProperty('--list-tint-light', `rgba(${listRgb.r}, ${listRgb.g}, ${listRgb.b}, 0.12)`);
  root.style.setProperty('--list-tint-light-2', `rgba(${listRgb.r}, ${listRgb.g}, ${listRgb.b}, 0.18)`);
  root.style.setProperty('--list-tint-strong', `rgba(${listRgb.r}, ${listRgb.g}, ${listRgb.b}, 0.24)`);
  root.style.setProperty('--list-tint-dark', `rgba(${listRgb.r}, ${listRgb.g}, ${listRgb.b}, 0.22)`);
  root.style.setProperty('--list-tint-dark-2', `rgba(${listRgb.r}, ${listRgb.g}, ${listRgb.b}, 0.28)`);
  root.style.setProperty('--list-tint-strong-dark', `rgba(${listRgb.r}, ${listRgb.g}, ${listRgb.b}, 0.32)`);
  root.style.setProperty('--accent-light', rgbToHex(accentLight));
  root.style.setProperty('--accent-2-light', rgbToHex(accentLight2));
  root.style.setProperty('--accent-dark', rgbToHex(accentDark));
  root.style.setProperty('--accent-2-dark', rgbToHex(accentDark2));
  root.style.setProperty(
    '--focus-ring-light',
    `rgba(${accentLight.r}, ${accentLight.g}, ${accentLight.b}, 0.18)`
  );
  root.style.setProperty(
    '--focus-ring-dark',
    `rgba(${accentDark.r}, ${accentDark.g}, ${accentDark.b}, 0.24)`
  );
};

watch(listColor, (color) => {
  applyListTheme(color);
}, { immediate: true });

let stopComposerViewport: (() => void) | null = null;

const startComposerViewportTracking = () => {
  const root = document.documentElement;
  const update = () => {
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const offsetTop = vv?.offsetTop ?? 0;
    root.style.setProperty('--composer-vh', `${height}px`);
    root.style.setProperty('--composer-offset-top', `${offsetTop}px`);
  };
  update();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('orientationchange', update);
  return () => {
    if (vv) {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    }
    window.removeEventListener('orientationchange', update);
    root.style.removeProperty('--composer-vh');
    root.style.removeProperty('--composer-offset-top');
  };
};

watch(composerOpen, (open) => {
  const body = document.body;
  if (!body) return;
  if (open) {
    const scrollY = window.scrollY || 0;
    body.dataset.scrollY = String(scrollY);
    body.classList.add('modal-open');
    body.style.top = `-${scrollY}px`;
    stopComposerViewport?.();
    stopComposerViewport = startComposerViewportTracking();
  } else {
    const y = Number(body.dataset.scrollY || '0');
    body.classList.remove('modal-open');
    body.style.top = '';
    window.scrollTo(0, y);
    stopComposerViewport?.();
    stopComposerViewport = null;
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
  if (view.value === 'main') return;
  if (history.state && history.state.view) {
    history.back();
    return;
  }
  setView(view.value === 'diagnostics' ? 'settings' : 'main');
};
</script>
