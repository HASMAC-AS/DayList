import { ref } from 'vue';

const message = ref('');
const visible = ref(false);
let toastTimer: number | null = null;

export function useToastBus() {
  const show = (msg: string, duration = 2400) => {
    message.value = String(msg);
    visible.value = true;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      visible.value = false;
    }, duration);
  };

  return {
    message,
    visible,
    show
  };
}
