const resolve = require("@rollup/plugin-node-resolve").default;
const commonjs = require("@rollup/plugin-commonjs");

module.exports = {
  input: "src/index.js",
  external: [
    "@turf/turf",
  ],
  plugins: [
    // 自动查找并绑定第三方模块, 默认会查找 node_modules 中的模块
    resolve(),
    commonjs({
      include: /node_modules/,
      // requireReturnsDefault: "preferred"：当模块同时使用 module.exports 和 export default 时，优先使用 export default
      requireReturnsDefault: "preferred"
    }),
    // 允许直接导入 JSON 文件，如 import data from './data.json'
  ],
  output: {
    file: "dist/mapbox_gl_draw_split_polygon_mode.js", // 修改输出文件名
    format: "umd",
    exports: "named", //表示使用命名导出方式
    name: "SplitPolygonMode", //做全局变量
    sourcemap: true, // 始终生成源映射文件
  }
};