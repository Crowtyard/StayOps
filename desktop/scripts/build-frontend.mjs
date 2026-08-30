/**
 * StayOps Desktop — 前端生产构建（Next.js standalone）。
 *
 * 职责：
 *   1. 以隔离构建目录 .next-desktop 运行 frontend 的 next build
 *      （NEXT_OUTPUT_STANDALONE=1 启用 output: standalone；不影响开发 .next）。
 *   2. 以隔离构建目录 .next-desktop 运行 frontend 的 next build
 *      （NEXT_OUTPUT_STANDALONE=1 启用 output: standalone；不影响开发 .next）。
 *      BACKEND_API_URL 由桌面主进程在 standalone 启动时注入
 *      （Next 16 服务端 Route Handler 在运行时读取该变量）。
 *   3. 装配 standalone：把 .next/static 与 public/ 复制到 standalone 输出
 *      （server.js 需要它们同目录才能提供静态资源）。
 *
 * 输出：frontend/.next-desktop/standalone（server.js + 完整运行时），
 * 由 electron-builder extraResources 打包为 resources/frontend-server/。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const DIST_DIR = path.join(FRONTEND_DIR, ".next-desktop");
const STANDALONE_DIR = path.join(DIST_DIR, "standalone");
const BACKEND_API_URL =
  process.env.DESKTOP_BACKEND_API_URL || "http://127.0.0.1:8100";

function fail(message) {
  console.error(`[build-frontend] ERROR ${message}`);
  process.exit(1);
}

// ---- 1. next build（隔离 distDir + standalone + 桌面后端地址） -------------
console.log("[build-frontend] next build (standalone) ...");
// .cmd 不能直接 spawn（EINVAL）：Windows 经 cmd.exe /c 执行（dev_runtime 同策略）
const win32 = process.platform === "win32";
const build = spawnSync(
  win32 ? "cmd.exe" : "pnpm",
  win32 ? ["/c", "pnpm", "build"] : ["build"],
  {
    cwd: FRONTEND_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-desktop",
      NEXT_OUTPUT_STANDALONE: "1",
      BACKEND_API_URL,
    },
  },
);
if (build.status !== 0) {
  fail(`next build failed (exit ${build.status ?? "signal"})`);
}

// ---- 2. 定位 standalone 内部的 distDir 镜像（含 server/ 的目录） -----------
if (!fs.existsSync(path.join(STANDALONE_DIR, "server.js"))) {
  fail(`standalone server.js missing at ${STANDALONE_DIR}`);
}
// Next standalone 中 dir = standalone 根、distDir = ./.next-desktop（相对），
// 因此镜像目录 = 含 server/ 子目录的 distDir 目录。
const distMirror = findDistMirror(STANDALONE_DIR);
if (!distMirror) {
  fail(`cannot locate distDir mirror (server/) inside ${STANDALONE_DIR}`);
}
console.log(`[build-frontend] standalone distDir mirror: ${distMirror}`);

// ---- 3. 复制 static（standalone/.next-desktop/static）与 public（standalone/public）----
const staticSrc = path.join(DIST_DIR, "static");
const staticDst = path.join(distMirror, "static");
if (fs.existsSync(staticSrc)) {
  fs.cpSync(staticSrc, staticDst, { recursive: true });
  console.log(`[build-frontend] static -> ${staticDst}`);
} else {
  fail(`static dir missing: ${staticSrc}`);
}
const publicSrc = path.join(FRONTEND_DIR, "public");
const publicDst = path.join(STANDALONE_DIR, "public");
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDst, { recursive: true });
  console.log(`[build-frontend] public -> ${publicDst}`);
}

// 注意：standalone/node_modules 保持 Next trace 原始布局（顶层 next/react/
// react-dom 是指向仓库 frontend/node_modules/.pnpm/... 的 junction）。
// 这是 pnpm 兄弟依赖解析的关键（next 依赖的 @swc/helpers 等完整版本位于
// .pnpm/<pkg>/node_modules/ 内）。曾尝试把 junction 物化为真实目录，
// 反而破坏了该解析（Cannot find module '@swc/helpers/_/_interop_require_default'），
// 已撤销。打包侧由 scripts/install-standalone.mjs 用 junction 指向工作区
// frontend/node_modules（D1 依赖本机工作区，与 backend/.venv 同理）。

// ---- 4. 汇总 ---------------------------------------------------------------
console.log(
  JSON.stringify(
    {
      ok: true,
      standaloneDir: STANDALONE_DIR,
      serverJs: path.join(STANDALONE_DIR, "server.js"),
      distMirror,
      backendApiUrl: BACKEND_API_URL,
    },
    null,
    2,
  ),
);

function findDistMirror(standalone) {
  const candidates = [standalone];
  for (let depth = 0; depth < 4 && candidates.length > 0; depth++) {
    const current = candidates.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (fs.existsSync(path.join(full, "server"))) {
        return full;
      }
      candidates.push(full);
    }
  }
  return null;
}
