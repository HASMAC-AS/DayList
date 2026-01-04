<template>
  <div id="toastHost" class="toast" :class="{ show: visible }" aria-live="polite">
    {{ message }}
  </div>
</template>

<script setup lang="ts">
import { useToastBus } from '../services/toast';

const { message, visible } = useToastBus();
</script>
