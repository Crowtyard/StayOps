/**
 * PostgreSQL runtime resolver（alpha.9.6 Windows runtime compatibility hotfix）。
 *
 * 背景（真实复现的缺陷）：Packaged Mode 之前直接从 `process.resourcesPath\postgres\pgsql\bin`
 * 执行 PostgreSQL CLI。当安装路径含中文/非 ASCII 字符时（例如
 * `D:\安客酒店试用软件\StayOps\resources`），`initdb` 在 `performing post-bootstrap
 * initialization` 阶段失败：
 *
 *     FATAL: invalid byte sequence for encoding "UTF8": 0xb0
 *
 * 修复原则（详见 docs/DECISIONS.md）：
 * - Packaged Mode：首次把 bundled PostgreSQL runtime **materialize** 到固定
 *   ASCII-safe 路径 `%PROGRAMDATA%\StayOps\runtime\postgresql\<version>\pgsql`，
 *   之后所有 PG CLI（initdb / pg_ctl / pg_isready / psql / pg_dump / pg_restore）
 *   统一从该路径执行。
 * - Development Mode：行为完全不变（继续使用工作区 `runtime/postgres/pgsql/bin`）。
 * - **不使用 8.3 short path**、不修改 SQL_ASCII、不降低 UTF8 要求、
 *   不要求用户只能安装到英文目录。
 *
 * Materialization 安全要求（逐条可测）：
 * 1. versioned runtime directory（`…/postgresql/16.15/pgsql`）
 * 2. staging directory（`…/<version>/.staging-<pid>-<rand>/pgsql`）
 * 3. copy 完整后验证关键 binary / 资源
 * 4. atomic promote（`fs.renameSync`，同一卷内）
 * 5. 幂等（同版本完整 runtime 直接复用）
 * 6. 已存在完整同版本 runtime 时复用
 * 7. 半复制状态**绝不**被当成成功 runtime（完整性标记 + 关键文件校验）
 * 8. 不触碰 PostgreSQL data directory
 * 9. 不删除已有业务数据库
 * 10. materialize 失败 → Fail Safe（报可读错误，不静默回退到非 ASCII 路径执行）
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeMode } from "./config";

/** Materialized / bundled runtime 的完整性标记文件名。 */
export const PG_RUNTIME_MARKER = ".stayops-runtime.json";

/** staged runtime 目录名前缀（崩溃残留只会是这两种，均可安全清理）。 */
export const PG_STAGING_PREFIX = ".staging-";
export const PG_BROKEN_PREFIX = ".broken-";

/**
 * 执行前必须存在的 PG 工具（产品实际使用面）：
 * - initdb / pg_ctl / pg_isready / psql：首次初始化 + 启动 + 就绪探测 + 建库
 * - postgres：服务端本体
 * - pg_dump / pg_restore：`scripts/desktop_db_backup.py` 备份/恢复
 */
export const PG_REQUIRED_BINARIES: readonly string[] = [
  "postgres.exe",
  "initdb.exe",
  "pg_ctl.exe",
  "pg_isready.exe",
  "psql.exe",
  "pg_dump.exe",
  "pg_restore.exe",
];

/**
 * initdb / postgres 运行所需的非 bin 资源（半复制最典型的缺失点）。
 * 缺 share 会导致 initdb 找不到 bootstrap 模板；缺 lib 会导致 DLL 加载失败
 * （`lib/` 单独由 PG_REQUIRED_LIB_DLL 校验，见 appendLibChecks）。
 */
export const PG_REQUIRED_RESOURCES: readonly string[] = [
  path.join("share", "postgres.bki"),
  path.join("share", "postgresql.conf.sample"),
  path.join("share", "timezone"),
];

/**
 * `lib/` 完整性要求（alpha.9.6 QA-9.6-H1 修复）：
 * 目录存在 + 非空 + 关键 DLL 存在。
 *
 * 关键 DLL 的选择依据**真实 bundled runtime 结构**（EDB PostgreSQL 16.15 Windows，
 * 与 `runtime/postgres/pgsql`、`desktop/.bundle/postgres/pgsql` 及安装包内
 * `resources/postgres/pgsql` 三处一致核对）：
 *   - `lib/`：145 个文件 / 120 个 DLL
 *   - `lib/libpq.dll` 存在（psql / pg_dump / pg_restore 依赖的客户端库）
 *   - 注意 `libcrypto-3-x64.dll` / `libssl-3-x64.dll` 位于 **bin/**，不在 lib/，
 *     因此不作为 lib 校验项（不得凭想象写文件名）
 */
export const PG_REQUIRED_LIB_DIR = "lib";
export const PG_REQUIRED_LIB_DLL = "libpq.dll";

/** `lib/` 存在 + 非空 + 关键 DLL 存在（bin 与 lib 两套校验共用）。 */
function appendLibChecks(pgDir: string, missing: string[]): void {
  const libDir = path.join(pgDir, PG_REQUIRED_LIB_DIR);
  if (!existsNonEmpty(libDir)) {
    missing.push(PG_REQUIRED_LIB_DIR);
  }
  if (!isNonEmptyFile(path.join(libDir, PG_REQUIRED_LIB_DLL))) {
    missing.push(path.join(PG_REQUIRED_LIB_DIR, PG_REQUIRED_LIB_DLL));
  }
}

export interface PgRuntimeMarker {
  schema?: number;
  /** PostgreSQL 版本（如 "16.15"） */
  version?: string;
  files?: number;
  bytes?: number;
  createdAt?: string;
  materializedAt?: string;
}

export type PgRuntimeAction = "development" | "reused" | "materialized";

export interface PgRuntimeSuccess {
  ok: true;
  action: PgRuntimeAction;
  /** 实际执行 PG CLI 的 bin 目录（ASCII-safe；development 模式为工作区 bin） */
  binDir: string;
  /** runtime 根（packaged = `…/postgresql/<version>/pgsql`；development = bundled 源目录） */
  runtimeDir: string;
  version: string | null;
  materialized: boolean;
}

export interface PgRuntimeFailure {
  ok: false;
  error: string;
  detail?: string;
}

export type PgRuntimeOutcome = PgRuntimeSuccess | PgRuntimeFailure;

export interface EnsurePgRuntimeOptions {
  mode: RuntimeMode;
  /** bundled PostgreSQL runtime 源目录（packaged: `<resources>/postgres/pgsql`） */
  bundledPgDir: string;
  /** development 模式下执行 PG CLI 的 bin 目录（保持 D1 行为不变） */
  devBinDir: string;
  /** materialize 目标根：`%PROGRAMDATA%\StayOps\runtime\postgresql` */
  runtimeRootDir: string;
  /** 版本探测（默认执行 `<bundled>/bin/postgres.exe --version`；测试可注入） */
  probeVersion?: (postgresExe: string) => string | null;
  /** 测试注入：固定 pid / 随机后缀 / 时间戳 */
  pid?: number;
  randomSuffix?: () => string;
  now?: () => Date;
}

/** ASCII-safe 路径判定：只允许可打印 ASCII（materialize 目标路径必须满足）。 */
export function isAsciiSafePath(value: string): boolean {
  return value.length > 0 && /^[\x20-\x7E]+$/.test(value);
}

export function readMarker(dir: string): PgRuntimeMarker | null {
  try {
    const raw = fs.readFileSync(path.join(dir, PG_RUNTIME_MARKER), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PgRuntimeMarker;
    return null;
  } catch {
    return null;
  }
}

export function writeMarker(dir: string, marker: PgRuntimeMarker): void {
  const payload = { schema: 1, ...marker };
  fs.writeFileSync(
    path.join(dir, PG_RUNTIME_MARKER),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/** 从 `postgres (PostgreSQL) 16.15` 之类的输出里取版本号。 */
export function parsePgVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return match[3] ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`;
}

function defaultProbeVersion(postgresExe: string): string | null {
  try {
    const out = execFileSync(postgresExe, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    return parsePgVersion(out.trim());
  } catch {
    return null;
  }
}

/**
 * 探测 bundled PostgreSQL 版本：先读 build 期写入的 marker，
 * 再退回 `postgres.exe --version`（两者都失败 → null → Fail Safe）。
 */
export function detectBundledPgVersion(
  bundledPgDir: string,
  probe: (exe: string) => string | null = defaultProbeVersion,
): string | null {
  const marker = readMarker(bundledPgDir);
  if (marker?.version && /^\d+\.\d+(\.\d+)?$/.test(marker.version)) {
    return marker.version;
  }
  return probe(path.join(bundledPgDir, "bin", "postgres.exe"));
}

export interface RuntimeCompleteness {
  ok: boolean;
  missing: string[];
}

/**
 * 完整性校验：**必须同时**满足
 * - 存在完整性标记（materialize/build 期最后写入 → 半复制不可能有）
 * - 标记版本与期望版本一致
 * - 关键 binary（bin/）与非 bin 资源（share/）存在（非空文件）
 * - `lib/` 目录存在 + 非空 + 关键 DLL 存在（QA-9.6-H1）
 */
export function verifyRuntimeComplete(
  pgDir: string,
  expectedVersion: string | null,
): RuntimeCompleteness {
  const missing: string[] = [];
  const marker = readMarker(pgDir);
  if (!marker) {
    missing.push(PG_RUNTIME_MARKER);
  } else if (expectedVersion && marker.version && marker.version !== expectedVersion) {
    missing.push(`${PG_RUNTIME_MARKER}(version=${marker.version}≠${expectedVersion})`);
  }
  for (const exe of PG_REQUIRED_BINARIES) {
    const file = path.join(pgDir, "bin", exe);
    if (!isNonEmptyFile(file)) missing.push(path.join("bin", exe));
  }
  for (const rel of PG_REQUIRED_RESOURCES) {
    if (!existsNonEmpty(path.join(pgDir, rel))) missing.push(rel);
  }
  appendLibChecks(pgDir, missing);
  return { ok: missing.length === 0, missing };
}

function isNonEmptyFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function existsNonEmpty(target: string): boolean {
  try {
    const st = fs.statSync(target);
    if (st.isFile()) return st.size > 0;
    if (st.isDirectory()) return fs.readdirSync(target).length > 0;
    return false;
  } catch {
    return false;
  }
}

interface CopyStats {
  files: number;
  bytes: number;
}

/** 递归复制真实文件（符号链接按目标物化，绝不把 junction 带进 runtime）。 */
function copyTree(src: string, dst: string, stats: CopyStats): void {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    copyTree(fs.realpathSync(src), dst, stats);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dst, entry), stats);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  stats.files += 1;
  stats.bytes += st.size;
}

function removeBestEffort(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // 清理失败不影响主流程（staging/broken 目录不影响正确性，只占空间）
  }
}

/** 清掉本版本目录下崩溃残留的 `.staging-*`（半复制 staging 永远不是有效 runtime）。 */
function cleanStaleStaging(versionDir: string, keep: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(versionDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PG_STAGING_PREFIX)) continue;
    const full = path.join(versionDir, entry);
    if (full === keep) continue;
    removeBestEffort(full);
  }
}

/**
 * 解析（必要时 materialize）打包模式下的 PostgreSQL runtime。
 *
 * Development Mode：直接返回工作区 bin（零副作用，与 alpha.9.4 行为一致）。
 * Packaged Mode：materialize 到 ASCII-safe 版本化路径；失败 → Fail Safe。
 */
export function ensurePgRuntime(opts: EnsurePgRuntimeOptions): PgRuntimeOutcome {
  if (opts.mode !== "packaged") {
    return {
      ok: true,
      action: "development",
      binDir: opts.devBinDir,
      runtimeDir: opts.bundledPgDir,
      version: null,
      materialized: false,
    };
  }

  const sourcePostgres = path.join(opts.bundledPgDir, "bin", "postgres.exe");
  if (!isNonEmptyFile(sourcePostgres)) {
    return {
      ok: false,
      error: "安装不完整：缺少 bundled PostgreSQL 运行时",
      detail: `未找到 ${sourcePostgres}。请重新安装 StayOps。`,
    };
  }

  const version = detectBundledPgVersion(opts.bundledPgDir, opts.probeVersion);
  if (!version) {
    return {
      ok: false,
      error: "无法识别 bundled PostgreSQL 版本",
      detail:
        `未能从 ${opts.bundledPgDir} 读取版本（缺少 ${PG_RUNTIME_MARKER} 且 ` +
        `postgres.exe --version 不可用）。为避免版本不确定的 runtime 混用，StayOps 已停止启动。`,
    };
  }

  const versionDir = path.join(opts.runtimeRootDir, version);
  const target = path.join(versionDir, "pgsql");

  // materialize 目标必须是 ASCII-safe 路径，否则修复无效 → Fail Safe（绝不静默继续）
  if (!isAsciiSafePath(target)) {
    return {
      ok: false,
      error: "无法建立 ASCII-safe 的 PostgreSQL 运行路径",
      detail:
        `materialize 目标 ${target} 含非 ASCII 字符（检查 %PROGRAMDATA%）。` +
        "请将 StayOps 数据目录置于 ASCII 路径后重试。",
    };
  }

  const complete = verifyRuntimeComplete(target, version);
  if (complete.ok) {
    return {
      ok: true,
      action: "reused",
      binDir: path.join(target, "bin"),
      runtimeDir: target,
      version,
      materialized: false,
    };
  }

  const pid = opts.pid ?? process.pid;
  const rand = (opts.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10)))();
  const stagingParent = path.join(versionDir, `${PG_STAGING_PREFIX}${pid}-${rand}`);
  const staging = path.join(stagingParent, "pgsql");
  const now = (opts.now ?? (() => new Date()))();

  try {
    fs.mkdirSync(versionDir, { recursive: true });
    cleanStaleStaging(versionDir, stagingParent);
    removeBestEffort(stagingParent);
    fs.mkdirSync(stagingParent, { recursive: true });

    const stats: CopyStats = { files: 0, bytes: 0 };
    copyTree(opts.bundledPgDir, staging, stats);

    // 先校验再写标记：标记只会在完整复制 + 校验通过后出现
    const staged = verifyRuntimeMarked(staging, version);
    if (!staged.ok) {
      removeBestEffort(stagingParent);
      return {
        ok: false,
        error: "PostgreSQL runtime 复制不完整",
        detail: `缺少：${staged.missing.slice(0, 8).join("、")}。已放弃本次 materialize（Fail Safe）。`,
      };
    }
    writeMarker(staging, {
      version,
      files: stats.files,
      bytes: stats.bytes,
      materializedAt: now.toISOString(),
    });

    // 半复制/损坏的既有 target：先隔离再原子 promote（绝不原地覆盖）
    if (fs.existsSync(target)) {
      removeBestEffort(path.join(versionDir, `${PG_BROKEN_PREFIX}${Date.now()}`));
      try {
        fs.renameSync(target, path.join(versionDir, `${PG_BROKEN_PREFIX}${Date.now()}`));
      } catch {
        removeBestEffort(target);
      }
    }
    fs.renameSync(staging, target);
    removeBestEffort(stagingParent);
  } catch (err) {
    removeBestEffort(stagingParent);
    return {
      ok: false,
      error: "PostgreSQL runtime 复制失败",
      detail: `${err instanceof Error ? err.message : String(err)}（目标：${target}）`,
    };
  }

  const promoted = verifyRuntimeComplete(target, version);
  if (!promoted.ok) {
    return {
      ok: false,
      error: "PostgreSQL runtime 校验失败",
      detail: `缺少：${promoted.missing.slice(0, 8).join("、")}（目标：${target}）`,
    };
  }

  removeBrokenRuntimes(versionDir);
  return {
    ok: true,
    action: "materialized",
    binDir: path.join(target, "bin"),
    runtimeDir: target,
    version,
    materialized: true,
  };
}

/** 复制阶段校验（与复用校验同规则，但不要求 marker —— marker 此刻还没写）。 */
function verifyRuntimeMarked(pgDir: string, version: string): RuntimeCompleteness {
  const missing: string[] = [];
  for (const exe of PG_REQUIRED_BINARIES) {
    const file = path.join(pgDir, "bin", exe);
    if (!isNonEmptyFile(file)) missing.push(path.join("bin", exe));
  }
  for (const rel of PG_REQUIRED_RESOURCES) {
    if (!existsNonEmpty(path.join(pgDir, rel))) missing.push(rel);
  }
  appendLibChecks(pgDir, missing);
  const markerVersion = readMarker(pgDir)?.version;
  if (markerVersion && markerVersion !== version) {
    missing.push(`${PG_RUNTIME_MARKER}(version=${markerVersion}≠${version})`);
  }
  return { ok: missing.length === 0, missing };
}

function removeBrokenRuntimes(versionDir: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(versionDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(PG_BROKEN_PREFIX)) removeBestEffort(path.join(versionDir, entry));
  }
}
