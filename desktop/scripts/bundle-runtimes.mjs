#!/usr/bin/env node
/**
 * Bundle the StayOps runtime into desktop/.bundle/ so electron-builder can ship it
 * via extraResources (D2 / alpha.9.4 fully bundled installer).
 *
 * Layout produced (copied to <install>/resources/ by electron-builder):
 *   .bundle/python/    Python runtime + StayOps backend dependencies (site-packages)
 *   .bundle/node/      node.exe (Next standalone server runtime)
 *   .bundle/postgres/  PostgreSQL 16 binaries (bin/lib/share)
 *   .bundle/backend/   FastAPI app + alembic + desktop_backend_runner.py
 *   .bundle/scripts/   desktop runtime probes (desktop_runtime.py / dev_runtime.py / backup)
 *
 * Python strategy: network access to PyPI is blocked in this environment, so the
 * bundle is assembled from the *already verified* development runtime:
 *   - base interpreter  = `home` in backend/.venv/pyvenv.cfg
 *   - dependencies      = backend/.venv/Lib/site-packages
 * Both are copied as real files; no venv redirection is required at runtime
 * because the bundled interpreter finds Lib/site-packages next to itself.
 *
 * The script fails the build if the staged payload contains dev-machine paths,
 * secrets or database dumps (see scanForbidden()).
 *
 * Usage: node scripts/bundle-runtimes.mjs   (cwd = desktop/)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(desktopDir, "..");
const backendDir = path.join(workspace, "backend");
const venvDir = path.join(backendDir, ".venv");
const stageRoot = path.join(desktopDir, ".bundle");

const fail = (msg) => {
  console.error(`[bundle-runtimes] ERROR ${msg}`);
  process.exit(1);
};
const log = (msg) => console.log(`[bundle-runtimes] ${msg}`);

function sizeOf(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Copy with an exclusion predicate (paths are absolute, pruned before descent). */
function copyFiltered(src, dst, exclude = () => false, skipFile = () => false) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    // 物化为真实文件（绝不把 junction 打进安装包）
    const real = fs.realpathSync(src);
    if (exclude(real)) return;
    copyFiltered(real, dst, exclude, skipFile);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      if (exclude(s)) continue;
      copyFiltered(s, path.join(dst, entry), exclude, skipFile);
    }
    return;
  }
  if (skipFile(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// ---------------------------------------------------------------------------
// 1. Python runtime + backend dependencies
// ---------------------------------------------------------------------------

function basePythonHome() {
  if (process.env.STAYOPS_BASE_PYTHON) return process.env.STAYOPS_BASE_PYTHON;
  const cfg = path.join(venvDir, "pyvenv.cfg");
  if (!fs.existsSync(cfg)) fail(`missing ${cfg} (create backend/.venv first)`);
  const line = fs
    .readFileSync(cfg, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("home"));
  if (!line) fail("pyvenv.cfg has no `home` entry");
  return line.split("=")[1].trim();
}

function bundlePython() {
  const home = basePythonHome();
  if (!fs.existsSync(path.join(home, "python.exe"))) fail(`base Python not found at ${home}`);
  const sitePackages = path.join(venvDir, "Lib", "site-packages");
  if (!fs.existsSync(sitePackages)) fail(`missing ${sitePackages}`);
  const dst = path.join(stageRoot, "python");

  // 排除项：开发无关的 stdlib 组件与构建产物
  const excludeStdlib = new Set(["test", "tests", "idlelib", "tkinter", "ensurepip", "lib2to3", "turtledemo", "__pycache__"]);
  copyFiltered(home, dst, (p) => {
    const rel = path.relative(home, p);
    const top = rel.split(path.sep)[0];
    if (rel === "") return false;
    // 顶层只保留解释器与标准库
    if (!rel.includes(path.sep)) {
      return ![
        "python.exe",
        "pythonw.exe",
        "python3.dll",
        "python311.dll",
        "python312.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "DLLs",
        "Lib",
      ].includes(rel);
    }
    if (top === "DLLs") return false;
    if (top === "Lib") {
      const sub = rel.split(path.sep)[1];
      if (sub === "site-packages") return true; // venv 依赖稍后单独复制
      if (sub && excludeStdlib.has(sub)) return true;
    }
    return false;
  });
  copyFiltered(sitePackages, path.join(dst, "Lib", "site-packages"), (p) =>
    path.basename(p) === "__pycache__" || /\.(pyc|pyo)$/.test(p),
  );

  // 依赖自检：bundled 解释器必须能导入后端全部关键依赖
  const probe =
    "import fastapi, uvicorn, sqlalchemy, psycopg2, alembic, pydantic, pydantic_settings, starlette; print('ok')";
  try {
    const out = execFileSync(path.join(dst, "python.exe"), ["-c", probe], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!out.endsWith("ok")) fail(`bundled python dependency probe failed: ${out}`);
  } catch (err) {
    fail(`bundled python dependency probe failed: ${String(err)}`);
  }
  log(`python: ${mb(sizeOf(dst))} (from ${home} + venv site-packages)`);
  return dst;
}

// ---------------------------------------------------------------------------
// 2. Node runtime
// ---------------------------------------------------------------------------

function bundleNode() {
  const source = process.execPath;
  if (!/node\.exe$/i.test(source)) fail(`unexpected packaging node: ${source}`);
  const dst = path.join(stageRoot, "node");
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(source, path.join(dst, "node.exe"));
  log(`node: ${mb(sizeOf(dst))} (${source})`);
  return dst;
}

// ---------------------------------------------------------------------------
// 3. PostgreSQL runtime
// ---------------------------------------------------------------------------

function bundlePostgres() {
  const src = path.join(workspace, "runtime", "postgres", "pgsql");
  if (!fs.existsSync(path.join(src, "bin", "postgres.exe"))) {
    fail(`PostgreSQL runtime missing at ${src} (extract EDB binaries first)`);
  }
  const dst = path.join(stageRoot, "postgres", "pgsql");
  const exclude = (p) => {
    const rel = p.slice(src.length).toLowerCase();
    return (
      rel.includes(`${path.sep}pgadmin`) ||
      rel.includes("stackbuilder") ||
      rel.includes(`${path.sep}doc${path.sep}`) ||
      rel.includes(`${path.sep}include${path.sep}`) ||
      rel.endsWith(`${path.sep}include`) ||
      rel.includes(`${path.sep}symbols${path.sep}`)
    );
  };
  copyFiltered(src, dst, exclude);
  for (const exe of ["postgres.exe", "initdb.exe", "pg_ctl.exe", "psql.exe"]) {
    if (!fs.existsSync(path.join(dst, "bin", exe))) fail(`bundled postgres missing bin/${exe}`);
  }
  log(`postgres: ${mb(sizeOf(dst))}`);
  return dst;
}

// ---------------------------------------------------------------------------
// 4. Backend + runtime scripts
// ---------------------------------------------------------------------------

function bundleBackend() {
  const dst = path.join(stageRoot, "backend");
  // 白名单：只打运行必需的运行时文件（不含 tests / README / pytest.ini / cache）
  const KEEP = ["app", "alembic", "scripts", "alembic.ini", "requirements.txt"];
  const exclude = (p) => {
    if (p === backendDir) return false;
    const rel = path.relative(backendDir, p);
    const top = rel.split(path.sep)[0];
    if (!KEEP.includes(top)) return true;
    const base = path.basename(p);
    return (
      base === "__pycache__" ||
      /^\.env/.test(base) ||
      /\.(pyc|pyo|log|dump)$/.test(p)
    );
  };
  copyFiltered(backendDir, dst, exclude);
  if (!fs.existsSync(path.join(dst, "app", "main.py"))) fail("bundled backend missing app/main.py");
  if (!fs.existsSync(path.join(dst, "alembic.ini"))) fail("bundled backend missing alembic.ini");
  if (!fs.existsSync(path.join(dst, "scripts", "desktop_backend_runner.py"))) {
    fail("bundled backend missing scripts/desktop_backend_runner.py");
  }
  log(`backend: ${mb(sizeOf(dst))}`);
  return dst;
}

function bundleScripts() {
  const src = path.join(workspace, "scripts");
  const dst = path.join(stageRoot, "scripts");
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["desktop_runtime.py", "dev_runtime.py", "desktop_db_backup.py"]) {
    const from = path.join(src, name);
    if (!fs.existsSync(from)) fail(`missing runtime script ${from}`);
    fs.copyFileSync(from, path.join(dst, name));
  }
  log(`scripts: ${mb(sizeOf(dst))}`);
  return dst;
}

// ---------------------------------------------------------------------------
// 5. Security scan（安装包内不得出现开发机路径 / 秘密 / 数据库转储）
// ---------------------------------------------------------------------------

const FORBIDDEN_CONTENT = [
  { name: "dev workspace path", re: /D:\\+MY SELF/i },
  { name: "dev user profile path", re: /C:\\+Users\\+Crowtyard/i },
  { name: "dev username", re: /Crowtyard/ },
  { name: "AI_ENCRYPTION_KEY assignment", re: /AI_ENCRYPTION_KEY\s*=\s*[^\s"']/ },
  { name: "DATABASE_URL assignment", re: /DATABASE_URL\s*=\s*postgres/i },
  { name: "bundled API key", re: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: "dev admin credential", re: /Admin@123456/ },
];
const FORBIDDEN_FILES = /(^|[\\/])(\.env|\.env\..*|.*\.dump|.*\.log|cookies?\.txt|session\.json|\.git)$/i;

function scanForbidden(root) {
  const findings = [];
  const textish = /\.(py|pyi|js|mjs|cjs|json|txt|md|html|css|yml|yaml|ini|cfg|toml|ps1|cmd|bat|sh)$/i;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        findings.push(`symlink: ${full}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (FORBIDDEN_FILES.test(entry.name)) findings.push(`dir: ${full}`);
        else walk(full);
        continue;
      }
      if (FORBIDDEN_FILES.test(entry.name)) findings.push(`file: ${full}`);
      if (!textish.test(entry.name) || st.size > 4 * 1024 * 1024) continue;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const rule of FORBIDDEN_CONTENT) {
        if (rule.re.test(text)) findings.push(`${rule.name}: ${full}`);
      }
    }
  };
  walk(root);
  return findings;
}

// ---------------------------------------------------------------------------

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });

bundlePython();
bundleNode();
bundlePostgres();
bundleBackend();
bundleScripts();

const findings = scanForbidden(stageRoot);
if (findings.length > 0) {
  console.error("[bundle-runtimes] SECURITY SCAN FAILED:");
  for (const f of findings.slice(0, 40)) console.error(`  - ${f}`);
  if (findings.length > 40) console.error(`  ... and ${findings.length - 40} more`);
  fail(`${findings.length} forbidden item(s) in staged runtime`);
}
log(`security scan: clean (0 findings)`);
log(`TOTAL staged runtime: ${mb(sizeOf(stageRoot))}`);
log("done");
