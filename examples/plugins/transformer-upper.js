/**
 * transformer-upper.js — 库犀 L3 插件示例：大写转换
 *
 * 用法：把本文件复制到 userData/plugins/ 目录，然后在应用顶栏
 * 「插件管理」（齿轮图标）里点「重新加载」，数据管线节点下拉
 * 就会出现「大写转换（示例）」。
 *
 * 插件约定（CJS，一层目录，*.js）：
 * - 必须导出 { manifest, mount }
 * - manifest.id 全局唯一（建议 `user.名字`），重复会被跳过并报错
 * - mount(ctx) 的返回值就是能力对象；transformer 的能力形状为
 *   { label, fields?, apply(rows, options) }
 *   apply 必须同步返回行数组（引擎按序重放）
 */
module.exports = {
  manifest: {
    id: 'user.upper',
    name: '大写转换（示例）',
    type: 'transformer',
    version: '1.0.0',
    description: '把所有字符串单元格转成大写，演示 L3 插件如何自定义管线节点',
  },
  mount() {
    return {
      label: '大写转换（示例）',
      fields: [
        {
          key: 'columns',
          label: '限定列（留空 = 全部列）',
          type: 'multiselect',
          optionsFrom: 'columns',
        },
      ],
      apply(rows, options) {
        const limit =
          Array.isArray(options?.columns) && options.columns.length
            ? new Set(options.columns)
            : null;
        return rows.map((row) => {
          const next = { ...row };
          for (const key of Object.keys(next)) {
            if (limit && !limit.has(key)) continue;
            const v = next[key];
            if (typeof v === 'string') next[key] = v.toUpperCase();
          }
          return next;
        });
      },
    };
  },
};
