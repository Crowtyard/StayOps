#!/usr/bin/env node
/**
 * Install the Next standalone frontend into the packaged app resources as a
 * **self-contained** tree (D2 / alpha.9.4 installer).
 *
 * Why this is not a junction anymore:
 *  - D1 pointed resources/frontend-server/node_modules at
 *    <workspace>/frontend/node_modules (junction). On another machine that path
 *    does not exist, so the installed app could not start.
 *  - Next's standalone trace keeps a pnpm layout: entries are junctions into
 *    .pnpm/<pkg>@<ver>/node_modules/<pkg>, and packages link to sibling runtime
 *    deps (e.g. @swc/helpers). Flattening *without* materializing nested links
 *    breaks resolution ("Cannot find module '@swc/helpers/_/_interop_require_default'").
 *    So we copy recursively, resolving every junction to real files, with a
 *    cycle guard for pnpm's sibling link cycles.
 *
 * Also applied here (D2 security / payload):
 *  - *.map source maps are excluded (not needed at runtime).
 *  - dev-machine absolute paths embedded by Next (outputFileTracingRoot,
 *    repoRoot, turbopack.root, appDir) are rewritten to a neutral runtime value.
 *
 * Usage: node scripts/install-standalone.mjs   (cwd = desktop/)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(desktopDir, "..");
const standalone = path.join(workspace, "frontend", ".next-desktop", "standalone");

const candidates = [
  path.join(desktopDir, "dist", "win-unpacked"),
  path.join(desktopDir, "dist"),
];

const SKIP_FILE = /\.map$/;
const TEXT_FILE = /\.(js|mjs|cjs|json|txt|html|css)$/i;

let copiedFiles = 0;
let cycleSkips = 0;

function fail(msg) {
  console.error(`[install-standalone] ERROR ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[install-standalone] ${msg}`);
}

/** Recursively copy src → dst, materializing junctions/symlinks as real files. */
function copyTree(src, dst, stack) {
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    return;
  }

  if (st.isSymbolicLink()) {
    let real;
    try {
      real = fs.realpathSync(src);
    } catch {
      return; // 断链（不应出现在 standalone 中）
    }
    if (stack.includes(real)) {
      cycleSkips += 1; // pnpm 兄弟依赖环：已在上层物化，跳过即可
      return;
    }
    copyTree(real, dst, [...stack, real]);
    return;
  }

  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (SKIP_FILE.test(entry)) continue;
      copyTree(path.join(src, entry), path.join(dst, entry), stack);
    }
    return;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copiedFiles += 1;
}

/** 递归收集目录内所有 reparse point（必须为 0，否则安装版依赖开发机）。 */
function findLinks(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) out.push(full);
    else if (entry.isDirectory()) findLinks(full, out);
  }
  return out;
}

/** 重写 Next 内嵌的开发机绝对路径（构建根 → 运行时中立值）。 */
function sanitizeDevPaths(dir) {
  const buildRoots = [
    path.join(workspace, "frontend"),
    workspace,
    desktopDir,
  ].sort((a, b) => b.length - a.length);

  let changed = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!TEXT_FILE.test(entry.name)) continue;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const original = text;
      for (const root of buildRoots) {
        const variants = [
          root,
          root.replaceAll("\\", "/"),
          root.replaceAll("\\", "\\\\"),
        ];
        for (const variant of variants) {
          if (variant && text.includes(variant)) {
            // 中性值：standalone 运行时以 __dirname 为根，这些字段仅作元数据
            text = text.split(variant).join("<stayops-build-root>");
          }
        }
      }
      if (text !== original) {
        fs.writeFileSync(full, text, "utf8");
        changed += 1;
      }
    }
  };
  walk(dir);
  return changed;
}

/**
 * Hoist every virtual-store package to the top level.
 *
 * Why: in pnpm, `node_modules/<pkg>` is a *symlink* into
 * `.pnpm/<pkg>@<ver>/node_modules/<pkg>`, so Node resolves the real path and
 * finds sibling deps at `.pnpm/<pkg>@<ver>/node_modules/<dep>`. Once we
 * materialize those symlinks as real directories, `next` is a plain dir under
 * `node_modules/` and Node's ancestor lookup only sees `node_modules/` — so
 * `@swc/helpers/_/_interop_require_default` is NOT found (实测 MODULE_NOT_FOUND).
 *
 * Fix: additionally materialize every package that lives in the virtual store
 * (`.pnpm/node_modules/*` and `.pnpm/<pkg>/node_modules/*`) at the top level,
 * so all runtime deps are reachable from any depth by ordinary ancestor lookup.
 */
function hoistPackages(dstNodeModules) {
  const pnpmDir = path.join(dstNodeModules, ".pnpm");
  if (!fs.existsSync(pnpmDir)) return 0;
  let hoisted = 0;

  const copyIfMissing = (srcDir, name) => {
    const target = path.join(dstNodeModules, name);
    if (fs.existsSync(target)) return;
    let real;
    try {
      real = fs.realpathSync(srcDir);
    } catch {
      return;
    }
    copyTree(srcDir, target, [real]);
    hoisted += 1;
  };

  const hoistFrom = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const src = path.join(dir, entry);
      if (!fs.statSync(src).isDirectory()) continue;
      if (entry.startsWith("@")) {
        for (const inner of fs.readdirSync(src)) {
          copyIfMissing(path.join(src, inner), path.join(entry, inner));
        }
      } else {
        copyIfMissing(src, entry);
      }
    }
  };

  // 1) hoisted virtual store：.pnpm/node_modules/*
  hoistFrom(path.join(pnpmDir, "node_modules"));
  // 2) 每个包的兄弟依赖：.pnpm/<pkg>/node_modules/*
  for (const pkgDir of fs.readdirSync(pnpmDir)) {
    if (pkgDir === "node_modules") continue;
    hoistFrom(path.join(pnpmDir, pkgDir, "node_modules"));
  }
  return hoisted;
}

if (!fs.existsSync(path.join(standalone, "server.js"))) {
  fail(`standalone server.js missing at ${standalone} (run build:frontend first)`);
}

let installed = false;
for (const base of candidates) {
  const resources = path.join(base, "resources");
  const dst = path.join(resources, "frontend-server");
  if (!fs.existsSync(resources)) continue;

  fs.rmSync(dst, { recursive: true, force: true });
  copiedFiles = 0;
  cycleSkips = 0;
  copyTree(standalone, dst, [fs.realpathSync(standalone)]);
  const hoisted = hoistPackages(path.join(dst, "node_modules"));

  const links = findLinks(dst);
  if (links.length > 0) {
    fail(`materialized tree still contains ${links.length} link(s), e.g. ${links[0]}`);
  }
  const sanitized = sanitizeDevPaths(dst);

  log(`-> ${dst}`);
  log(
    `files copied=${copiedFiles} hoisted=${hoisted} cycleSkips=${cycleSkips} sanitized=${sanitized}`,
  );
  installed = true;
}
if (!installed) {
  fail("no electron-builder output dir found (run electron-builder first)");
}
log("done");
