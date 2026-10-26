import { createApp } from 'vue';
import App from './App.vue';
// themes.css 必须先于 styles.css 引入：前者只定义变量，后者消费变量
import './themes.css';
import './styles.css';

createApp(App).mount('#app');
