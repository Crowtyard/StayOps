#!/usr/bin/env node
/**
 * Install standalone frontend into the packaged app resources.
 *
 * Why a junction for node_modules instead of copying:
 *  - Next 16 standalone trace keeps a pnpm layout: top-level entries are
 *    junctions into <workspace>/frontend/node_modules/.pnpm/<pkg>/node_modules
 *    where sibling runtime deps (e.g. @swc/helpers with its "_" helpers)
 *    live. Flattening junctions into real dirs breaks that resolution
 *    (Cannot find module '@swc/helpers/_/_interop_require_default').
 *  - electron-builder extraResources silently drops node_modules and does
 *    not follow junctions, so we do the install ourselves.
 *  - D1 runs on the machine where the StayOps workspace exists (same as
 *    backend/.venv / scripts/desktop_runtime.py), so a junction to
 *    <workspace>/frontend/node_modules is consistent with D1's contract.
 *
 * Usage: node scripts/install-standalone.mjs   (cwd = desktop/)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(desktopDir, "..");
const standalone = path.join(workspace, "frontend", ".next-desktop", "standalone");
const workspaceNodeModules = path.join(workspace, "frontend", "node_modules");

const candidates = [
  path.join(desktopDir, "dist", "win-unpacked"),
  path.join(desktopDir, "dist"),
];

function fail(msg) {
  console.error(`[install-standalone] ERROR ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(standalone, "server.js"))) {
  fail(`standalone server.js missing at ${standalone} (run build:frontend first)`);
}
if (!fs.existsSync(workspaceNodeModules)) {
  fail(`workspace frontend/node_modules missing at ${workspaceNodeModules}`);
}

const sep = path.sep;
const nodeModulesMarker = `${sep}node_modules${sep}`;

let installed = false;
for (const base of candidates) {
  const resources = path.join(base, "resources");
  const dst = path.join(resources, "frontend-server");
  if (!fs.existsSync(resources)) continue;

  // 1) 复制 standalone（排除 node_modules，保留 server.js/.next-desktop/public/package.json）
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(standalone, dst, {
    recursive: true,
    filter: (src) => !src.includes(nodeModulesMarker),
  });

  // 2) node_modules 用 junction 指向工作区 frontend/node_modules
  //    （D1 依赖本机工作区；junction 保留 pnpm 兄弟依赖解析语义）
  const dstNodeModules = path.join(dst, "node_modules");
  // filter 不保证排除 node_modules（cpSync filter 路径形态不可控），显式删除
  fs.rmSync(dstNodeModules, { recursive: true, force: true });
  fs.symlinkSync(workspaceNodeModules, dstNodeModules, "junction");
  console.log(`[install-standalone] -> ${dst}`);
  console.log(`[install-standalone] node_modules junction -> ${workspaceNodeModules}`);
  installed = true;
}
if (!installed) {
  fail("no electron-builder output dir found (run electron-builder first)");
}
console.log("[install-standalone] done");
