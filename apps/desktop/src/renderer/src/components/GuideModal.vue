<script setup lang="ts">
/**
 * GuideModal — 新手引导
 *
 * 首次启动自动弹出一次（App 用 localStorage 记录），之后可从顶栏「?」重开。
 * 只讲 4 条最短路径 + 快捷键，不堆功能清单，降低第一次使用的认知负担。
 */
import BaseIcon from './BaseIcon.vue';

defineProps<{ open: boolean; version?: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'check'): void }>();

const steps = [
  {
    icon: 'database' as const,
    title: '先连一个数据库',
    text: '左侧「＋ 新建连接」填写地址即可；连上后双击表名打开数据网格。',
  },
  {
    icon: 'sparkles' as const,
    title: '不会 SQL 就用中文问',
    text: '顶栏「AI」输入想查什么，生成 SQL 后先看再执行，还可以继续追问。',
  },
  {
    icon: 'filter' as const,
    title: '或者用构建器 / 模板',
    text: '「构建」勾字段、加筛选自动生成 SQL；「模板」提供常用查询与清洗语句。',
  },
  {
    icon: 'edit' as const,
    title: '改数据有护栏',
    text: '双击单元格（触屏长按）直接改；危险语句执行前会二次确认。',
  },
];

const shortcuts = [
  { keys: '⌘ / Ctrl + Enter', text: '执行 SQL' },
  { keys: '双击表名', text: '打开数据网格' },
  { keys: '双击单元格 / Enter', text: '编辑单元格（触屏长按）' },
  { keys: 'Esc', text: '关闭弹窗 / 抽屉' },
];
</script>

<template>
  <div class="guide">
    <p class="guide-lead">
      库犀把「连库、查询、改数据、用 AI」放在一个窗口里。按下面 4 步走一遍，基本就会用了。
    </p>

    <div class="guide-steps">
      <div v-for="step in steps" :key="step.title" class="guide-step">
        <span class="guide-step-icon" aria-hidden="true">
          <BaseIcon :name="step.icon" :size="18" />
        </span>
        <div>
          <strong>{{ step.title }}</strong>
          <p>{{ step.text }}</p>
        </div>
      </div>
    </div>

    <div class="guide-keys">
      <strong>常用快捷键</strong>
      <dl>
        <template v-for="item in shortcuts" :key="item.keys">
          <dt><kbd>{{ item.keys }}</kbd></dt>
          <dd>{{ item.text }}</dd>
        </template>
      </dl>
    </div>

    <p class="guide-privacy">
      隐私：AI 只发送表结构、问题文本与历史 SQL，不会发送任何数据行。
    </p>

    <div class="guide-foot">
      <div class="guide-version">
        <span v-if="version">v{{ version }}</span>
        <button class="guide-check" type="button" @click="emit('check')">检查更新</button>
      </div>
      <button class="primary" type="button" @click="emit('close')">开始使用</button>
    </div>
  </div>
</template>
