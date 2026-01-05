<template>
  <div class="settings-stack">
    <section class="settings-block">
      <div class="section-title">Upcoming</div>
      <div id="upcomingList">
        <div v-if="sections.scheduledUpcoming.length === 0" class="empty">Nothing scheduled.</div>
        <TaskRow
          v-for="task in sections.scheduledUpcoming"
          :key="task.id"
          :task="task"
          :day-key="sections.dayKey"
          :syncing="store.isTaskSyncing(task.id)"
          upcoming
          @toggle="store.toggleCompletion"
          @archive="store.archiveTask"
          @activate="(id) => store.setTaskActive(id, true)"
          @deactivate="(id) => store.setTaskActive(id, false)"
          @rename="store.renameTask"
        />
      </div>
    </section>

    <section class="settings-block">
      <details>
        <summary>History</summary>
        <div class="bd">
          <HistoryPanel />
        </div>
      </details>
    </section>

    <section class="settings-block">
      <details>
        <summary>Lists</summary>
        <div class="bd list-manager">
          <div class="row list-create">
            <div class="col grow">
              <div class="hint">List name</div>
              <input v-model="newListName" type="text" placeholder="e.g., Personal" />
            </div>
            <div class="col">
              <div class="hint">Color</div>
              <input v-model="newListColor" type="color" aria-label="List color" />
            </div>
            <div class="col">
              <div class="hint">&nbsp;</div>
              <button class="chip primary" type="button" :disabled="!newListName.trim()" @click="addList">
                Create
              </button>
            </div>
          </div>

          <div v-if="store.lists.length === 0" class="empty">No lists yet.</div>
          <div v-else class="list-items">
            <div v-for="list in store.lists" :key="list.id" class="row list-row">
              <span class="list-dot" :style="{ background: list.color }" aria-hidden="true"></span>
              <input
                class="grow"
                type="text"
                :value="list.name"
                :placeholder="list.id"
                @change="(event) => handleListNameChange(list, event)"
              />
              <input
                type="color"
                :value="list.color"
                aria-label="List color"
                @input="(event) => store.setListColor(list.id, (event.target as HTMLInputElement).value)"
              />
              <span v-if="list.id === store.activeListId" class="pill">Active</span>
            </div>
          </div>
        </div>
      </details>
    </section>

    <section class="settings-block">
      <SyncBackupPanel />
    </section>

    <section class="settings-block settings-actions-bottom">
      <button class="chip ghost" type="button" :disabled="reloading" @click="reloadApp">Reload</button>
      <button class="chip primary" type="button" @click="$emit('openDiagnostics')">Diagnostics</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { buildTodaySections } from '../lib/todayModel';
import { DEFAULT_LIST_COLOR } from '../lib/lists';
import { useDaylistStore } from '../stores/daylist';
import { persistKeysToStorage, writeKeysToUrl } from '../services/sync/keys';
import TaskRow from './TaskRow.vue';
import HistoryPanel from './HistoryPanel.vue';
import SyncBackupPanel from './SyncBackupPanel.vue';

defineEmits<{ openDiagnostics: [] }>();

const store = useDaylistStore();
const sections = computed(() => buildTodaySections(store.tasksForActiveList, store.nowTs));
const reloading = ref(false);
const newListName = ref('');
const newListColor = ref(DEFAULT_LIST_COLOR);

const addList = () => {
  const id = store.createList({ name: newListName.value, color: newListColor.value, meta: {} });
  if (!id) return;
  store.setActiveList(id);
  newListName.value = '';
  newListColor.value = DEFAULT_LIST_COLOR;
};

const handleListNameChange = (list: { id: string; name: string }, event: Event) => {
  const target = event.target as HTMLInputElement | null;
  if (!target) return;
  const next = target.value.trim();
  if (!next) {
    target.value = list.name;
    return;
  }
  store.renameList(list.id, next);
};

const reloadApp = () => {
  if (reloading.value) return;
  reloading.value = true;
  persistKeysToStorage(localStorage, store.keys);
  writeKeysToUrl(store.keys);
  window.setTimeout(() => {
    window.location.href = window.location.href;
    window.location.reload();
  }, 50);
};
</script>
