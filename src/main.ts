import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import '@vueform/multiselect/themes/default.css';
import './styles/app.css';
import { registerPwa } from './services/pwa';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

registerPwa();
