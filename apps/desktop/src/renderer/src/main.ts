import { createApp } from 'vue';
import App from './App.vue';
// themes.css 必须先于 styles.css 引入：前者只定义变量，后者消费变量
import './themes.css';
import './styles.css';

const app = createApp(App);

// 全局错误钩子：渲染/钩子里的未捕获异常若静默吞掉，会让 vnode 树与真实 DOM
// 永久错位（表现为白屏、布局塌陷、状态文案冻结），必须大声打出来
app.config.errorHandler = (err, _instance, info) => {
  console.error(`[kuxi] 渲染错误（${info}）:`, err);
};

app.mount('#app');
