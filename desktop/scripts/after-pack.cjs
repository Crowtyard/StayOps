// electron-builder afterPack hook：打包完成（win-unpacked 生成）后、
// portable 压缩前，安装 standalone 前端资源（node_modules 用 junction）。
// 这样 dir 与 portable 两个目标都自动携带 resources/frontend-server。
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack() {
  const script = path.join(__dirname, "install-standalone.mjs");
  const res = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`install-standalone failed (exit ${res.status})`);
  }
};
